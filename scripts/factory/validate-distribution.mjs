#!/usr/bin/env node
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { createLinter } from "actionlint";
import { invariant, main } from "./lib.mjs";

async function filesBelow(root) {
  const output = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) await visit(child);
      else output.push(child);
    }
  }
  await visit(root);
  return output;
}

export function validateWorkflowText(path, text) {
  invariant(!/\bpull_request_target\s*:/.test(text), "UNSAFE_WORKFLOW", `${path} uses pull_request_target`);
  const uses = [...text.matchAll(/^\s*uses:\s*([^\s#]+).*$/gm)].map((match) => match[1]);
  for (const reference of uses) {
    invariant(/^\.?\//.test(reference) || /@[0-9a-f]{40}$/.test(reference), "UNPINNED_ACTION", `${path} has a non-SHA action reference: ${reference}`);
  }
  invariant(!/\b(?:merge_pull_request|enablePullRequestAutoMerge|deployments:)\b/.test(text), "FORBIDDEN_CAPABILITY", `${path} contains merge or deployment capability`);
}

await main(async () => {
  const workflows = (await filesBelow(".github/workflows")).filter((path) => /\.ya?ml$/.test(path));
  invariant(workflows.length >= 3, "DISTRIBUTION_INCOMPLETE", "Expected factory CI and both reusable workflows");
  const consumerWorkflows = (await filesBelow("templates/consumer/.github/workflows")).filter((path) => /\.ya?ml$/.test(path));
  invariant(consumerWorkflows.length >= 2, "DISTRIBUTION_INCOMPLETE", "Expected both consumer workflow templates");
  const lintWorkflow = await createLinter();
  for (const path of workflows) {
    const text = await readFile(path, "utf8");
    validateWorkflowText(path, text);
    const findings = lintWorkflow(text, path);
    invariant(findings.length === 0, "INVALID_WORKFLOW", `${path} failed Actionlint validation`, findings);
  }
  for (const path of consumerWorkflows) {
    const text = await readFile(path, "utf8");
    validateWorkflowText(path, text.replaceAll("REPLACE_WITH_FULL_FACTORY_COMMIT_SHA", "0".repeat(40)));
    const findings = lintWorkflow(text, path);
    invariant(findings.length === 0, "INVALID_WORKFLOW", `${path} failed Actionlint validation`, findings);
  }

  const scripts = (await filesBelow("scripts/factory")).filter((path) => path.endsWith(".mjs"));
  const required = ["prepare-task.mjs", "validate-patch.mjs", "publish.mjs", "resolve-managed-pr.mjs", "supervision.mjs", "collect-ci-evidence.mjs", "prepare-review-batches.mjs", "glm-review.mjs", "finalize.mjs"];
  for (const name of required) invariant(scripts.some((path) => path.endsWith(`/${name}`)), "DISTRIBUTION_INCOMPLETE", `Missing runtime entry point ${name}`);

  const implement = await readFile(".github/workflows/reusable-implement.yml", "utf8");
  const supervise = await readFile(".github/workflows/reusable-supervise.yml", "utf8");
  invariant(implement.includes("permission-profile: \":workspace\"") && implement.includes("persist-credentials: false"), "SECURITY_REGRESSION", "Implementation model isolation is missing");
  invariant(supervise.includes("ZAI_API_KEY") && supervise.includes("REVIEW_COVERAGE_INCOMPLETE") === false, "DISTRIBUTION_INCOMPLETE", "Supervisor wiring is missing");
  invariant(supervise.includes("publish_repair:") && supervise.includes("Record human-gated ready state") && supervise.includes("Record fail-closed human intervention state"), "DISTRIBUTION_INCOMPLETE", "Supervisor state machine is incomplete");
  invariant(!implement.includes("merge") && !supervise.includes("merge_pull_request"), "FORBIDDEN_CAPABILITY", "Factory workflows must not merge");

  JSON.parse(await readFile("schemas/project.schema.json", "utf8"));
  JSON.parse(await readFile("templates/consumer/.ai-factory/project.json", "utf8"));
  process.stdout.write(`Validated ${workflows.length} active workflows and ${scripts.length} runtime modules.\n`);
});
