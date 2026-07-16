import { lstat, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { invariant, readJson, safeRepoPath } from "./lib.mjs";

export const HARD_PROTECTED_PATHS = Object.freeze([
  ".github/workflows/**",
  ".github/actions/**",
  ".ai-factory/**",
  "AGENTS.md",
  "**/AGENTS.md",
  ".gitmodules",
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*credential*",
  "**/*secret*",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
]);

const DEFAULT_LIMITS = Object.freeze({
  max_changed_files: 200,
  max_patch_bytes: 8 * 1024 * 1024,
  max_context_bytes: 2 * 1024 * 1024,
  max_review_batch_bytes: 120_000,
  max_repair_cycles: 3,
});

const DEFAULT_REVIEW = Object.freeze({
  model: "glm-5.2",
  blocking_severities: ["P0", "P1", "P2"],
});

const DEFAULT_IMPLEMENTATION = Object.freeze({
  model: "gpt-5.6",
  reasoning_effort: "high",
});

function exactKeys(object, allowed, name) {
  invariant(object && typeof object === "object" && !Array.isArray(object), "INVALID_CONFIG", `${name} must be an object`);
  const extras = Object.keys(object).filter((key) => !allowed.includes(key));
  invariant(extras.length === 0, "INVALID_CONFIG", `${name} contains unsupported keys: ${extras.join(", ")}`);
}

function stringArray(value, name, { min = 0, max = 100, pattern } = {}) {
  invariant(Array.isArray(value) && value.length >= min && value.length <= max, "INVALID_CONFIG", `${name} must contain ${min}-${max} items`);
  value.forEach((item, index) => {
    invariant(typeof item === "string" && item.length > 0 && item.length <= 2000, "INVALID_CONFIG", `${name}[${index}] must be a non-empty string`);
    invariant(!/REPLACE_|CHANGEME|TODO_CONFIGURE/i.test(item), "INVALID_CONFIG", `${name}[${index}] still contains an installation placeholder`);
    if (pattern) invariant(pattern.test(item), "INVALID_CONFIG", `${name}[${index}] has an invalid value`);
  });
  return [...value];
}

function integer(value, name, min, max) {
  invariant(Number.isInteger(value) && value >= min && value <= max, "INVALID_CONFIG", `${name} must be an integer between ${min} and ${max}`);
  return value;
}

export function validateConfig(raw) {
  exactKeys(raw, ["schema_version", "project_id", "default_branch", "ci_workflow", "setup_commands", "verification_commands", "context_files", "allowed_actors", "branch_prefix", "protected_paths", "limits", "implementation", "review"], "configuration");
  invariant(raw.schema_version === 1, "INVALID_CONFIG", "schema_version must equal 1");
  invariant(typeof raw.project_id === "string" && /^[a-z0-9][a-z0-9-]{1,62}$/.test(raw.project_id), "INVALID_CONFIG", "project_id must be a 2-63 character lowercase slug");
  invariant(typeof raw.default_branch === "string" && /^(?!\/)(?!.*\.\.)(?!.*[~^:?*\[\\])[A-Za-z0-9._/-]{1,128}$/.test(raw.default_branch), "INVALID_CONFIG", "default_branch is not a safe Git ref name");
  invariant(typeof raw.ci_workflow === "string" && /^[A-Za-z0-9._-]+\.ya?ml$/.test(raw.ci_workflow), "INVALID_CONFIG", "ci_workflow must be a workflow filename, not a path");

  const setupCommands = stringArray(raw.setup_commands, "setup_commands", { min: 1, max: 20 });
  const verificationCommands = stringArray(raw.verification_commands, "verification_commands", { min: 1, max: 30 });
  const allowedActors = stringArray(raw.allowed_actors, "allowed_actors", { min: 1, max: 20, pattern: /^[A-Za-z0-9-]{1,39}$/ });
  invariant(new Set(allowedActors.map((actor) => actor.toLowerCase())).size === allowedActors.length, "INVALID_CONFIG", "allowed_actors contains duplicates");

  const contextFiles = stringArray(raw.context_files ?? [], "context_files", { max: 30 });
  const protectedPaths = stringArray(raw.protected_paths ?? [], "protected_paths", { max: 100 });
  for (const path of [...contextFiles, ...protectedPaths]) {
    invariant(!path.startsWith("/") && !path.includes("\\") && !path.split("/").includes("..") && !path.includes("\0") && !/[\r\n]/.test(path), "INVALID_CONFIG", `Unsafe repository path pattern: ${path}`);
  }

  const branchPrefix = raw.branch_prefix ?? "ai-factory/";
  invariant(typeof branchPrefix === "string" && /^(?!\/)(?!.*\.\.)(?!.*[~^:?*\[\\])[A-Za-z0-9._/-]{1,80}$/.test(branchPrefix), "INVALID_CONFIG", "branch_prefix is not safe");
  invariant(branchPrefix.endsWith("/"), "INVALID_CONFIG", "branch_prefix must end with /");

  const rawLimits = raw.limits ?? {};
  exactKeys(rawLimits, Object.keys(DEFAULT_LIMITS), "limits");
  const limits = {
    max_changed_files: integer(rawLimits.max_changed_files ?? DEFAULT_LIMITS.max_changed_files, "limits.max_changed_files", 1, 1000),
    max_patch_bytes: integer(rawLimits.max_patch_bytes ?? DEFAULT_LIMITS.max_patch_bytes, "limits.max_patch_bytes", 1024, 50 * 1024 * 1024),
    max_context_bytes: integer(rawLimits.max_context_bytes ?? DEFAULT_LIMITS.max_context_bytes, "limits.max_context_bytes", 1024, 10 * 1024 * 1024),
    max_review_batch_bytes: integer(rawLimits.max_review_batch_bytes ?? DEFAULT_LIMITS.max_review_batch_bytes, "limits.max_review_batch_bytes", 4096, 500_000),
    max_repair_cycles: integer(rawLimits.max_repair_cycles ?? DEFAULT_LIMITS.max_repair_cycles, "limits.max_repair_cycles", 0, 5),
  };

  const rawReview = raw.review ?? {};
  exactKeys(rawReview, Object.keys(DEFAULT_REVIEW), "review");
  const model = rawReview.model ?? DEFAULT_REVIEW.model;
  invariant(typeof model === "string" && /^glm-[A-Za-z0-9.-]+$/.test(model), "INVALID_CONFIG", "review.model must be a GLM model identifier");
  const blockingSeverities = stringArray(rawReview.blocking_severities ?? DEFAULT_REVIEW.blocking_severities, "review.blocking_severities", { min: 1, max: 4, pattern: /^P[0-3]$/ });
  invariant(new Set(blockingSeverities).size === blockingSeverities.length, "INVALID_CONFIG", "review.blocking_severities contains duplicates");

  const rawImplementation = raw.implementation ?? {};
  exactKeys(rawImplementation, Object.keys(DEFAULT_IMPLEMENTATION), "implementation");
  const implementationModel = rawImplementation.model ?? DEFAULT_IMPLEMENTATION.model;
  const implementationEffort = rawImplementation.reasoning_effort ?? DEFAULT_IMPLEMENTATION.reasoning_effort;
  invariant(typeof implementationModel === "string" && /^[A-Za-z0-9._-]+$/.test(implementationModel), "INVALID_CONFIG", "implementation.model is invalid");
  invariant(["low", "medium", "high", "xhigh"].includes(implementationEffort), "INVALID_CONFIG", "implementation.reasoning_effort is invalid");

  return Object.freeze({
    schema_version: 1,
    project_id: raw.project_id,
    default_branch: raw.default_branch,
    ci_workflow: raw.ci_workflow,
    setup_commands: setupCommands,
    verification_commands: verificationCommands,
    context_files: contextFiles,
    allowed_actors: allowedActors,
    branch_prefix: branchPrefix,
    protected_paths: [...HARD_PROTECTED_PATHS, ...protectedPaths],
    limits,
    implementation: { model: implementationModel, reasoning_effort: implementationEffort },
    review: { model, blocking_severities: blockingSeverities },
  });
}

export async function loadConfig(path = ".ai-factory/project.json") {
  return validateConfig(await readJson(path));
}

export async function loadContext(config, root = process.cwd()) {
  const entries = [];
  let totalBytes = 0;
  for (const relativePath of config.context_files) {
    const path = safeRepoPath(root, relativePath);
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (error.code === "ENOENT") invariant(false, "CONTEXT_MISSING", `Required context file does not exist: ${relativePath}`);
      invariant(false, "CONTEXT_READ_FAILED", `Cannot inspect context file ${relativePath}: ${error.message}`);
    }
    invariant(stat.isFile() && !stat.isSymbolicLink(), "UNSAFE_CONTEXT", `Context path must be a regular file: ${relativePath}`);
    totalBytes += stat.size;
    invariant(totalBytes <= config.limits.max_context_bytes, "CONTEXT_LIMIT", `Context files exceed ${config.limits.max_context_bytes} bytes; split or raise the explicit project limit`);
    entries.push({ path: posix.normalize(relativePath), content: await readFile(path, "utf8") });
  }
  return entries;
}
