#!/usr/bin/env node
import { loadConfig, HARD_PROTECTED_PATHS } from "./config.mjs";
import { invariant, main, run } from "./lib.mjs";
import { isProtectedPath } from "./patch.mjs";

await main(async () => {
  const base = process.env.FACTORY_BASE_SHA;
  const head = process.env.FACTORY_HEAD_SHA;
  invariant(/^[0-9a-f]{40}$/.test(base ?? "") && /^[0-9a-f]{40}$/.test(head ?? ""), "INVALID_SHA", "Managed diff validation requires full base and head SHAs");
  const actual = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
  invariant(actual === head, "STALE_HEAD", `Managed checkout ${actual} does not match ${head}`);
  const namesResult = await run("git", ["diff", "--name-only", "-z", base, head]);
  const paths = namesResult.stdout.split("\0").filter(Boolean);
  invariant(paths.length > 0, "EMPTY_DIFF", "Managed pull request has no changed files");
  for (const path of paths) {
    invariant(!path.includes("\\") && !/[\x00-\x1f\x7f]/.test(path), "UNSAFE_PATH", `Managed pull request contains an unsafe path: ${JSON.stringify(path)}`);
    invariant(!isProtectedPath(path, HARD_PROTECTED_PATHS), "PROTECTED_PATH", `Managed pull request contains governance/configuration change: ${path}`);
  }

  const config = await loadConfig(process.env.FACTORY_CONFIG ?? ".ai-factory/project.json");
  invariant(paths.length <= config.limits.max_changed_files, "TOO_MANY_FILES", `Managed pull request changes ${paths.length} files; limit is ${config.limits.max_changed_files}`);
  for (const path of paths) invariant(!isProtectedPath(path, config.protected_paths), "PROTECTED_PATH", `Managed pull request changes configured protected path: ${path}`);
  const numstat = await run("git", ["diff", "--numstat", "-z", base, head]);
  invariant(!numstat.stdout.split("\0").some((entry) => entry.startsWith("-\t-\t")), "BINARY_REVIEW_REJECTED", "Managed pull request contains an opaque binary change");
  const raw = await run("git", ["diff", "--raw", base, head]);
  invariant(!/^:\d+ 160000 /m.test(raw.stdout) && !/^:160000 \d+ /m.test(raw.stdout), "SUBMODULE_REJECTED", "Managed pull request contains a submodule change");
});
