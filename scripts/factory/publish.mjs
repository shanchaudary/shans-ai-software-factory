#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { GitHubApi } from "./github-api.mjs";
import { githubOutput, invariant, main, readJson, run } from "./lib.mjs";
import { FACTORY_LABELS, ensureLabels, setFactoryState, stateMarker, taskDigest, upsertFactoryComment } from "./state.mjs";

function cleanTitle(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim().slice(0, 200);
}

async function remoteBranchSha(root, branch) {
  const result = await run("git", ["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { cwd: root });
  const line = result.stdout.trim();
  return line ? line.split(/\s+/)[0] : null;
}

async function commit(root, message) {
  await run("git", ["config", "user.name", "github-actions[bot]"], { cwd: root });
  await run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], { cwd: root });
  await run("git", ["commit", "--no-gpg-sign", "-m", message], { cwd: root });
  return (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
}

await main(async () => {
  const mode = process.env.FACTORY_PUBLISH_MODE;
  invariant(["implement", "repair-ci", "repair-review"].includes(mode), "INVALID_MODE", "FACTORY_PUBLISH_MODE is invalid");
  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  const supervisionContext = process.env.FACTORY_CONTEXT_PATH ? await readJson(process.env.FACTORY_CONTEXT_PATH) : null;
  invariant(process.env.FACTORY_TASK_PATH || supervisionContext?.task, "MISSING_INPUT", "Publication requires task data");
  const task = process.env.FACTORY_TASK_PATH ? await readJson(process.env.FACTORY_TASK_PATH) : supervisionContext.task;
  const expectedHead = process.env.FACTORY_EXPECTED_HEAD;
  const branch = process.env.FACTORY_BRANCH ?? `${config.branch_prefix}issue-${task.number}`;
  const attempt = Number(process.env.FACTORY_ATTEMPT ?? 0);
  invariant(Number.isInteger(attempt) && attempt >= 0 && attempt <= config.limits.max_repair_cycles, "INVALID_ATTEMPT", "Repair attempt is outside configured bounds");
  const github = new GitHubApi();
  await ensureLabels(github);

  const currentRemote = await remoteBranchSha(process.cwd(), branch);
  const defaultRemote = await remoteBranchSha(process.cwd(), config.default_branch);
  if (mode === "implement") invariant(currentRemote === null, "BRANCH_EXISTS", `Refusing to overwrite existing factory branch ${branch}`);
  else invariant(currentRemote === expectedHead, "STALE_HEAD", `Remote branch moved from ${expectedHead} to ${currentRemote ?? "missing"}`);
  if (mode === "implement") invariant(defaultRemote === expectedHead, "BASE_MOVED", `Default branch moved from ${expectedHead} to ${defaultRemote ?? "missing"} before publication`);
  else invariant(defaultRemote === supervisionContext?.pr?.base_sha, "BASE_MOVED", `Default branch moved from reviewed base ${supervisionContext?.pr?.base_sha ?? "unknown"} to ${defaultRemote ?? "missing"}`);

  let pr;
  if (mode !== "implement") {
    const prNumber = Number(process.env.FACTORY_PR_NUMBER);
    invariant(Number.isInteger(prNumber) && prNumber > 0, "INVALID_PR", "FACTORY_PR_NUMBER is required for repair publication");
    pr = await github.getPull(prNumber);
    invariant(pr.state === "open" && pr.head?.sha === expectedHead && pr.head?.ref === branch, "STALE_HEAD", "Pull request changed before repair publication");
  }

  const commitSha = await commit(process.cwd(), mode === "implement" ? `feat: implement issue #${task.number}` : `fix: factory repair ${attempt} for issue #${task.number}`);
  await run("git", ["push", "origin", `HEAD:refs/heads/${branch}`], { cwd: process.cwd() });

  if (mode === "implement") {
    const digest = taskDigest(task);
    const marker = stateMarker({ issue: task.number, project: config.project_id, authorizedBy: task.authorized_by, taskSha: digest });
    pr = await github.createPull({
      title: cleanTitle(`[AI] ${task.title}`),
      head: branch,
      base: config.default_branch,
      draft: true,
      maintainer_can_modify: true,
      body: `${marker}\n\nCloses #${task.number}\n\nThis draft was produced by the pinned AI Software Factory. It cannot merge or deploy itself. Consumer CI and independent review evidence will be recorded below.`,
    });
    await setFactoryState(github, pr, { state: FACTORY_LABELS.building.name, attempt: 0 });
    await github.createComment(task.number, `<!-- ai-factory:receipt:v1 pr=${pr.number} task_sha=${digest} branch=${branch} -->\nFactory authorization receipt for draft PR #${pr.number}. Task contract SHA-256: \`${digest}\`.`);
  } else {
    pr = await github.getPull(pr.number);
    invariant(pr.head?.sha === commitSha, "PUSH_NOT_VISIBLE", "Pull request head did not advance to the published repair commit");
    await setFactoryState(github, pr, { state: FACTORY_LABELS.building.name, attempt });
  }

  await github.createStatus(commitSha, {
    state: "pending",
    context: "ai-factory/supervision",
    description: "Awaiting consumer CI and independent review",
  });
  await upsertFactoryComment(github, pr.number, `## Factory supervision\n\n- State: **consumer CI dispatched**\n- Issue: #${task.number}\n- Head: \`${commitSha}\`\n- Repair cycle: ${attempt}/${config.limits.max_repair_cycles}\n- Merge/deploy: **human only**`);
  try {
    await github.dispatchWorkflow(config.ci_workflow, branch, { factory_pr: String(pr.number), factory_issue: String(task.number) });
  } catch (error) {
    const current = await github.getPull(pr.number);
    await setFactoryState(github, current, { state: FACTORY_LABELS.needs.name, attempt });
    await github.createStatus(commitSha, { state: "error", context: "ai-factory/supervision", description: "Consumer CI dispatch failed; human intervention required" });
    await upsertFactoryComment(github, pr.number, `## Factory supervision\n\n- State: **needs Shan**\n- Reason: consumer CI dispatch failed after publishing \`${commitSha}\`\n- Error class: \`${error.code ?? "UNEXPECTED"}\`\n- Merge/deploy: **blocked**`);
    throw error;
  }
  await githubOutput("pr_number", pr.number);
  await githubOutput("head_sha", commitSha);
  await githubOutput("branch", branch);
});
