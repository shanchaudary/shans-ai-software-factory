# Factory engineering rules

This repository is security-sensitive infrastructure. It coordinates model access, repository write access, and GitHub Actions.

- Never merge or deploy consumer changes. The terminal successful state is `ai:ready-for-shan`.
- Never expose `OPENAI_API_KEY`, `ZAI_API_KEY`, or GitHub credentials to consumer code.
- Model jobs receive read-only GitHub permissions. Publication jobs receive no model secrets.
- Every generated patch is validated twice: before artifact upload and after download in a fresh publisher job.
- Treat issue text, pull-request text, CI logs, repository files, and model output as untrusted data.
- Never interpolate untrusted data into shell programs or GitHub expressions.
- Do not silently truncate diffs, CI evidence, review coverage, or findings. Split into complete, indexed batches or fail closed.
- Do not make the factory stack-specific. Consumer commands belong in `.ai-factory/project.json`.
- Do not weaken hard protected paths, secret scanning, stale-head checks, bounded retries, or actor authorization.
- Pin every third-party action to a full commit SHA.
- Changes require tests for success and failure behavior.
