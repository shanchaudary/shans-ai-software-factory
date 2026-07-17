import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createLinter } from "actionlint";
import { assertOpenAiCredentialPresence } from "../scripts/factory/assert-openai-credential.mjs";
import { FactoryError } from "../scripts/factory/lib.mjs";

const WORKFLOW_PATH = ".github/workflows/reusable-implement.yml";
const PINNED_CODEX_ACTION = "openai/codex-action@52fe01ec70a42f454c9d2ebd47598f9fd6893d56";
const GATE_STEP = 'FACTORY_OPENAI_KEY_PRESENT: ${{ secrets.OPENAI_API_KEY != \'\' }}';
const RAW_SECRET_INTERPOLATION = /\$\{\{\s*secrets\.OPENAI_API_KEY\s*\}\}/g;

test("credential presence gate passes when the boolean flag is 'true'", () => {
  assert.doesNotThrow(() => assertOpenAiCredentialPresence("true"));
});

test("credential presence gate fails closed when the secret resolved empty", () => {
  for (const flag of ["false", "", undefined]) {
    assert.throws(
      () => assertOpenAiCredentialPresence(flag ?? ""),
      (error) => {
        assert.ok(error instanceof FactoryError);
        assert.ok(error.code === "MISSING_OPENAI_API_KEY" || error.code === "INVALID_PREFLIGHT_INPUT");
        return true;
      },
      `flag ${JSON.stringify(flag)} must not pass the gate`,
    );
  }
});

test("gate failure names the exact secret and owner action without any credential material", () => {
  let caught;
  try {
    assertOpenAiCredentialPresence("false");
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof FactoryError);
  assert.equal(caught.code, "MISSING_OPENAI_API_KEY");
  assert.match(caught.message, /Actions secret named OPENAI_API_KEY/);
  assert.match(caught.message, /Code cannot manufacture this credential/);
  // The gate only ever receives 'true'/'false'; assert the message carries no
  // plausible key material shapes regardless.
  assert.doesNotMatch(caught.message, /sk-[A-Za-z0-9]/);
});

test("gate rejects unexpected input shapes instead of guessing", () => {
  for (const flag of ["TRUE", "1", "yes", "null"]) {
    assert.throws(
      () => assertOpenAiCredentialPresence(flag),
      (error) => error instanceof FactoryError && error.code === "INVALID_PREFLIGHT_INPUT",
    );
  }
});

test("workflow authorizes the task before checking credential presence and stops before Codex", async () => {
  const text = await readFile(WORKFLOW_PATH, "utf8");
  const authorizationIndex = text.indexOf("prepare-task.mjs");
  const gateIndex = text.indexOf("assert-openai-credential.mjs");
  const actionIndex = text.indexOf(PINNED_CODEX_ACTION);
  assert.ok(authorizationIndex > -1, "task authorization step must exist");
  assert.ok(gateIndex > -1, "credential gate step must exist");
  assert.ok(actionIndex > -1, "pinned Codex action must remain in place");
  assert.ok(authorizationIndex < gateIndex, "credential-presence metadata must not be disclosed before task and actor authorization");
  assert.ok(gateIndex < actionIndex, "an empty secret must be stopped before it can reach the action");
  assert.ok(text.includes(GATE_STEP), "gate must receive only the boolean presence expression, never the value");
});

test("raw OPENAI_API_KEY interpolation appears only as the pinned action input", async () => {
  const text = await readFile(WORKFLOW_PATH, "utf8");
  const raw = [...text.matchAll(RAW_SECRET_INTERPOLATION)];
  assert.equal(raw.length, 1, "exactly one raw secret interpolation is allowed");
  const line = text.slice(text.lastIndexOf("\n", raw[0].index) + 1, text.indexOf("\n", raw[0].index));
  assert.match(line.trim(), /^openai-api-key: \$\{\{ secrets\.OPENAI_API_KEY \}\}$/, "the secret value may flow only into the official action's input");
});

test("modified workflow still passes actionlint", async () => {
  const lint = await createLinter();
  const text = await readFile(WORKFLOW_PATH, "utf8");
  const findings = lint(text, WORKFLOW_PATH);
  assert.deepEqual(findings, []);
});
