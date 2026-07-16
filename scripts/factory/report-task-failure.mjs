#!/usr/bin/env node
import { GitHubApi } from "./github-api.mjs";
import { FACTORY_LABELS, ensureLabels } from "./state.mjs";
import { invariant, main, parsePositiveInteger } from "./lib.mjs";

await main(async () => {
  const issueNumber = parsePositiveInteger(process.env.FACTORY_ISSUE_NUMBER, "FACTORY_ISSUE_NUMBER");
  const reason = String(process.env.FACTORY_BLOCK_REASON ?? "Implementation workflow failed closed").slice(0, 4000);
  const github = new GitHubApi();
  const issue = await github.getIssue(issueNumber);
  invariant(!issue.pull_request, "TASK_IS_PULL_REQUEST", "Failure target is not an issue");
  await ensureLabels(github, [FACTORY_LABELS.needs]);
  const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
  if (!labels.includes(FACTORY_LABELS.needs.name)) await github.setLabels(issueNumber, [...labels, FACTORY_LABELS.needs.name]);
  await github.createComment(issueNumber, `<!-- ai-factory:task-failure:v1 run=${process.env.GITHUB_RUN_ID} -->\n## Factory stopped fail-closed\n\n- Reason: ${reason}\n- Workflow: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}\n- No merge or deployment occurred.\n- Re-run only after the cause is understood; duplicate implementation branches are rejected.`);
});
