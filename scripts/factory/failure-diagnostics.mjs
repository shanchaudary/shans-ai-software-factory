import { redact } from "./lib.mjs";

const MAX_LINES = 10;
const MAX_LINE_LENGTH = 600;
const MAX_SUMMARY_LENGTH = 3500;

const STRONG_DIAGNOSTIC_PATTERNS = [
  /##\[error\]/i,
  /(?:^|\s)(?:error|fatal):/i,
  /\b(?:unauthorized|forbidden|permission denied|authentication failed|invalid api key|invalid_api_key|insufficient_quota|quota exceeded|rate limit|model[^\n]{0,80}not found|unsupported model|context length|request timed out|network is unreachable|connection refused)\b/i,
  /\b(?:HTTP|status(?: code)?)\s*(?:400|401|403|404|409|422|429|500|502|503|504)\b/i,
  /\b(?:failed to|exited with code|process completed with exit code)\b/i,
];

const GENERIC_EXIT_PATTERNS = [
  /process completed with exit code/i,
  /exited with code/i,
];

function stripControlSequences(value) {
  return String(value)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function escapeIssueText(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function normalizeLine(value) {
  const withoutTimestamp = stripControlSequences(value)
    .replace(/^\s*\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/, "")
    .replace(/^\s*##\[error\]\s*/, "Error: ")
    .trim();
  const additionallyRedacted = redact(withoutTimestamp)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [REDACTED]")
    .replace(/\bAuthorization:\s*[^\s]+(?:\s+[^\s]+)?/gi, "Authorization: [REDACTED]");
  return escapeIssueText(additionallyRedacted).slice(0, MAX_LINE_LENGTH);
}

function relevantLogRegion(logText) {
  const text = String(logText ?? "");
  const markers = [
    "Running: CODEX_HOME=",
    "Run codex exec",
    "Run pinned Codex implementation engine",
    "Run pinned Codex repair engine",
  ];
  const start = Math.max(...markers.map((marker) => text.lastIndexOf(marker)));
  return start >= 0 ? text.slice(start) : text;
}

export function extractFailureDiagnosticLines(logText) {
  const lines = relevantLogRegion(logText).split(/\r?\n/).slice(-600);
  const selected = [];
  const seen = new Set();

  for (const rawLine of lines) {
    if (!STRONG_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(rawLine))) continue;
    const line = normalizeLine(rawLine);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    selected.push(line);
  }

  const specific = selected.filter((line) => !GENERIC_EXIT_PATTERNS.some((pattern) => pattern.test(line)));
  const output = specific.length > 0 ? specific : selected;
  return output.slice(-MAX_LINES);
}

export async function summarizeFailedRun(github, runId) {
  const response = await github.getJobs(runId);
  const failedJobs = (response.jobs ?? []).filter((job) => job?.conclusion === "failure");
  const summaries = [];

  for (const job of failedJobs) {
    let log;
    try {
      log = await github.getJobLogs(job.id);
    } catch {
      continue;
    }
    const lines = extractFailureDiagnosticLines(Buffer.isBuffer(log) ? log.toString("utf8") : String(log));
    if (lines.length === 0) continue;
    const safeName = normalizeLine(job.name ?? `job ${job.id}`) || `job ${job.id}`;
    summaries.push(`Failed job: ${safeName}\n${lines.map((line) => `- ${line}`).join("\n")}`);
  }

  if (summaries.length === 0) return null;
  return summaries.join("\n\n").slice(0, MAX_SUMMARY_LENGTH);
}
