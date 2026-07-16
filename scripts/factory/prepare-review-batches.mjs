#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { githubOutput, invariant, main } from "./lib.mjs";
import { prepareReviewBatches } from "./review.mjs";

await main(async () => {
  const baseSha = process.env.FACTORY_BASE_SHA;
  const headSha = process.env.FACTORY_HEAD_SHA;
  invariant(baseSha && headSha, "MISSING_INPUT", "FACTORY_BASE_SHA and FACTORY_HEAD_SHA are required");
  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  const outputDirectory = process.env.FACTORY_REVIEW_DIRECTORY ?? `${process.env.RUNNER_TEMP ?? "."}/factory-review`;
  const manifest = await prepareReviewBatches({ config, baseSha, headSha, outputDirectory });
  await githubOutput("review_directory", outputDirectory);
  await githubOutput("batch_count", manifest.batch_count);
  await githubOutput("full_diff_sha256", manifest.full_diff_sha256);
});
