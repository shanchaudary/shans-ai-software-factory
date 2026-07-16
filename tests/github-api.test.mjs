import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApi } from "../scripts/factory/github-api.mjs";
import { FactoryError } from "../scripts/factory/lib.mjs";

function client(fetchImpl, overrides = {}) {
  const waits = [];
  const retries = [];
  return {
    api: new GitHubApi({
      token: "test-token",
      repository: "owner/repository",
      fetchImpl,
      wait: async (milliseconds) => waits.push(milliseconds),
      retryLogger: (event) => retries.push(event),
      ...overrides,
    }),
    waits,
    retries,
  };
}

test("GitHub API retries transient read failures and preserves request authentication", async () => {
  const responses = [
    new Response("temporary outage", { status: 503 }),
    new Response("upstream failure", { status: 502 }),
    Response.json({ number: 12, state: "open" }),
  ];
  const requests = [];
  const { api, waits, retries } = client(async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  });

  assert.deepEqual(await api.getIssue(12), { number: 12, state: "open" });
  assert.equal(requests.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
  assert.deepEqual(retries.map(({ status, failed_attempt, next_attempt }) => ({ status, failed_attempt, next_attempt })), [
    { status: 503, failed_attempt: 1, next_attempt: 2 },
    { status: 502, failed_attempt: 2, next_attempt: 3 },
  ]);
  for (const request of requests) {
    assert.equal(request.options.method, "GET");
    assert.equal(request.options.headers.Authorization, "Bearer test-token");
  }
});

test("GitHub API retries transient read transport errors and honors bounded Retry-After", async () => {
  let attempt = 0;
  const { api, waits, retries } = client(async () => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("connection reset");
    if (attempt === 2) return new Response("rate limited", { status: 429, headers: { "Retry-After": "99" } });
    return Response.json([{ id: 1 }]);
  });

  assert.deepEqual(await api.listIssueEvents(12), [{ id: 1 }]);
  assert.deepEqual(waits, [1000, 10000]);
  assert.deepEqual(retries.map(({ status }) => status), [null, 429]);
});

test("GitHub API never retries writes and bounds exhausted reads", async () => {
  let writeCalls = 0;
  const writeClient = client(async () => {
    writeCalls += 1;
    return new Response("unavailable", { status: 503 });
  });
  await assert.rejects(writeClient.api.createComment(12, "comment"), (error) => error instanceof FactoryError
    && error.code === "GITHUB_API_ERROR"
    && error.details.status === 503
    && error.details.attempts === 1);
  assert.equal(writeCalls, 1);
  assert.deepEqual(writeClient.waits, []);

  let unauthorizedCalls = 0;
  const unauthorizedClient = client(async () => {
    unauthorizedCalls += 1;
    return new Response("bad credentials", { status: 401 });
  });
  await assert.rejects(unauthorizedClient.api.getIssue(12), (error) => error instanceof FactoryError
    && error.code === "GITHUB_API_ERROR"
    && error.details.status === 401
    && error.details.attempts === 1);
  assert.equal(unauthorizedCalls, 1);
  assert.deepEqual(unauthorizedClient.waits, []);

  let readCalls = 0;
  const readClient = client(async () => {
    readCalls += 1;
    return new Response("still unavailable", { status: 504 });
  });
  await assert.rejects(readClient.api.getIssue(12), (error) => error instanceof FactoryError
    && error.code === "GITHUB_API_ERROR"
    && error.details.status === 504
    && error.details.attempts === 5
    && error.details.body === "still unavailable");
  assert.equal(readCalls, 5);
  assert.deepEqual(readClient.waits, [1000, 2000, 4000, 8000]);
});
