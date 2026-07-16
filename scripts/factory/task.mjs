import { invariant } from "./lib.mjs";

export const RISK_LABELS = Object.freeze(["ai:risk:green", "ai:risk:yellow", "ai:risk:red", "ai:risk:black"]);

export function validateTask(issue, config, triggerActor, authorizationActor = triggerActor) {
  invariant(issue && typeof issue === "object", "INVALID_ISSUE", "Issue response is missing");
  invariant(!issue.pull_request, "TASK_IS_PULL_REQUEST", `#${issue.number} is a pull request, not a task issue`);
  invariant(issue.state === "open", "TASK_NOT_OPEN", `Issue #${issue.number} is not open`);
  const labels = (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name).filter(Boolean);
  invariant(labels.includes("ai:build"), "TASK_NOT_AUTHORIZED", "Issue is missing the ai:build label");
  const risks = labels.filter((label) => RISK_LABELS.includes(label));
  invariant(risks.length === 1, "INVALID_RISK", `Issue must have exactly one risk label; found ${risks.length}`);
  invariant(risks[0] !== "ai:risk:black", "BLACK_RISK_REJECTED", "Black-risk tasks require a separate human-controlled process");
  invariant(typeof triggerActor === "string" && triggerActor.length > 0, "MISSING_ACTOR", "Trigger actor is required");
  invariant(config.allowed_actors.some((actor) => actor.toLowerCase() === triggerActor.toLowerCase()), "ACTOR_NOT_ALLOWED", `${triggerActor} is not permitted to authorize factory work`);
  invariant(typeof authorizationActor === "string" && config.allowed_actors.some((actor) => actor.toLowerCase() === authorizationActor.toLowerCase()), "ACTOR_NOT_ALLOWED", `${authorizationActor ?? "unknown"} did not provide an allowed ai:build label event`);
  invariant(typeof issue.title === "string" && issue.title.trim().length > 0, "INVALID_ISSUE", "Issue title is required");
  invariant(typeof issue.body === "string" && issue.body.trim().length >= 20, "INVALID_ISSUE", "Issue body must contain a material acceptance contract (at least 20 characters)");
  return {
    schema_version: 1,
    number: issue.number,
    node_id: issue.node_id,
    url: issue.html_url,
    title: issue.title,
    body: issue.body,
    author: issue.user?.login,
    authorized_by: authorizationActor,
    risk: risks[0].slice("ai:risk:".length),
    labels,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
  };
}
