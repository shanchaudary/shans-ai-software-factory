# Operating model

## Task lifecycle

1. Create an issue from the AI task template.
2. Write objective production behavior and acceptance criteria. Include integration boundaries, data behavior, compatibility, failure modes, observability, tests, and explicit non-goals.
3. Apply exactly one risk label. `green`, `yellow`, and `red` are accepted by the engine; `black` is always rejected. Risk labels do not bypass human review.
4. An actor listed in `.ai-factory/project.json` applies `ai:build` last. This label event is the authorization record.
5. Watch the implementation workflow. A successful run produces a draft PR and dispatches consumer CI.
6. The supervisor automatically responds to the exact CI result. It may produce a repair and redispatch CI, or review the successful diff with GLM.
7. Act only when the PR shows `ai:ready-for-shan` and the `ai-factory/supervision` commit status is successful. Review the code, evidence, migrations, product behavior, cost, and deployment plan yourself.
8. Merge through the repository's normal protected process. Deployment remains the repository's existing human-controlled process.

## Stop conditions

`ai:needs-shan` means the engine has stopped. Read the status comment and linked run. Typical causes are missing/invalid secrets, dependency setup side effects, CI environment failure, incomplete logs, unsafe generated paths, manual commits, review API failure, blocking findings after the repair budget, or stale Git state.

Do not repeatedly rerun a failed task without understanding it. The engine refuses to overwrite an existing implementation branch. Correct the issue/config/environment or take over the draft PR manually; if taking over, remove `ai:managed` so the supervisor will no longer act.

## Three-project operation

Each repository has its own secrets, config, callers, issue queue, CI, labels, repair count, and concurrency namespace. Runs for `owner/project-a`, `owner/project-b`, and `owner/project-c` can proceed at the same time. Within one repository, implementation is serialized by issue and supervision is serialized by factory branch.

There is no shared token pool or budget manager. Configure provider usage limits and alerts at OpenAI and Z.AI. Use the project config to choose implementation model/effort and bound files, patch bytes, context, review batches, and repair cycles. Do not lower quality gates merely to save a failed run; fix the task contract or repository verification instead.

## Evidence required for factory acceptance

The central unit/integration suite is necessary but insufficient. Before calling the factory production-ready, run one material issue in each of three different repositories/stacks. Each trial must exercise real code and include:

- issue authorization and exact risk provenance;
- dependency setup and the complete project verification command set;
- a non-trivial implementation spanning the real entry point, domain logic, persistence/integration boundary, error handling, and tests where applicable;
- draft PR publication and explicit CI dispatch;
- at least one controlled failing-CI or blocking-review repair trial across the three pilots;
- complete GLM coverage evidence for the final diff;
- stale-head/manual-governance/failure-path rejection checks;
- final `ai:ready-for-shan` with no merge or deployment.

Record the issue, PR, workflow runs, provider cost, wall time, repair count, and any human intervention for each pilot. Only then tune defaults.
