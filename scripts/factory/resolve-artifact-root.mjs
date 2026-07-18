#!/usr/bin/env node
import { githubOutput, main, resolveTrustedArtifactRoot } from "./lib.mjs";

await main(async () => {
  const root = await resolveTrustedArtifactRoot(process.env.GITHUB_WORKSPACE, process.env.FACTORY_RUNTIME);
  await githubOutput("root", root);
});
