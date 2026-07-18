import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveTrustedArtifactRoot } from "../scripts/factory/lib.mjs";

test("trusted artifact root resolves a normalized sibling outside the model workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-artifacts-"));
  const workspace = join(root, "work", "consumer", "consumer");
  const artifactRoot = join(root, "work", "consumer", "factory-tmp");
  const runtime = join(artifactRoot, "factory-runtime");
  await mkdir(workspace, { recursive: true });
  await mkdir(runtime, { recursive: true });

  const unnormalizedRuntime = join(workspace, "..", "factory-tmp", "factory-runtime");
  const resolved = await resolveTrustedArtifactRoot(workspace, unnormalizedRuntime);
  assert.equal(resolved, artifactRoot);
  assert.doesNotMatch(resolved, /(?:^|\/)\.\.(?:\/|$)/);
});

test("trusted artifact root rejects workspace-local and symlink-redirection paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-artifact-reject-"));
  const workspace = join(root, "work", "consumer", "consumer");
  const insideRuntime = join(workspace, "factory-tmp", "factory-runtime");
  await mkdir(insideRuntime, { recursive: true });
  await assert.rejects(resolveTrustedArtifactRoot(workspace, insideRuntime), (error) => error.code === "INVALID_ARTIFACT_ROOT");

  const redirected = join(root, "redirected-artifacts");
  await mkdir(join(redirected, "factory-runtime"), { recursive: true });
  await symlink(redirected, join(root, "work", "consumer", "factory-tmp"));
  await assert.rejects(
    resolveTrustedArtifactRoot(workspace, join(root, "work", "consumer", "factory-tmp", "factory-runtime")),
    (error) => error.code === "INVALID_ARTIFACT_ROOT",
  );
});

test("every artifact action consumes a normalized trusted-root output in its own job", async () => {
  for (const file of ["reusable-implement.yml", "reusable-supervise.yml"]) {
    const workflow = await readFile(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8");
    const jobStarts = [...workflow.matchAll(/^  [a-z_]+:\s*$/gm)].map((match) => match.index);
    const actions = [...workflow.matchAll(/^\s+uses: actions\/(?:upload|download)-artifact@[0-9a-f]{40}.*$/gm)];
    assert.ok(actions.length > 0);
    assert.equal(workflow.split("id: artifact_root").length - 1, workflow.split("rm -rf .factory-source").length - 1);

    for (const action of actions) {
      const jobStart = jobStarts.filter((index) => index < action.index).at(-1);
      const resolver = workflow.lastIndexOf("id: artifact_root", action.index);
      const nextStep = workflow.indexOf("\n      - name:", action.index + action[0].length);
      const nextJob = jobStarts.find((index) => index > action.index) ?? workflow.length;
      const blockEnd = nextStep === -1 ? nextJob : Math.min(nextStep, nextJob);
      const block = workflow.slice(action.index, blockEnd);
      assert.ok(resolver > jobStart, `${file} artifact action is missing a same-job trusted-root resolver`);
      assert.match(block, /path: [|]?\s*[\s\S]*steps\.artifact_root\.outputs\.root/);
      assert.doesNotMatch(block, /(?:^|\/)\.\.(?:\/|$)/m);
    }
  }
});
