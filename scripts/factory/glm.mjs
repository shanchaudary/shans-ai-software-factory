import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { invariant, readJson, sha256, writeJsonAtomic } from "./lib.mjs";
import { reviewBatchWithOpenCode } from "./opencode-glm.mjs";
const SEVERITIES = Object.freeze(["P0", "P1", "P2", "P3"]);
const CATEGORIES = Object.freeze(["correctness", "security", "reliability", "data-integrity", "concurrency", "performance", "compatibility", "maintainability", "testing", "requirements"]);

function validateFinding(finding, files, index) {
  invariant(finding && typeof finding === "object" && !Array.isArray(finding), "MALFORMED_REVIEW", `finding ${index} must be an object`);
  const allowed = ["severity", "category", "path", "line", "title", "evidence", "recommendation"];
  invariant(Object.keys(finding).every((key) => allowed.includes(key)), "MALFORMED_REVIEW", `finding ${index} has unsupported keys`);
  invariant(SEVERITIES.includes(finding.severity), "MALFORMED_REVIEW", `finding ${index} has invalid severity`);
  invariant(CATEGORIES.includes(finding.category), "MALFORMED_REVIEW", `finding ${index} has invalid category`);
  invariant(typeof finding.path === "string" && files.includes(finding.path), "MALFORMED_REVIEW", `finding ${index} path is not present in this review batch`);
  invariant(finding.line === null || (Number.isInteger(finding.line) && finding.line > 0), "MALFORMED_REVIEW", `finding ${index} line must be null or a positive integer`);
  for (const key of ["title", "evidence", "recommendation"]) invariant(typeof finding[key] === "string" && finding[key].trim().length >= 5, "MALFORMED_REVIEW", `finding ${index} ${key} is too short`);
  return finding;
}

export function validateReview(raw, batch) {
  invariant(raw && typeof raw === "object" && !Array.isArray(raw), "MALFORMED_REVIEW", "GLM review must be an object");
  const allowed = ["batch_id", "verdict", "summary", "findings"];
  invariant(Object.keys(raw).every((key) => allowed.includes(key)), "MALFORMED_REVIEW", "GLM review contains unsupported keys");
  invariant(raw.batch_id === batch.batch_id, "MALFORMED_REVIEW", "GLM returned the wrong batch_id");
  invariant(["clear", "findings"].includes(raw.verdict), "MALFORMED_REVIEW", "GLM verdict must be clear or findings");
  invariant(typeof raw.summary === "string" && raw.summary.trim().length >= 5, "MALFORMED_REVIEW", "GLM summary is missing");
  invariant(Array.isArray(raw.findings), "MALFORMED_REVIEW", "GLM findings must be an array");
  invariant((raw.verdict === "clear") === (raw.findings.length === 0), "MALFORMED_REVIEW", "GLM verdict conflicts with findings count");
  return { ...raw, findings: raw.findings.map((finding, index) => validateFinding(finding, batch.files, index)) };
}

export async function runGlmReview({ apiKey, config, reviewDirectory, context, repositoryContext, outputPath, reviewBatch = reviewBatchWithOpenCode }) {
  invariant(typeof apiKey === "string" && apiKey.length >= 20, "MISSING_ZAI_API_KEY", "ZAI_API_KEY is missing or implausibly short");
  const manifest = await readJson(join(reviewDirectory, "manifest.json"));
  invariant(manifest.schema_version === 1 && manifest.head_sha === context.pr.head_sha && manifest.base_sha === context.pr.base_sha, "REVIEW_CONTEXT_MISMATCH", "Review manifest does not match pull request context");
  const results = [];
  const coveredSegments = new Map();
  for (const record of manifest.batches) {
    const path = join(reviewDirectory, record.path);
    const bytes = await readFile(path);
    invariant(sha256(bytes) === record.sha256, "REVIEW_ARTIFACT_TAMPERED", `Review batch checksum failed: ${record.batch_id}`);
    const batch = JSON.parse(bytes.toString("utf8"));
    const result = await reviewBatch({ apiKey, model: config.review.model, batch, task: context.task, context, repositoryContext });
    results.push({ batch_id: record.batch_id, ...result, review: validateReview(result.review, batch) });
    for (const segment of batch.segments) {
      invariant(!coveredSegments.has(segment.segment_id), "REVIEW_COVERAGE_DUPLICATE", `Segment reviewed more than once: ${segment.segment_id}`);
      coveredSegments.set(segment.segment_id, segment.sha256);
    }
  }
  const expectedSegments = manifest.batches.flatMap((batch) => batch.segments);
  invariant(coveredSegments.size === manifest.segment_count && expectedSegments.every((segment) => coveredSegments.get(segment.segment_id) === segment.sha256), "REVIEW_COVERAGE_INCOMPLETE", "Independent review did not cover every exact diff segment");
  const findings = results.flatMap((result) => result.review.findings.map((finding) => ({ ...finding, batch_id: result.batch_id })));
  const blocking = findings.filter((finding) => config.review.blocking_severities.includes(finding.severity));
  const report = {
    schema_version: 1,
    verdict: blocking.length > 0 ? "blocking" : "clear",
    base_sha: manifest.base_sha,
    head_sha: manifest.head_sha,
    full_diff_sha256: manifest.full_diff_sha256,
    coverage: { complete: true, files: manifest.files.length, segments: manifest.segment_count, batches: manifest.batch_count },
    coverage_manifest: manifest,
    blocking_severities: config.review.blocking_severities,
    findings,
    blocking_findings: blocking,
    results,
    reviewed_at: new Date().toISOString(),
  };
  await writeJsonAtomic(outputPath, report);
  return report;
}
