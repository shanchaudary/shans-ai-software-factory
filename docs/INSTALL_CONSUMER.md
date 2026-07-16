# Install a consumer repository

Do this through a reviewed human-authored pull request. The factory cannot install or merge itself.

## 1. Prepare the repository

The repository needs a deterministic CI workflow on the default branch. Its YAML filename and top-level `name` must remain stable. Add `workflow_dispatch` with optional string inputs `factory_pr` and `factory_issue`; the publisher uses them when explicitly dispatching CI because pushes made by `GITHUB_TOKEN` do not recursively trigger normal push/PR workflows.

Example trigger addition (merge it into the existing CI; do not replace real triggers or jobs):

```yaml
on:
  pull_request:
  push:
    branches: [main]
  workflow_dispatch:
    inputs:
      factory_pr:
        required: false
        type: string
      factory_issue:
        required: false
        type: string
```

CI must test the checked-out ref on `workflow_dispatch`, run the full authoritative gates, use least-privilege `contents: read`, and have no deployment job. Keep deployments in a different human-controlled workflow.

Create or strengthen root `AGENTS.md` with the repository's architecture, invariants, generated-code rules, test commands, data/migration constraints, and module ownership. The engine protects every `AGENTS.md` from generated changes.

## 2. Install and configure files

Copy these templates into their corresponding paths:

- `templates/consumer/.ai-factory/project.json`
- `templates/consumer/.github/workflows/ai-implement.yml`
- `templates/consumer/.github/workflows/ai-supervise.yml`
- `templates/consumer/.github/ISSUE_TEMPLATE/ai-task.yml`

Replace every installation placeholder. The runtime deliberately rejects placeholder commands. Configure real repository-local setup commands and the complete ordered verification set: formatting check, lint, typecheck, unit tests, integration tests, migration/schema validation, build, or other applicable gates. Do not use `|| true`, warning ceilings, skipped suites, or commands that mutate tracked files.

Set the supervisor template's workflow name to the exact top-level `name` of the CI workflow. Set `ci_workflow` to its YAML filename.

## 3. Pin the factory

Merge a reviewed factory release to `main`, take its full 40-character commit SHA, and place the same SHA in both locations in each thin caller:

```yaml
uses: shanchaudary/shans-ai-software-factory/.github/workflows/reusable-implement.yml@0123456789abcdef0123456789abcdef01234567
with:
  factory_ref: 0123456789abcdef0123456789abcdef01234567
```

Never pin a branch or moving tag. Upgrade all consumers through normal reviewed PRs after central CI passes.

## 4. Add repository secrets

In each consumer repository, add:

- `OPENAI_API_KEY` for the OpenAI API used by the official Codex action;
- `ZAI_API_KEY` for the Z.AI Coding Plan endpoint used by GLM review.

Do not add these secrets to the central factory repository, source files, config, issue text, or chat. Set provider-side hard spend limits and alerts. Repository secrets are exposed only to the reusable jobs that explicitly declare them.

## 5. Add branch protection

Protect the default branch. Require pull requests, human review, the existing CI checks, and `ai-factory/supervision`. Block force pushes and branch deletion. Do not grant the factory a bypass. Keep the generated PR draft until manual review.

## 6. Validate installation before live use

- Run the consumer CI manually on a harmless branch and confirm the supervisor ignores it because it was not Actions-dispatched by the factory.
- Run an unauthorized issue and confirm it is rejected.
- Confirm black risk is rejected.
- Confirm setup leaves Git clean and all real verification commands run.
- Confirm generated changes to `.github`, `.ai-factory`, `AGENTS.md`, credentials, binaries, symlinks, and submodules are rejected.
- Run a material pilot issue and inspect every artifact/status transition.

Repeat for three projects independently. The factory is not accepted until all three material pilots meet [the operating acceptance standard](OPERATING_MODEL.md#evidence-required-for-factory-acceptance).
