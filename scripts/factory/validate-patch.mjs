#!/usr/bin/env node
import { loadConfig } from "./config.mjs";
import { githubOutput, invariant, main } from "./lib.mjs";
import { applyAndValidatePatch, capturePatch } from "./patch.mjs";

await main(async () => {
  const mode = process.env.FACTORY_PATCH_MODE;
  invariant(["capture", "apply"].includes(mode), "INVALID_MODE", "FACTORY_PATCH_MODE must be capture or apply");
  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  const expectedHead = process.env.FACTORY_EXPECTED_HEAD;
  invariant(/^[0-9a-f]{40}$/.test(expectedHead ?? ""), "INVALID_SHA", "FACTORY_EXPECTED_HEAD must be a full commit SHA");
  const patchPath = process.env.FACTORY_PATCH_PATH ?? `${process.env.RUNNER_TEMP ?? "."}/factory.patch`;
  const manifestPath = process.env.FACTORY_MANIFEST_PATH ?? `${process.env.RUNNER_TEMP ?? "."}/factory-patch-manifest.json`;
  const manifest = mode === "capture"
    ? await capturePatch({ config, expectedHead, patchPath, manifestPath })
    : await applyAndValidatePatch({ config, expectedHead, patchPath, manifestPath });
  await githubOutput("patch_path", patchPath);
  await githubOutput("manifest_path", manifestPath);
  await githubOutput("patch_sha256", manifest.patch_sha256);
  await githubOutput("changed_files", manifest.files.length);
});
