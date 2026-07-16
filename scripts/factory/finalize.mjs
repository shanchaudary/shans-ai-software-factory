#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { GitHubApi } from "./github-api.mjs";
import { FACTORY_LABELS, setFactoryState, upsertFactoryComment } from "./state.mjs";
import { invariant, main, readJson, sha256 } from "./lib.mjs";
import { readFile } from "node:fs/promises";

await main(async () => {
  const mode = process.env.FACTORY_FINALIZE_MODE;
  invariant(["ready", "block", "ignore"].includes(mode), "INVALID_MODE", "FACTORY_FINALIZE_MODE must be ready, block, or ignore");
  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  const context = await readJson(process.env.FACTORY_CONTEXT_PATH);
  const github = new GitHubApi();
  const pr = await github.getPull(context.pr.number);
  invariant(pr.state === "open" && pr.head.sha === context.pr.head_sha, "STALE_HEAD", "Pull request changed before final state publication");

  if (mode === "ignore") return;
  if (mode === "ready") {
    const reviewPath = process.env.FACTORY_REVIEW_PATH;
    invariant(reviewPath, "MISSING_REVIEW", "Ready state requires an independent review report");
    const bytes = await readFile(reviewPath);
    const review = JSON.parse(bytes.toString("utf8"));
    invariant(review.verdict === "clear" && review.coverage?.complete === true, "INVALID_REVIEW", "Ready state requires a clear, complete review");
    invariant(review.head_sha === pr.head.sha && review.base_sha === pr.base.sha, "STALE_REVIEW", "Independent review does not match current pull request commits");
    await setFactoryState(github, pr, { state: FACTORY_LABELS.ready.name, attempt: context.repair_attempt });
    await github.createStatus(pr.head.sha, { state: "success", context: "ai-factory/supervision", description: "Consumer CI passed; complete independent review passed" });
    await upsertFactoryComment(github, pr.number, `## Factory supervision\n\n- State: **ready for Shan's review**\n- Consumer CI: **passed** ([run](${context.run.url}))\n- Independent GLM review: **clear**\n- Review coverage: ${review.coverage.files} files, ${review.coverage.segments} segments, ${review.coverage.batches} batches\n- Reviewed diff SHA-256: \`${review.full_diff_sha256}\`\n- Review artifact SHA-256: \`${sha256(bytes)}\`\n- Advisory findings: ${review.findings.length}\n- Repair cycles used: ${context.repair_attempt}/${config.limits.max_repair_cycles}\n- Merge/deploy: **human only**`);
    return;
  }

  const reason = String(process.env.FACTORY_BLOCK_REASON ?? context.reason ?? "Factory stopped fail-closed").slice(0, 4000);
  await setFactoryState(github, pr, { state: FACTORY_LABELS.needs.name, attempt: context.repair_attempt });
  await github.createStatus(pr.head.sha, { state: "error", context: "ai-factory/supervision", description: "Factory stopped fail-closed; human intervention required" });
  await upsertFactoryComment(github, pr.number, `## Factory supervision\n\n- State: **needs Shan**\n- Reason: ${reason}\n- Head: \`${pr.head.sha}\`\n- Repair cycles used: ${context.repair_attempt}/${config.limits.max_repair_cycles}\n- Workflow run: ${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}\n- Merge/deploy: **blocked**`);
});
