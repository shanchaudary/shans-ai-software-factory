import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateConfig } from "../scripts/factory/config.mjs";
import { applyAndValidatePatch, capturePatch, globToRegExp, isProtectedPath, parsePorcelainZ } from "../scripts/factory/patch.mjs";
import { run } from "../scripts/factory/lib.mjs";

const config = validateConfig({
  schema_version: 1,
  project_id: "patch-tests",
  default_branch: "main",
  ci_workflow: "ci.yml",
  setup_commands: ["true"],
  verification_commands: ["true"],
  allowed_actors: ["shan"],
  limits: { max_patch_bytes: 1024 * 1024, max_changed_files: 20, max_context_bytes: 1024, max_review_batch_bytes: 4096, max_repair_cycles: 2 },
});

async function repository() {
  const root = await mkdtemp(join(tmpdir(), "factory-patch-"));
  await run("git", ["init", "-b", "main"], { cwd: root });
  await run("git", ["config", "user.name", "test"], { cwd: root });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: root });
  await writeFile(join(root, "service.mjs"), "export const value = 1;\n");
  await run("git", ["add", "service.mjs"], { cwd: root });
  await run("git", ["commit", "-m", "base"], { cwd: root });
  const sha = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  return { root, sha };
}

test("glob matching protects recursive governance paths", () => {
  assert.ok(globToRegExp("**/AGENTS.md").test("packages/api/AGENTS.md"));
  assert.ok(isProtectedPath(".github/workflows/ci.yml", config.protected_paths));
  assert.ok(isProtectedPath("services/.env.production", config.protected_paths));
  assert.equal(isProtectedPath("src/service.mjs", config.protected_paths), false);
});

test("porcelain parser preserves rename source and destination", () => {
  assert.deepEqual(parsePorcelainZ("R  new.mjs\0old.mjs\0?? added.mjs\0"), [
    { status: "R ", path: "new.mjs", source_path: "old.mjs" },
    { status: "??", path: "added.mjs" },
  ]);
});

test("patch is captured, checksummed, and exactly reproduced in a fresh checkout", async () => {
  const { root, sha } = await repository();
  await writeFile(join(root, "service.mjs"), "export const value = 2;\nexport function reconcile(id) { return { id, durable: true }; }\n");
  await writeFile(join(root, "service.test.mjs"), "import { strict as assert } from 'node:assert';\nassert.ok(true);\n");
  const patchPath = join(root, "..", `${root.split("/").at(-1)}.patch`);
  const manifestPath = `${patchPath}.json`;
  const manifest = await capturePatch({ config, root, expectedHead: sha, patchPath, manifestPath });
  assert.equal(manifest.files.length, 2);
  assert.equal(manifest.patch_sha256.length, 64);

  const publisher = await mkdtemp(join(tmpdir(), "factory-publisher-"));
  await run("git", ["clone", "--no-local", root, publisher]);
  await applyAndValidatePatch({ config, root: publisher, expectedHead: sha, patchPath, manifestPath });
  const staged = await run("git", ["diff", "--cached", "--binary", "HEAD"], { cwd: publisher });
  assert.equal(staged.stdout, await readFile(patchPath, "utf8"));
});

test("patch capture rejects protected paths and embedded credentials", async () => {
  const first = await repository();
  await writeFile(join(first.root, "AGENTS.md"), "weaken security\n");
  await assert.rejects(capturePatch({ config, root: first.root, expectedHead: first.sha, patchPath: join(first.root, "..", "protected.patch"), manifestPath: join(first.root, "..", "protected.json") }), (error) => error.code === "PROTECTED_PATH");

  const second = await repository();
  await writeFile(join(second.root, "service.mjs"), `export const token = "github_pat_${"A".repeat(30)}";\n`);
  await assert.rejects(capturePatch({ config, root: second.root, expectedHead: second.sha, patchPath: join(second.root, "..", "secret.patch"), manifestPath: join(second.root, "..", "secret.json") }), (error) => error.code === "SECRET_DETECTED");
});

test("publisher rejects a tampered artifact", async () => {
  const { root, sha } = await repository();
  await writeFile(join(root, "service.mjs"), "export const value = 9;\n");
  const patchPath = join(root, "..", "tamper.patch");
  const manifestPath = join(root, "..", "tamper.json");
  await capturePatch({ config, root, expectedHead: sha, patchPath, manifestPath });
  await writeFile(patchPath, `${await readFile(patchPath, "utf8")}\n# tampered\n`);
  const publisher = await mkdtemp(join(tmpdir(), "factory-tamper-publisher-"));
  await run("git", ["clone", "--no-local", root, publisher]);
  await assert.rejects(applyAndValidatePatch({ config, root: publisher, expectedHead: sha, patchPath, manifestPath }), (error) => error.code === "ARTIFACT_TAMPERED");
});
