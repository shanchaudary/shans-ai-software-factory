import test from "node:test";
import assert from "node:assert/strict";
import { validateConfig, HARD_PROTECTED_PATHS } from "../scripts/factory/config.mjs";
import { validateTask } from "../scripts/factory/task.mjs";
import { FactoryError } from "../scripts/factory/lib.mjs";

function rawConfig(overrides = {}) {
  return {
    schema_version: 1,
    project_id: "production-api",
    default_branch: "main",
    ci_workflow: "ci.yml",
    setup_commands: ["npm ci"],
    verification_commands: ["npm test", "npm run build"],
    context_files: ["AGENTS.md", "README.md"],
    allowed_actors: ["shanchaudary"],
    ...overrides,
  };
}

function issue(overrides = {}) {
  return {
    number: 42,
    node_id: "I_42",
    html_url: "https://github.test/o/r/issues/42",
    title: "Implement durable invoice reconciliation",
    body: "Acceptance requires idempotency, recovery, audit logging, and integration tests.",
    state: "open",
    labels: [{ name: "ai:build" }, { name: "ai:risk:yellow" }],
    user: { login: "shanchaudary" },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

test("configuration expands hard security defaults and current models", () => {
  const config = validateConfig(rawConfig());
  assert.equal(config.implementation.model, "gpt-5.6");
  assert.equal(config.review.model, "glm-5.2");
  assert.equal(config.limits.max_repair_cycles, 3);
  for (const path of HARD_PROTECTED_PATHS) assert.ok(config.protected_paths.includes(path));
});

test("configuration rejects unknown keys and placeholder commands", () => {
  assert.throws(() => validateConfig(rawConfig({ imaginary_capability: true })), (error) => error instanceof FactoryError && error.code === "INVALID_CONFIG");
  assert.throws(() => validateConfig(rawConfig({ setup_commands: ["REPLACE_WITH_REAL_SETUP"] })), /placeholder/);
});

test("configuration rejects unsafe paths, duplicate actors, and invalid retry limits", () => {
  assert.throws(() => validateConfig(rawConfig({ context_files: ["../secret"] })), /Unsafe/);
  assert.throws(() => validateConfig(rawConfig({ allowed_actors: ["Shan", "shan"] })), /duplicates/);
  assert.throws(() => validateConfig(rawConfig({ limits: { max_repair_cycles: 99 } })), /between 0 and 5/);
});

test("task authorization requires open issue, allowed actor, build label, and one non-black risk", () => {
  const config = validateConfig(rawConfig());
  const task = validateTask(issue(), config, "ShanChaudary");
  assert.equal(task.number, 42);
  assert.equal(task.risk, "yellow");
  assert.equal(task.authorized_by, "ShanChaudary");
  const redispatched = validateTask(issue(), validateConfig(rawConfig({ allowed_actors: ["shanchaudary", "release-manager"] })), "release-manager", "shanchaudary");
  assert.equal(redispatched.authorized_by, "shanchaudary");
  assert.throws(() => validateTask(issue({ labels: [{ name: "ai:risk:green" }] }), config, "shanchaudary"), /ai:build/);
  assert.throws(() => validateTask(issue({ labels: [{ name: "ai:build" }, { name: "ai:risk:black" }] }), config, "shanchaudary"), (error) => error.code === "BLACK_RISK_REJECTED");
  assert.throws(() => validateTask(issue(), config, "intruder"), (error) => error.code === "ACTOR_NOT_ALLOWED");
  assert.throws(() => validateTask(issue({ state: "closed" }), config, "shanchaudary"), (error) => error.code === "TASK_NOT_OPEN");
});
