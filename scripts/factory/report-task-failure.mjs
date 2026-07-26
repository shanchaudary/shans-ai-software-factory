#!/usr/bin/env node
import { GitHubApi } from "./github-api.mjs";
import { summarizeFailedRun } from "./failure-diagnostics.mjs";
import { FACTORY_LABELS, ensureLabels } from "./state.mjs";
import { invariant, main, parsePositiveInteger } from "./lib.mjs";

await main(async () => {
  const issueNumber = parsePositiveInteger(process.env.FACTORY_ISSUE_NUMBER, "FACTORY_ISSUE_NUMBER");
  const runId = parsePositiveInteger(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const reason = String(process.env.FACTORY_BLOCK_REASON ?? "Implementation workflow failed closed").slice(0, 4000);
  const github = new GitHubApi();
  const issue = await github.getIssue(issueNumber);
  invariant(!issue.pull_request, "TASK_IS_PULL_REQUEST", "Failure target is not an issue");
  await ensureLabels(github, [FACTORY_LABELS.needs]);
  const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
  if (!labels.includes(FACTORY_LABELS.needs.name)) await github.setLabels(issueNumber, [...labels, FACTORY_LABELS.needs.name]);

  let diagnostic = null;
  try {
    diagnostic = await summarizeFailedRun(github, runId);
  } catch {
    // Diagnostic retrieval is best-effort. The factory must still publish the
    // original fail-closed state when GitHub logs are unavailable.
  }

  const diagnosticSection = diagnostic
    ? `\n\n### Bounded redacted diagnostic\n\n${diagnostic}\n\nThe diagnostic is extracted from failed job logs and is not a success inference.`
    : "";
  await github.createComment(issueNumber, `<!-- ai-factory:task-failure:v2 run=${runId} -->\n## Factory stopped fail-closed\n\n- Reason: ${reason}\n- Workflow: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${runId}\n- No merge or deployment occurred.${diagnosticSection}\n- Re-run only after the cause is understood; duplicate implementation branches are rejected.`);
});
