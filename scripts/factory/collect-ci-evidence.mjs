#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { GitHubApi } from "./github-api.mjs";
import { invariant, main, parsePositiveInteger, readJson, redact, writeJsonAtomic } from "./lib.mjs";

const MAX_LOG_BYTES = 64 * 1024 * 1024;

await main(async () => {
  const runId = parsePositiveInteger(process.env.FACTORY_RUN_ID, "FACTORY_RUN_ID");
  const context = await readJson(process.env.FACTORY_CONTEXT_PATH);
  const outputPath = process.env.FACTORY_EVIDENCE_OUTPUT ?? `${process.env.RUNNER_TEMP ?? "."}/factory-ci-evidence.json`;
  await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  const github = new GitHubApi();
  const [run, jobsResponse] = await Promise.all([github.getRun(runId), github.getJobs(runId)]);
  invariant(run.id === context.run.id && run.head_sha === context.run.head_sha, "STALE_CI", "CI run changed relative to supervision context");
  const failedJobs = (jobsResponse.jobs ?? []).filter((job) => ["failure", "timed_out", "action_required", "startup_failure", "stale"].includes(job.conclusion));
  const logs = [];
  let totalBytes = 0;
  for (const job of failedJobs) {
    const bytes = await github.getJobLogs(job.id);
    totalBytes += bytes.length;
    invariant(totalBytes <= MAX_LOG_BYTES, "CI_LOG_LIMIT", `Failed CI logs exceed ${MAX_LOG_BYTES} bytes; refusing to truncate evidence`);
    logs.push({
      job_id: job.id,
      name: job.name,
      conclusion: job.conclusion,
      started_at: job.started_at,
      completed_at: job.completed_at,
      steps: (job.steps ?? []).map((step) => ({ name: step.name, conclusion: step.conclusion, number: step.number })),
      log: redact(bytes.toString("utf8")),
    });
  }
  if (run.conclusion === "failure") invariant(logs.length > 0, "INCOMPLETE_CI_EVIDENCE", "CI failed but GitHub returned no failed-job logs");
  const evidence = {
    schema_version: 1,
    run: {
      id: run.id,
      url: run.html_url,
      name: run.name,
      event: run.event,
      conclusion: run.conclusion,
      head_sha: run.head_sha,
      attempt: run.run_attempt,
      created_at: run.created_at,
      updated_at: run.updated_at,
    },
    total_jobs: (jobsResponse.jobs ?? []).length,
    failed_jobs: logs,
    evidence_complete: true,
  };
  await writeJsonAtomic(outputPath, evidence);
});
