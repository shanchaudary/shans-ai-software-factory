#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { githubOutput, main } from "./lib.mjs";

await main(async () => {
  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  await githubOutput("project_id", config.project_id);
  await githubOutput("default_branch", config.default_branch);
  await githubOutput("ci_workflow", config.ci_workflow);
  await githubOutput("codex_model", config.implementation.model);
  await githubOutput("codex_effort", config.implementation.reasoning_effort);
  await githubOutput("max_repair_cycles", config.limits.max_repair_cycles);
  await githubOutput("allowed_actors", config.allowed_actors.join(","));
});
