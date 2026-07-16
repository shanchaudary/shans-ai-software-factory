#!/usr/bin/env node
import { invariant, main, run } from "./lib.mjs";

await main(async () => {
  const status = await run("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  invariant(status.stdout.length === 0, "SETUP_MUTATED_REPOSITORY", "Project setup changed tracked or untracked repository files; setup must be reproducible and side-effect-free before Codex runs");
});
