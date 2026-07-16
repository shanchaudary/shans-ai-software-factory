#!/usr/bin/env node
import { loadConfig, loadContext } from "./config.mjs";
import { githubOutput, invariant, main, readJson } from "./lib.mjs";
import { runGlmReview } from "./glm.mjs";

await main(async () => {
  const reviewDirectory = process.env.FACTORY_REVIEW_DIRECTORY;
  const contextPath = process.env.FACTORY_CONTEXT_PATH;
  invariant(reviewDirectory && contextPath, "MISSING_INPUT", "Review directory and context path are required");
  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  const context = await readJson(contextPath);
  const repositoryContext = await loadContext(config);
  const outputPath = process.env.FACTORY_REVIEW_OUTPUT ?? `${process.env.RUNNER_TEMP ?? "."}/factory-review-report.json`;
  const report = await runGlmReview({ apiKey: process.env.ZAI_API_KEY, config, reviewDirectory, context, repositoryContext, outputPath });
  await githubOutput("verdict", report.verdict);
  await githubOutput("report_path", outputPath);
  await githubOutput("blocking_count", report.blocking_findings.length);
});
