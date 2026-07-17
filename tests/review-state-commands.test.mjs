import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../scripts/factory/config.mjs";
import { validateReview } from "../scripts/factory/glm.mjs";
import { prepareReviewBatches } from "../scripts/factory/review.mjs";
import { attemptFromLabels, parseStateMarker, stateMarker, taskDigest } from "../scripts/factory/state.mjs";
import { executeCommands } from "../scripts/factory/commands.mjs";
import { isolatedUserSudoArgs, run } from "../scripts/factory/lib.mjs";
import { supervisionDisposition } from "../scripts/factory/supervision.mjs";

const config = validateConfig({
  schema_version: 1,
  project_id: "review-tests",
  default_branch: "main",
  ci_workflow: "ci.yml",
  setup_commands: ["true"],
  verification_commands: ["true"],
  allowed_actors: ["shan"],
  limits: { max_patch_bytes: 1024 * 1024, max_changed_files: 20, max_context_bytes: 1024, max_review_batch_bytes: 4096, max_repair_cycles: 2 },
});

function workflowRun(overrides = {}) {
  return {
    repository: { full_name: "shan/Cascada" },
    path: ".github/workflows/ci.yml",
    status: "completed",
    event: "workflow_dispatch",
    actor: { login: "github-actions[bot]" },
    triggering_actor: { login: "github-actions[bot]" },
    run_attempt: 1,
    head_branch: "ai-factory/issue-12",
    head_repository: { full_name: "shan/Cascada" },
    head_sha: "a".repeat(40),
    ...overrides,
  };
}

const supervisionConfig = {
  repository: "shan/Cascada",
  ciWorkflow: "ci.yml",
  branchPrefix: "ai-factory/",
};

test("supervision ignores ordinary CI and admits only exact factory dispatches", () => {
  assert.equal(supervisionDisposition(workflowRun({ event: "pull_request", actor: { login: "shan" }, head_branch: "feature/real-work" }), supervisionConfig), "ignore");
  assert.equal(supervisionDisposition(workflowRun({ actor: { login: "shan" } }), supervisionConfig), "ignore");
  assert.equal(supervisionDisposition(workflowRun({ head_branch: "main" }), supervisionConfig), "ignore");
  assert.equal(supervisionDisposition(workflowRun(), supervisionConfig), "inspect");
});

test("supervision fails closed on rerun or altered factory provenance", () => {
  assert.throws(() => supervisionDisposition(workflowRun({ run_attempt: 2, triggering_actor: { login: "shan" } }), supervisionConfig), (error) => error.code === "UNMANAGED_RERUN");
  assert.throws(() => supervisionDisposition(workflowRun({ path: ".github/workflows/not-ci.yml" }), supervisionConfig), (error) => error.code === "WRONG_WORKFLOW");
  assert.throws(() => supervisionDisposition(workflowRun({ head_repository: { full_name: "attacker/Cascada" } }), supervisionConfig), (error) => error.code === "FORK_REJECTED");
});

test("state marker is strict and repair attempt is single-valued", () => {
  const digest = taskDigest({ number: 91, title: "Real task", body: "Long acceptance contract", author: "shan", authorized_by: "shan", risk: "yellow" });
  const marker = stateMarker({ issue: 91, project: "review-tests", authorizedBy: "shan", taskSha: digest });
  assert.deepEqual(parseStateMarker(marker), { issue: 91, project: "review-tests", authorized_by: "shan", task_sha: digest });
  assert.equal(attemptFromLabels([{ name: "ai:managed" }, { name: "ai:repair:2" }]), 2);
  assert.throws(() => attemptFromLabels(["ai:repair:1", "ai:repair:2"]), /multiple/);
});

