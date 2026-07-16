#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { GitHubApi } from "./github-api.mjs";
import { githubOutput, invariant, main, parsePositiveInteger, writeJsonAtomic } from "./lib.mjs";
import { validateTask } from "./task.mjs";

await main(async () => {
  const issueNumber = parsePositiveInteger(process.env.FACTORY_ISSUE_NUMBER, "FACTORY_ISSUE_NUMBER");
  const actor = process.env.FACTORY_TRIGGER_ACTOR;
  const outputPath = process.env.FACTORY_TASK_OUTPUT ?? `${process.env.RUNNER_TEMP ?? "."}/factory-task.json`;
  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  const github = new GitHubApi();
  const [issue, events] = await Promise.all([github.getIssue(issueNumber), github.listIssueEvents(issueNumber)]);
  const buildEvents = events.filter((event) => event.event === "labeled" && event.label?.name === "ai:build");
  invariant(buildEvents.length > 0, "TASK_PROVENANCE_MISSING", "GitHub has no ai:build label event for this task");
  const task = validateTask(issue, config, actor, buildEvents.at(-1).actor?.login);
  await writeJsonAtomic(outputPath, task);
  await githubOutput("task_path", outputPath);
  await githubOutput("issue_number", task.number);
  await githubOutput("risk", task.risk);
  await githubOutput("branch", `${config.branch_prefix}issue-${task.number}`);
});
