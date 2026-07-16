#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { GitHubApi } from "./github-api.mjs";
import { githubOutput, invariant, main, parsePositiveInteger, writeJsonAtomic } from "./lib.mjs";
import { attemptFromLabels, parseStateMarker, taskDigest } from "./state.mjs";
import { RISK_LABELS } from "./task.mjs";

function validateLiveIssue(issue, events, config, marker) {
  invariant(issue.state === "open", "TASK_NOT_OPEN", `Managed issue #${issue.number} is no longer open`);
  invariant(!issue.pull_request, "TASK_IS_PULL_REQUEST", "Managed task resolved to a pull request");
  const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
  invariant(labels.includes("ai:build"), "TASK_AUTHORIZATION_REVOKED", "ai:build label was removed from the managed issue");
  const risks = labels.filter((label) => RISK_LABELS.includes(label));
  invariant(risks.length === 1 && risks[0] !== "ai:risk:black", "TASK_AUTHORIZATION_REVOKED", "Managed issue has an invalid or black risk label");
  invariant(config.allowed_actors.some((actor) => actor.toLowerCase() === marker.authorized_by.toLowerCase()), "TASK_AUTHORIZATION_REVOKED", "Original authorizing actor is no longer allowed");
  const buildEvents = events.filter((event) => event.event === "labeled" && event.label?.name === "ai:build");
  invariant(buildEvents.length > 0, "TASK_PROVENANCE_MISSING", "GitHub has no ai:build authorization event for this issue");
  const latestAuthorization = buildEvents.at(-1);
  invariant(latestAuthorization.actor?.login?.toLowerCase() === marker.authorized_by.toLowerCase(), "TASK_PROVENANCE_MISMATCH", "Latest ai:build label event actor does not match the factory marker");
  invariant(config.allowed_actors.some((actor) => actor.toLowerCase() === latestAuthorization.actor.login.toLowerCase()), "TASK_AUTHORIZATION_REVOKED", "Latest ai:build label actor is no longer allowed");
  return {
    schema_version: 1,
    number: issue.number,
    node_id: issue.node_id,
    url: issue.html_url,
    title: issue.title,
    body: issue.body,
    author: issue.user?.login,
    authorized_by: marker.authorized_by,
    risk: risks[0].slice("ai:risk:".length),
    labels,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}

await main(async () => {
  const runId = parsePositiveInteger(process.env.FACTORY_RUN_ID, "FACTORY_RUN_ID");
  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  const github = new GitHubApi();
  const run = await github.getRun(runId);
  invariant(run.repository?.full_name === github.repository, "RUN_REPOSITORY_MISMATCH", "Workflow run belongs to a different repository");
  invariant(run.path === `.github/workflows/${config.ci_workflow}`, "WRONG_WORKFLOW", `Run path ${run.path} is not configured CI workflow ${config.ci_workflow}`);
  invariant(run.status === "completed", "RUN_NOT_COMPLETE", "Factory only supervises completed CI runs");
  invariant(run.event === "workflow_dispatch" && run.actor?.login === "github-actions[bot]", "UNMANAGED_RUN", "Factory only supervises CI runs explicitly dispatched by its publisher token");
  invariant(typeof run.head_branch === "string" && run.head_branch.startsWith(config.branch_prefix), "UNMANAGED_BRANCH", "CI head is not a factory-managed branch");
  invariant(run.head_repository?.full_name === github.repository, "FORK_REJECTED", "Factory never supervises fork heads");
  invariant(/^[0-9a-f]{40}$/.test(run.head_sha ?? ""), "INVALID_SHA", "CI run has no full head SHA");

  const [owner] = github.repository.split("/");
  const pulls = await github.listPulls({ state: "open", head: `${owner}:${run.head_branch}`, base: config.default_branch });
  invariant(pulls.length === 1, "PR_RESOLUTION_FAILED", `Expected exactly one open pull request for ${run.head_branch}; found ${pulls.length}`);
  const pr = await github.getPull(pulls[0].number);
  invariant(pr.draft === true, "UNMANAGED_PR", "Factory-managed pull request must remain a draft until Shan decides otherwise");
  invariant(pr.user?.login === "github-actions[bot]", "UNMANAGED_PR", "Factory-managed pull request was not created by GitHub Actions");
  invariant(pr.head?.sha === run.head_sha, "STALE_CI", `CI tested ${run.head_sha}, but PR head is ${pr.head?.sha}`);
  invariant(pr.head?.repo?.full_name === github.repository, "FORK_REJECTED", "Pull request head is a fork");
  const labels = (pr.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
  invariant(labels.includes("ai:managed"), "UNMANAGED_PR", "Pull request is missing ai:managed label");
  const marker = parseStateMarker(pr.body);
  invariant(marker && marker.project === config.project_id, "UNMANAGED_PR", "Pull request factory marker is missing or does not match this project");
  invariant(pr.head.ref === `${config.branch_prefix}issue-${marker.issue}`, "UNMANAGED_PR", "Factory branch does not match its marked issue number");
  const [issue, events, comments, commits] = await Promise.all([github.getIssue(marker.issue), github.listIssueEvents(marker.issue), github.listComments(marker.issue), github.listPullCommits(pr.number)]);
  const task = validateLiveIssue(issue, events, config, marker);
  invariant(taskDigest(task) === marker.task_sha, "TASK_CONTRACT_CHANGED", "Issue contract changed after the implementation transaction was authorized");
  const receipt = `<!-- ai-factory:receipt:v1 pr=${pr.number} task_sha=${marker.task_sha} branch=${pr.head.ref} -->`;
  const receipts = comments.filter((comment) => comment.user?.login === "github-actions[bot]" && String(comment.body ?? "").includes(receipt));
  invariant(receipts.length === 1, "TASK_PROVENANCE_MISSING", `Expected one immutable Actions authorization receipt; found ${receipts.length}`);
  invariant(commits.length >= 1, "INVALID_STATE", "Managed pull request has no commits");
  commits.forEach((commit, index) => {
    const expected = index === 0 ? `feat: implement issue #${marker.issue}` : `fix: factory repair ${index} for issue #${marker.issue}`;
    invariant(commit.commit?.message === expected, "UNMANAGED_COMMIT", `Unexpected managed commit ${index + 1}: ${commit.commit?.message}`);
    invariant(commit.author?.login === "github-actions[bot]", "UNMANAGED_COMMIT", `Managed commit ${index + 1} is not attributed to GitHub Actions`);
    if (index > 0) invariant(commit.parents?.length === 1 && commit.parents[0].sha === commits[index - 1].sha, "UNMANAGED_COMMIT", `Managed repair commit ${index + 1} is not a linear child of the prior factory commit`);
  });
  const baseMoved = commits[0].parents?.length !== 1 || commits[0].parents[0].sha !== pr.base.sha;
  const attempt = attemptFromLabels(pr.labels ?? []);
  invariant(attempt === commits.length - 1, "INVALID_STATE", `Repair label ${attempt} does not match ${commits.length - 1} repair commits`);
  invariant(attempt <= config.limits.max_repair_cycles, "INVALID_STATE", "Recorded repair attempt exceeds project limit");

  let action;
  if (baseMoved) action = "block";
  else if (run.conclusion === "success") action = "review";
  else if (run.conclusion === "failure" || run.conclusion === "timed_out") action = attempt < config.limits.max_repair_cycles ? "repair-ci" : "block";
  else if (run.conclusion === "cancelled") action = "ignore";
  else action = "block";

  const context = {
    schema_version: 1,
    action,
    reason: action === "block" ? (baseMoved ? `Default branch moved after the factory branch was created; rebase/restart requires human review` : `CI conclusion ${run.conclusion} cannot progress at repair cycle ${attempt}/${config.limits.max_repair_cycles}`) : null,
    run: { id: run.id, url: run.html_url, conclusion: run.conclusion, head_sha: run.head_sha, head_branch: run.head_branch, attempt: run.run_attempt, event: run.event },
    pr: { number: pr.number, url: pr.html_url, title: pr.title, body: pr.body, base_sha: pr.base.sha, base_ref: pr.base.ref, head_sha: pr.head.sha, head_ref: pr.head.ref, labels },
    task,
    repair_attempt: attempt,
  };
  const outputPath = process.env.FACTORY_CONTEXT_OUTPUT ?? `${process.env.RUNNER_TEMP ?? "."}/factory-supervision-context.json`;
  await writeJsonAtomic(outputPath, context);
  await githubOutput("action", action);
  await githubOutput("context_path", outputPath);
  await githubOutput("pr_number", pr.number);
  await githubOutput("issue_number", task.number);
  await githubOutput("head_sha", pr.head.sha);
  await githubOutput("head_branch", pr.head.ref);
  await githubOutput("base_sha", pr.base.sha);
  await githubOutput("attempt", attempt);
  await githubOutput("next_attempt", attempt + 1);
  await githubOutput("reason", context.reason ?? "");
  await githubOutput("ci_conclusion", run.conclusion ?? "");
});