test("GLM structured output is accepted only for the exact batch and changed paths", () => {
  const batch = { batch_id: "batch-0001", files: ["src/ledger.mjs"] };
  const valid = validateReview({
    batch_id: "batch-0001",
    verdict: "findings",
    summary: "A retry can double-apply the ledger mutation.",
    findings: [{ severity: "P1", category: "data-integrity", path: "src/ledger.mjs", line: 44, title: "Non-idempotent retry", evidence: "The mutation occurs before the durable idempotency record is written.", recommendation: "Write or lock the idempotency record in the same transaction." }],
  }, batch);
  assert.equal(valid.findings[0].severity, "P1");
  assert.throws(() => validateReview({ batch_id: "wrong", verdict: "clear", summary: "No defects found.", findings: [] }, batch), /wrong batch_id/);
  assert.throws(() => validateReview({ batch_id: "batch-0001", verdict: "findings", summary: "Bad path finding.", findings: [{ severity: "P1", category: "security", path: "unchanged.mjs", line: null, title: "Bad path", evidence: "Evidence is sufficiently detailed.", recommendation: "Recommendation is sufficiently detailed." }] }, batch), /not present/);
});

test("review batching covers the complete diff and splits oversized changes without dropping bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-review-"));
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.name", "test"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await writeFile(join(root, "ledger.mjs"), "export const entries = [];\n");
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-m", "base"], { cwd: root });
  const base = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const body = Array.from({ length: 500 }, (_, index) => `export const row${index} = ${index};`).join("\n");
  await writeFile(join(root, "ledger.mjs"), `${body}\n`);
  await run("git", ["add", "."], { cwd: root });
  await run("git", ["commit", "-m", "large implementation"], { cwd: root });
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  const output = join(root, ".git", "review");
  const manifest = await prepareReviewBatches({ config, root, baseSha: base, headSha: head, outputDirectory: output });
  assert.ok(manifest.batch_count > 1);
  assert.ok(manifest.segment_count > 1);
  const segments = [];
  for (const batch of manifest.batches) {
    const value = JSON.parse(await readFile(join(output, batch.path), "utf8"));
    segments.push(...value.segments);
  }
  assert.equal(segments.length, manifest.segment_count);
  assert.ok(segments.every((segment) => segment.bytes <= config.limits.max_review_batch_bytes));
  assert.equal(new Set(segments.map((segment) => segment.segment_id)).size, segments.length);
});

test("project command runner stops on the first real failure and redacts secrets", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-commands-"));
  const report = await executeCommands([
    "printf 'first\\n'",
    "printf 'token=super-secret-value\\n' >&2; exit 7",
    "printf 'must-not-run'",
  ], { cwd: root, phase: "verify" });
  assert.equal(report.ok, false);
  assert.equal(report.commands.length, 2);
  assert.equal(report.commands[1].exit_code, 7);
  assert.doesNotMatch(report.commands[1].stderr, /super-secret-value/);
});

test("isolated project commands enter the exact checkout without runner shell injection or path evaluation", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-cwd-"));
  const checkout = join(root, "repo $(touch injected) with spaces");
  const sentinel = join(root, "injected");
  const bashEnv = join(root, "runner-bash-env");
  await mkdir(checkout);
  await writeFile(join(checkout, "package-lock.json"), "{}\n");
  await writeFile(bashEnv, `touch ${JSON.stringify(sentinel)}\ncd /\n`);

  const args = isolatedUserSudoArgs("pwd; test -f package-lock.json", "factorysetup", checkout);
  assert.deepEqual(args.slice(0, 5), ["-n", "-u", "factorysetup", "-H", "--"]);
  assert.equal(args.at(-1), checkout);
  assert.deepEqual(args.slice(5, 10), ["env", "BASH_ENV=/dev/null", "bash", "--noprofile", "--norc"]);
  assert.equal(args[13].includes(checkout), false);
  const result = await run(args[5], args.slice(6), { cwd: root, env: { ...process.env, BASH_ENV: bashEnv } });

  assert.equal(result.stdout.trim(), checkout);
  await assert.rejects(access(sentinel), (error) => error.code === "ENOENT");
});
