# Architecture

## Authority model

The factory is a pinned reusable-workflow library. It has no application server, scheduler, database, hidden queue, or cross-project mutable state. A consumer repository owns all authoritative records:

| Concern | Authority |
|---|---|
| Task contract and authorization | Open GitHub issue, labels, and label event actor |
| Source and history | Consumer Git repository |
| Deterministic quality gates | Consumer CI workflow |
| Work isolation | GitHub-hosted job and factory branch |
| Repair budget | PR commit sequence plus `ai:repair:N` label |
| Review evidence | Immutable Actions artifacts, status, and PR status comment |
| Final decision | Shan through normal branch protection and review |

This avoids a second source of truth. Repository-scoped concurrency groups serialize one issue or PR while different repositories run independently.

## Implementation transaction

1. An allowed actor completes an issue, applies one non-black risk label, and finally applies `ai:build`.
2. The consumer's thin workflow calls `reusable-implement.yml` at a full factory commit SHA and passes that same SHA as `factory_ref`.
3. A read-only job checks out the consumer default branch and the exact factory commit. It copies only the immutable runtime outside the consumer checkout and removes the factory checkout.
4. The runtime validates the project config, issue state, risk, trigger actor, default branch, limits, and context files.
5. Project setup executes as the dedicated unprivileged `factorysetup` identity before any model key exists. Setup must leave the Git tree clean.
6. Codex runs as a different unprivileged identity, `factorycodex`, through the pinned official action and its Responses API proxy. It has workspace access but no write-capable GitHub token or network.
7. Verification executes as a third unprivileged identity, `factoryverify`.
8. The runtime rejects empty, oversized, protected, binary, submodule, symlink, credential-bearing, or stale-head changes. It stages the complete textual diff and writes a SHA-256 manifest.
9. A fresh publisher job downloads the immutable artifact, checks out the exact expected base, validates and applies the patch again, and checks that the recreated diff hash is identical.
10. The publisher creates one commit and one draft PR, records pending supervision state, and explicitly dispatches the consumer CI workflow. It never executes consumer code.

## Supervision transaction

1. The thin supervisor receives only completed runs from the configured CI workflow name.
2. The central inspector independently fetches the run and requires: the configured workflow path, `workflow_dispatch`, the GitHub Actions actor, same-repository head, exact factory branch, one open draft PR, `ai:managed`, a strict metadata marker, an allowed `ai:build` label event actor, factory-authored sequential commits, and a matching retry label.
3. Cancelled runs are ignored. Unsupported conclusions fail closed. Failed/timed-out runs enter repair only while the configured budget remains.
4. Every failed-job log is downloaded and redacted. More than 64 MiB of failed logs fails closed instead of truncating evidence.
5. A CI repair repeats the isolated Codex, verification, patch, fresh publication, and explicit CI-dispatch transaction.
6. Successful CI produces a complete diff from the exact base and head. The runtime rejects protected, binary, or submodule changes and splits the full textual diff into checksummed segments and batches without dropping bytes.
7. GLM reviews every segment with structured JSON. Each result must name the exact batch, use the schema and severity enums, and reference only a changed path. Missing, duplicated, altered, malformed, rate-limited, or incomplete results fail closed.
8. P0/P1/P2 findings block by default. Blocking findings consume a bounded Codex repair cycle and return to CI. Advisory P3 findings remain in the evidence.
9. A clear review writes a success commit status and `ai:ready-for-shan`. The PR stays draft. No factory path can merge or deploy.

## Project agnosticism

The engine knows nothing about Node, Python, Go, Rust, Java, databases, frameworks, or cloud providers. The consumer config supplies real setup and verification commands. Those commands must use repository-local toolchains and dependencies because privileged Docker, host mutation, global installs, and hidden external credentials are intentionally unavailable to untrusted model jobs.

Project-specific CI remains the production authority. A complex repository may run matrices, service containers, integration databases, browser tests, migrations, contract tests, security scanners, builds, or deployment previews in its own CI. The factory waits for the exact configured workflow conclusion and consumes its complete failed-job evidence.
