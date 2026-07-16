import { lstat, readFile } from "node:fs/promises";
import { posix } from "node:path";
import { invariant, run, safeRepoPath, sha256, writeJsonAtomic, writeTextAtomic } from "./lib.mjs";

const SECRET_PATTERNS = Object.freeze([
  { name: "private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "GitHub token", regex: /\b(?:gh[oprsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/ },
  { name: "OpenAI-style secret", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{20,}\b/ },
  { name: "AWS access key", regex: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/ },
]);

export function globToRegExp(glob) {
  let output = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    const next = glob[index + 1];
    if (character === "*" && next === "*") {
      const after = glob[index + 2];
      if (after === "/") {
        output += "(?:.*/)?";
        index += 2;
      } else {
        output += ".*";
        index += 1;
      }
    } else if (character === "*") output += "[^/]*";
    else if (character === "?") output += "[^/]";
    else output += character.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
  }
  return new RegExp(`${output}$`, "i");
}

export function isProtectedPath(path, patterns) {
  const normalized = posix.normalize(path);
  return patterns.some((pattern) => globToRegExp(pattern).test(normalized));
}

export function parsePorcelainZ(output) {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  const changes = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    invariant(record.length >= 4 && record[2] === " ", "GIT_STATUS_PARSE", `Unexpected git status record: ${JSON.stringify(record)}`);
    const status = record.slice(0, 2);
    const path = record.slice(3);
    const change = { status, path };
    if (/[RC]/.test(status)) {
      invariant(index + 1 < records.length, "GIT_STATUS_PARSE", "Rename/copy record is missing its source path");
      change.source_path = records[++index];
    }
    changes.push(change);
  }
  return changes;
}

async function validatePaths(changes, config, root) {
  const allPaths = new Set();
  for (const change of changes) {
    allPaths.add(change.path);
    if (change.source_path) allPaths.add(change.source_path);
  }
  invariant(changes.length > 0, "EMPTY_PATCH", "Codex produced no repository changes");
  invariant(allPaths.size <= config.limits.max_changed_files, "TOO_MANY_FILES", `Patch touches ${allPaths.size} paths; limit is ${config.limits.max_changed_files}`);
  for (const path of allPaths) {
    invariant(!/[\x00-\x1f\x7f]/.test(path), "UNSAFE_PATH", `Control characters are not allowed in generated paths: ${JSON.stringify(path)}`);
    safeRepoPath(root, path);
    invariant(!path.includes("\\"), "UNSAFE_PATH", `Backslashes are not allowed in generated repository paths: ${path}`);
    invariant(path !== ".git" && !path.startsWith(".git/"), "PROTECTED_PATH", `Git metadata cannot be changed: ${path}`);
    invariant(!isProtectedPath(path, config.protected_paths), "PROTECTED_PATH", `Generated changes cannot modify protected path: ${path}`);
  }
  for (const change of changes) {
    if (change.status.includes("D")) continue;
    const stat = await lstat(safeRepoPath(root, change.path));
    invariant(!stat.isSymbolicLink(), "SYMLINK_REJECTED", `Generated symlink is not allowed: ${change.path}`);
    invariant(stat.isFile(), "NON_FILE_REJECTED", `Generated path must be a regular file: ${change.path}`);
  }
  return [...allPaths].sort();
}

function scanSecrets(patch) {
  for (const pattern of SECRET_PATTERNS) {
    invariant(!pattern.regex.test(patch), "SECRET_DETECTED", `Generated patch contains a possible ${pattern.name}`);
  }
}

export async function capturePatch({ config, root = process.cwd(), expectedHead, patchPath, manifestPath }) {
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  invariant(head === expectedHead, "STALE_HEAD", `Checkout head ${head} does not match expected ${expectedHead}`);
  const status = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root });
  const changes = parsePorcelainZ(status.stdout);
  const paths = await validatePaths(changes, config, root);
  await run("git", ["add", "-A", "--", ...paths], { cwd: root });
  const staged = await run("git", ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"], { cwd: root, maxBytes: config.limits.max_patch_bytes + 1, allowFailure: true });
  invariant(staged.code === 0, "PATCH_CAPTURE_FAILED", staged.stderr || "git diff failed");
  invariant(Buffer.byteLength(staged.stdout) > 0, "EMPTY_PATCH", "No staged diff was produced");
  invariant(Buffer.byteLength(staged.stdout) <= config.limits.max_patch_bytes, "PATCH_TOO_LARGE", `Patch exceeds ${config.limits.max_patch_bytes} bytes`);
  scanSecrets(staged.stdout);
  const numstat = await run("git", ["diff", "--cached", "--numstat", "-z", "HEAD"], { cwd: root });
  invariant(!numstat.stdout.split("\0").some((entry) => entry.startsWith("-\t-\t")), "BINARY_PATCH_REJECTED", "Generated binary changes cannot receive complete independent review");
  const submodules = await run("git", ["diff", "--cached", "--raw", "HEAD"], { cwd: root });
  invariant(!/^:\d+ 160000 /m.test(submodules.stdout) && !/^:160000 \d+ /m.test(submodules.stdout), "SUBMODULE_REJECTED", "Generated submodule changes are not allowed");
  const manifest = {
    schema_version: 1,
    base_sha: head,
    patch_sha256: sha256(staged.stdout),
    patch_bytes: Buffer.byteLength(staged.stdout),
    files: paths,
    created_at: new Date().toISOString(),
  };
  await writeTextAtomic(patchPath, staged.stdout);
  await writeJsonAtomic(manifestPath, manifest);
  return manifest;
}

export async function applyAndValidatePatch({ config, root = process.cwd(), expectedHead, patchPath, manifestPath }) {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const patch = await readFile(patchPath, "utf8");
  invariant(manifest.schema_version === 1, "INVALID_MANIFEST", "Unsupported patch manifest version");
  invariant(manifest.base_sha === expectedHead, "STALE_ARTIFACT", "Patch manifest base does not match expected head");
  invariant(sha256(patch) === manifest.patch_sha256, "ARTIFACT_TAMPERED", "Patch checksum does not match manifest");
  invariant(Buffer.byteLength(patch) === manifest.patch_bytes, "ARTIFACT_TAMPERED", "Patch byte count does not match manifest");
  invariant(Buffer.byteLength(patch) <= config.limits.max_patch_bytes, "PATCH_TOO_LARGE", "Downloaded patch exceeds project limit");
  scanSecrets(patch);
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  invariant(head === expectedHead, "STALE_HEAD", `Publisher checkout head ${head} does not match expected ${expectedHead}`);
  const clean = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root });
  invariant(clean.stdout.length === 0, "DIRTY_PUBLISHER", "Publisher checkout is not clean before applying patch");
  await run("git", ["apply", "--check", "--binary", "--whitespace=error-all", patchPath], { cwd: root });
  await run("git", ["apply", "--index", "--binary", "--whitespace=error-all", patchPath], { cwd: root });
  const status = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd: root });
  const changes = parsePorcelainZ(status.stdout);
  const paths = await validatePaths(changes, config, root);
  invariant(JSON.stringify(paths) === JSON.stringify([...manifest.files].sort()), "ARTIFACT_TAMPERED", "Applied paths do not match patch manifest");
  const recreated = await run("git", ["diff", "--cached", "--binary", "--no-ext-diff", "HEAD"], { cwd: root, maxBytes: config.limits.max_patch_bytes + 1 });
  invariant(sha256(recreated.stdout) === manifest.patch_sha256, "ARTIFACT_TAMPERED", "Applied patch does not reproduce the captured diff");
  return manifest;
}
