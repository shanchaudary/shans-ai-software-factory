#!/usr/bin/env node
// Fail-closed preflight for the Codex implementation engine.
//
// The workflow evaluates `${{ secrets.OPENAI_API_KEY != '' }}` and passes only
// the resulting boolean string here. The secret value itself is never placed
// in this process environment, never read, and never printed, so this gate
// cannot leak credentials. GitHub's `workflow_call` `secrets: required: true`
// only requires the caller to declare a mapping; a mapping to an unset
// repository secret still resolves to an empty string and previously reached
// the pinned openai/codex-action, which then skipped its Responses API proxy
// steps and failed late with an unrelated-looking server-info parse error.
import { pathToFileURL } from "node:url";
import { invariant, main } from "./lib.mjs";

export function assertOpenAiCredentialPresence(presenceFlag) {
  invariant(
    presenceFlag === "true" || presenceFlag === "false",
    "INVALID_PREFLIGHT_INPUT",
    "FACTORY_OPENAI_KEY_PRESENT must be the literal string 'true' or 'false' produced by the workflow expression `secrets.OPENAI_API_KEY != ''`",
  );
  invariant(
    presenceFlag === "true",
    "MISSING_OPENAI_API_KEY",
    "OPENAI_API_KEY resolved to an empty string at the workflow-call boundary. Code cannot manufacture this credential: the consumer repository owner must configure a non-empty repository Actions secret named OPENAI_API_KEY. Failing closed before the pinned Codex action runs.",
  );
}

const invokedDirectly = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  await main(async () => {
    assertOpenAiCredentialPresence(process.env.FACTORY_OPENAI_KEY_PRESENT ?? "");
  });
}
