# Security model

## Trust boundaries

| Data or component | Trust treatment |
|---|---|
| Pinned factory workflow/runtime | Trusted only at the installed full commit SHA |
| Consumer default-branch config | Repository-controlled trusted policy |
| Issue, PR body, labels, context, source, diff, logs | Untrusted input |
| Codex and GLM output | Untrusted proposal requiring deterministic validation |
| `OPENAI_API_KEY` and `ZAI_API_KEY` | Consumer-repository secrets; never centralized |
| Publisher `GITHUB_TOKEN` | Write capability isolated from models and consumer execution |

## Credential separation

- `OPENAI_API_KEY` exists only as an input to the pinned official Codex action. The action proxies the Responses API and removes the upstream key from the model process environment.
- Setup, Codex, and verification run under three different unprivileged Linux users. Untrusted project commands never execute as the runner identity that owns the workflow.
- `ZAI_API_KEY` exists only on the single immutable GLM runtime step. That job never executes consumer commands.
- Publisher jobs receive no model keys and never run setup, tests, builds, hooks, or consumer executables.
- The central repository stores no consumer secrets. GitHub does not pass secrets from the factory repository into callers.

## Supply-chain controls

- Every third-party action is pinned to a 40-character commit SHA.
- The caller pins the reusable workflow and passes the identical full SHA. Each privileged job verifies the checked-out runtime commit before execution.
- Codex CLI is pinned to `0.144.5`; upgrades require a factory change and tests.
- Model-generated workflow, action, config, instruction, environment, key, credential, symlink, submodule, and binary changes are blocked.
- Setup must be side-effect-free relative to Git. Dependency install scripts can run only as `factorysetup`, before model credentials exist.
- The consumer must protect its default branch and require its CI plus `ai-factory/supervision` before human merge.

## Prompt injection and provenance

Task text, repository instructions, context, diffs, and logs are explicitly delimited as untrusted data. Deterministic code—not either model—decides authorization, paths, limits, completeness, stale state, review coverage, retries, publication, and final state.

The supervisor does not trust event payload alone. It re-fetches GitHub state and requires an Actions-dispatched CI run, Actions-created draft PR, same-repository branch, exact issue-derived branch name, live issue authorization, latest `ai:build` label actor, and sequential factory commit history. A fork, manual commit, edited governance file, removed authorization, moved head, or rewritten retry label stops the workflow.

## Failure behavior

The system is fail-closed. It never converts missing evidence into success. API errors, quota exhaustion, timeouts, malformed JSON, incomplete batches, absent logs, invalid config, unsupported conclusions, stale heads, retry exhaustion, and unsafe changes leave a failing status or `ai:needs-shan`. A cancelled obsolete CI run is ignored; it is not labeled as a product defect.

Artifacts are retained for 14 days. PR status comments record run links and cryptographic hashes, but hashes are evidence identifiers—not signatures. GitHub audit logs, branch protection, secret scanning, and organization policy remain required controls.

## Deliberate exclusions

The factory cannot merge, enable auto-merge, deploy, rotate secrets, alter branch protection, approve its own PR, or bypass required reviews. Black-risk work is rejected. Examples include destructive data migrations without a separately approved plan, authentication/authorization redesign, payments movement, secret handling changes, production infrastructure deletion, and any task whose failure could create unrecoverable loss.
