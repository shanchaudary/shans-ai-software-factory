import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { invariant, run, sha256, writeJsonAtomic } from "./lib.mjs";

function parseNameStatusZ(output) {
  const records = output.split("\0");
  if (records.at(-1) === "") records.pop();
  const files = [];
  for (let index = 0; index < records.length;) {
    const status = records[index++];
    invariant(/^[ACDMRTUXB][0-9]*$/.test(status), "DIFF_PARSE_FAILED", `Invalid name-status record: ${status}`);
    const oldPath = records[index++];
    invariant(oldPath, "DIFF_PARSE_FAILED", "Name-status record has no path");
    if (/^[RC]/.test(status)) {
      const path = records[index++];
      invariant(path, "DIFF_PARSE_FAILED", "Rename/copy record has no destination");
      files.push({ old_path: oldPath, path });
    } else files.push({ old_path: oldPath, path: oldPath });
  }
  return files;
}

function splitDiffByFile(diff, names) {
  const parts = diff.split(/(?=^diff --git )/m).filter((part) => part.length > 0);
  invariant(parts.length > 0 && parts.every((part) => part.startsWith("diff --git ")), "DIFF_PARSE_FAILED", "Could not split pull-request diff by file");
  invariant(parts.length === names.length, "DIFF_PARSE_FAILED", `Text diff has ${parts.length} file blocks but name-status has ${names.length}`);
  return parts.map((text, index) => ({ ...names[index], text }));
}

function splitOversizeText(text, maxBytes) {
  const lines = text.match(/.*(?:\n|$)/g)?.filter(Boolean) ?? [];
  const parts = [];
  let current = "";
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line);
    invariant(lineBytes <= maxBytes, "REVIEW_BATCH_LIMIT", "A single diff line exceeds the configured review batch size; raise the explicit limit rather than truncating it");
    if (current && Buffer.byteLength(current) + lineBytes > maxBytes) {
      parts.push(current);
      current = "";
    }
    current += line;
  }
  if (current) parts.push(current);
  return parts;
}

export async function prepareReviewBatches({ config, root = process.cwd(), baseSha, headSha, outputDirectory }) {
  invariant(/^[0-9a-f]{40}$/.test(baseSha) && /^[0-9a-f]{40}$/.test(headSha), "INVALID_SHA", "Review requires full base and head SHAs");
  const head = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  invariant(head === headSha, "STALE_HEAD", `Review checkout ${head} does not match ${headSha}`);
  const diffResult = await run("git", ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--find-renames", "--find-copies", "--unified=80", baseSha, headSha], { cwd: root, maxBytes: config.limits.max_patch_bytes * 8 });
  invariant(diffResult.stdout.length > 0, "EMPTY_DIFF", "Pull request has no textual diff to review");
  const binaryResult = await run("git", ["diff", "--numstat", "-z", baseSha, headSha], { cwd: root });
  invariant(!binaryResult.stdout.split("\0").some((entry) => entry.startsWith("-\t-\t")), "BINARY_REVIEW_REJECTED", "Complete independent review does not accept opaque binary changes");
  const namesResult = await run("git", ["-c", "core.quotePath=false", "diff", "--name-status", "-z", "--find-renames", "--find-copies", baseSha, headSha], { cwd: root });
  const files = splitDiffByFile(diffResult.stdout, parseNameStatusZ(namesResult.stdout));
  invariant(files.length <= config.limits.max_changed_files, "TOO_MANY_FILES", `PR has ${files.length} changed files; limit is ${config.limits.max_changed_files}`);
  const segments = [];
  for (const file of files) {
    const parts = splitOversizeText(file.text, config.limits.max_review_batch_bytes);
    parts.forEach((text, partIndex) => segments.push({
      segment_id: `segment-${String(segments.length + 1).padStart(4, "0")}`,
      path: file.path,
      old_path: file.old_path,
      part: partIndex + 1,
      parts: parts.length,
      bytes: Buffer.byteLength(text),
      sha256: sha256(text),
      diff: text,
    }));
  }

  const batches = [];
  let current = [];
  let currentBytes = 0;
  for (const segment of segments) {
    if (current.length > 0 && currentBytes + segment.bytes > config.limits.max_review_batch_bytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(segment);
    currentBytes += segment.bytes;
  }
  if (current.length) batches.push(current);
  await mkdir(outputDirectory, { recursive: true });
  const batchRecords = [];
  for (let index = 0; index < batches.length; index += 1) {
    const id = `batch-${String(index + 1).padStart(4, "0")}`;
    const record = {
      schema_version: 1,
      batch_id: id,
      batch_number: index + 1,
      batch_count: batches.length,
      base_sha: baseSha,
      head_sha: headSha,
      files: [...new Set(batches[index].map((segment) => segment.path))],
      segments: batches[index],
    };
    const path = join(outputDirectory, `${id}.json`);
    await writeJsonAtomic(path, record);
    batchRecords.push({ batch_id: id, path: `${id}.json`, sha256: sha256(await readFile(path)), segments: record.segments.map(({ segment_id, path: segmentPath, sha256: segmentSha }) => ({ segment_id, path: segmentPath, sha256: segmentSha })) });
  }
  const manifest = {
    schema_version: 1,
    base_sha: baseSha,
    head_sha: headSha,
    full_diff_sha256: sha256(diffResult.stdout),
    full_diff_bytes: Buffer.byteLength(diffResult.stdout),
    files: files.map((file) => file.path),
    segment_count: segments.length,
    batch_count: batches.length,
    batches: batchRecords,
  };
  await writeJsonAtomic(join(outputDirectory, "manifest.json"), manifest);
  return manifest;
}
