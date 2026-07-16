import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  OPENCODE_ENDPOINT,
  OPENCODE_PROVIDER,
  OPENCODE_VERSION,
  buildOpenCodeConfig,
  parseOpenCodeReviewEvents,
  reviewBatchWithOpenCode,
} from "../scripts/factory/opencode-glm.mjs";

const review = {
  batch_id: "batch-0001",
  verdict: "clear",
  summary: "No introduced defects were found.",
  findings: [],
};

function textEvent(value = review) {
  return JSON.stringify({
    type: "text",
    part: { type: "text", text: JSON.stringify(value) },
  });
}

test("OpenCode config restricts GLM to the Coding Plan reviewer without tools or sharing", () => {
  const config = buildOpenCodeConfig("glm-5.2");
  assert.deepEqual(config.enabled_providers, [OPENCODE_PROVIDER]);
  assert.equal(config.share, "disabled");
  assert.equal(config.autoupdate, false);
  assert.deepEqual(config.permission, { "*": "deny" });
  assert.deepEqual(config.agent["factory-reviewer"].permission, { "*": "deny" });
  assert.equal(config.agent["factory-reviewer"].model, "zai-coding-plan/glm-5.2");
  assert.equal(config.provider[OPENCODE_PROVIDER].options.baseURL, OPENCODE_ENDPOINT);
  assert.equal(config.provider[OPENCODE_PROVIDER].options.apiKey, "{env:ZAI_API_KEY}");
  assert.equal(JSON.stringify(config).includes("secret"), false);
  assert.throws(() => buildOpenCodeConfig("not/a/model"), /model identifier is invalid/);
});

test("OpenCode event parser accepts one raw review and records bounded usage", () => {
  const output = [
    JSON.stringify({ type: "step_start", part: { type: "step-start" } }),
    textEvent(),
    JSON.stringify({ type: "step_finish", part: { cost: 0.25, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } } } }),
  ].join("\n");
  assert.deepEqual(parseOpenCodeReviewEvents(output), {
    review,
    usage: [{ cost: 0.25, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } } }],
  });
});

test("OpenCode event parser fails closed on tools, errors, multiple answers, or markdown", () => {
  assert.throws(() => parseOpenCodeReviewEvents(JSON.stringify({ type: "tool_use", part: { tool: "bash" } })), /attempted to use/);
  assert.throws(() => parseOpenCodeReviewEvents(JSON.stringify({ type: "error", error: { name: "ProviderError" } })), /provider error/);
  assert.throws(() => parseOpenCodeReviewEvents(`${textEvent()}\n${textEvent()}`), /exactly one/);
  assert.throws(() => parseOpenCodeReviewEvents(JSON.stringify({ type: "text", part: { type: "text", text: "```json\n{}\n```" } })), /not raw JSON/);
});

test("OpenCode runner isolates the secret from argv and attaches the complete request", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-opencode-test-"));
  const requestRoot = join(root, "requests");
  const previous = {
    binary: process.env.FACTORY_OPENCODE_BIN,
    requestRoot: process.env.FACTORY_GLM_REQUEST_ROOT,
    sandbox: process.env.FACTORY_GLM_SANDBOX,
  };
  process.env.FACTORY_OPENCODE_BIN = "/trusted/opencode";
  process.env.FACTORY_GLM_REQUEST_ROOT = requestRoot;
  process.env.FACTORY_GLM_SANDBOX = "/home/factoryglm/review";
  const secret = "zai-test-secret-value-123456789";
  try {
    const result = await reviewBatchWithOpenCode({
      apiKey: secret,
      model: "glm-5.2",
      batch: { batch_id: "batch-0001", files: ["src/app.mjs"], segments: [] },
      task: { number: 12, title: "Remove lint debt" },
      context: {
        pr: { number: 2, base_sha: "a".repeat(40), head_sha: "b".repeat(40) },
        run: { conclusion: "success", url: "https://github.example/run/1" },
      },
      repositoryContext: { files: [{ path: "README.md", content: "context" }] },
      execute: async (command, args, options) => {
        assert.equal(command, "/usr/bin/sudo");
        assert.equal(args.includes("factoryglm"), true);
        assert.equal(args.includes("/trusted/opencode"), true);
        assert.equal(args.includes("zai-coding-plan/glm-5.2"), true);
        assert.equal(args.join(" ").includes(secret), false);
        assert.equal(options.env.ZAI_API_KEY, secret);
        assert.equal("GITHUB_TOKEN" in options.env, false);
        assert.equal(options.cwd, requestRoot);
        const fileIndex = args.indexOf("--file");
        assert.notEqual(fileIndex, -1);
        const requestPath = args[fileIndex + 1];
        assert.equal((await stat(requestPath)).mode & 0o777, 0o444);
        const request = JSON.parse(await readFile(requestPath, "utf8"));
        assert.equal(request.task.number, 12);
        assert.equal(request.review_batch.batch_id, "batch-0001");
        assert.equal(request.pull_request.head_sha, "b".repeat(40));
        return { stdout: textEvent(), stderr: "", code: 0, signal: null };
      },
    });
    assert.equal(result.transport, `opencode-terminal/${OPENCODE_VERSION}`);
    assert.deepEqual(result.review, review);
    assert.deepEqual(await readdir(requestRoot), []);
  } finally {
    if (previous.binary === undefined) delete process.env.FACTORY_OPENCODE_BIN;
    else process.env.FACTORY_OPENCODE_BIN = previous.binary;
    if (previous.requestRoot === undefined) delete process.env.FACTORY_GLM_REQUEST_ROOT;
    else process.env.FACTORY_GLM_REQUEST_ROOT = previous.requestRoot;
    if (previous.sandbox === undefined) delete process.env.FACTORY_GLM_SANDBOX;
    else process.env.FACTORY_GLM_SANDBOX = previous.sandbox;
    await rm(root, { recursive: true, force: true });
  }
});
