import { invariant } from "./lib.mjs";

const ACTIONS_BOT = "github-actions[bot]";

export function supervisionDisposition(run, { repository, ciWorkflow, branchPrefix }) {
  invariant(run.repository?.full_name === repository, "RUN_REPOSITORY_MISMATCH", "Workflow run belongs to a different repository");
  invariant(run.status === "completed", "RUN_NOT_COMPLETE", "Factory only supervises completed CI runs");

  const isFactoryCandidate = run.event === "workflow_dispatch"
    && run.actor?.login === ACTIONS_BOT
    && typeof run.head_branch === "string"
    && run.head_branch.startsWith(branchPrefix);
  if (!isFactoryCandidate) return "ignore";

  invariant(run.path === `.github/workflows/${ciWorkflow}`, "WRONG_WORKFLOW", `Run path ${run.path} is not configured CI workflow ${ciWorkflow}`);
  invariant(run.triggering_actor?.login === ACTIONS_BOT, "UNMANAGED_RERUN", "Factory CI must be triggered by GitHub Actions, not manually rerun");
  invariant(run.run_attempt === 1, "UNMANAGED_RERUN", "Factory never supervises a rerun of an existing CI run");
  invariant(run.head_repository?.full_name === repository, "FORK_REJECTED", "Factory never supervises fork heads");
  invariant(/^[0-9a-f]{40}$/.test(run.head_sha ?? ""), "INVALID_SHA", "CI run has no full head SHA");
  return "inspect";
}
