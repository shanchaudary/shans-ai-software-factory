import test from "node:test";
import assert from "node:assert/strict";
import { extractFailureDiagnosticLines, summarizeFailedRun } from "../scripts/factory/failure-diagnostics.mjs";

test("extracts actionable Codex errors while redacting credentials and excluding earlier prompt text", () => {
  const log = `
2026-07-18T02:30:00Z ##[group]Build implementation prompt
2026-07-18T02:30:00Z Requirement: explain why an invalid api key should fail closed.
2026-07-18T02:31:00Z Running: CODEX_HOME=/home/factorycodex/.codex sudo -u factorycodex -- codex exec
2026-07-18T02:31:01Z request Authorization: Bearer secret-bearer-token-123456789
2026-07-18T02:31:02Z ##[error]HTTP 401 Unauthorized: invalid api key sk-abcdefghijklmnopqrstuvwxyz123456
2026-07-18T02:31:03Z Error: codex request failed to authenticate
2026-07-18T02:31:04Z Error: sudo exited with code 1
`;

  const lines = extractFailureDiagnosticLines(log);
  assert.deepEqual(lines, [
    "Error: HTTP 401 Unauthorized: invalid api key [REDACTED TOKEN]",
    "Error: codex request failed to authenticate",
  ]);
  assert.equal(lines.some((line) => line.includes("Requirement:")), false);
  assert.equal(lines.some((line) => line.includes("secret-bearer")), false);
});

test("escapes model-controlled HTML and comment delimiters before issue publication", () => {
  const lines = extractFailureDiagnosticLines(`
Running: CODEX_HOME=/tmp/codex codex exec
Error: <!-- hidden --> <script>bad()</script> & unsafe
`);
  assert.deepEqual(lines, ["Error: &lt;!-- hidden --&gt; &lt;script&gt;bad()&lt;/script&gt; &amp; unsafe"]);
});

test("keeps a generic exit line only when no specific diagnosis exists", () => {
  const lines = extractFailureDiagnosticLines(`
Running: CODEX_HOME=/tmp/codex codex exec
Error: sudo exited with code 1
`);
  assert.deepEqual(lines, ["Error: sudo exited with code 1"]);
});

test("summarizes failed job logs and skips inaccessible or non-failed jobs", async () => {
  const github = {
    async getJobs() {
      return {
        jobs: [
          { id: 10, name: "Isolated Codex engineering", conclusion: "failure" },
          { id: 11, name: "Successful job", conclusion: "success" },
          { id: 12, name: "Unavailable log", conclusion: "failure" },
        ],
      };
    },
    async getJobLogs(id) {
      if (id === 12) throw new Error("unavailable");
      return Buffer.from("Running: CODEX_HOME=/tmp/codex codex exec\nError: model gpt-example not found\n");
    },
  };

  const summary = await summarizeFailedRun(github, 123);
  assert.match(summary, /Failed job: Isolated Codex engineering/);
  assert.match(summary, /model gpt-example not found/);
  assert.doesNotMatch(summary, /Successful job|Unavailable log/);
});

test("returns null when no actionable failed-job diagnostics are available", async () => {
  const github = {
    async getJobs() {
      return { jobs: [{ id: 20, name: "Noisy failure", conclusion: "failure" }] };
    },
    async getJobLogs() {
      return Buffer.from("ordinary output\nno actionable diagnostic\n");
    },
  };
  assert.equal(await summarizeFailedRun(github, 456), null);
});
