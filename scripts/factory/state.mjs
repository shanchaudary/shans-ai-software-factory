import { GitHubApi } from "./github-api.mjs";
import { invariant, sha256 } from "./lib.mjs";

export const FACTORY_LABELS = Object.freeze({
  managed: { name: "ai:managed", color: "1f6feb", description: "Pull request is supervised by Shan's AI Software Factory" },
  building: { name: "ai:building", color: "d4c5f9", description: "Factory work is in progress" },
  repairing: { name: "ai:repairing", color: "fbca04", description: "Factory is applying a bounded repair" },
  ready: { name: "ai:ready-for-shan", color: "0e8a16", description: "CI and independent review passed; human decision required" },
  needs: { name: "ai:needs-shan", color: "b60205", description: "Factory stopped fail-closed and needs human intervention" },
});

export function taskDigest(task) {
  return sha256(JSON.stringify({
    number: task.number,
    title: task.title,
    body: task.body,
    author: task.author,
    authorized_by: task.authorized_by,
    risk: task.risk,
  }));
}

export function stateMarker({ issue, project, authorizedBy, taskSha }) {
  invariant(/^[0-9a-f]{64}$/.test(taskSha ?? ""), "INVALID_TASK_DIGEST", "Factory marker requires a full task SHA-256");
  return `<!-- ai-factory:v1 issue=${issue} project=${project} authorized_by=${authorizedBy} task_sha=${taskSha} -->`;
}

export function parseStateMarker(body) {
  const match = String(body ?? "").match(/<!-- ai-factory:v1 issue=(\d+) project=([a-z0-9][a-z0-9-]{1,62}) authorized_by=([A-Za-z0-9-]{1,39}) task_sha=([0-9a-f]{64}) -->/);
  if (!match) return null;
  return { issue: Number(match[1]), project: match[2], authorized_by: match[3], task_sha: match[4] };
}

export function attemptFromLabels(labels) {
  const values = labels
    .map((label) => typeof label === "string" ? label : label.name)
    .map((name) => /^ai:repair:(\d+)$/.exec(name))
    .filter(Boolean)
    .map((match) => Number(match[1]));
  invariant(values.length <= 1, "INVALID_STATE", "Pull request has multiple repair-attempt labels");
  return values[0] ?? 0;
}

export async function ensureLabels(github, labels = Object.values(FACTORY_LABELS)) {
  for (const label of labels) {
    try {
      await github.getLabel(label.name);
    } catch (error) {
      if (error.code !== "GITHUB_API_ERROR" || error.details?.status !== 404) throw error;
      await github.createLabel(label.name, label.color, label.description);
    }
  }
}

export async function setFactoryState(github, pr, { state, attempt, extraLabels = [] }) {
  invariant(Object.values(FACTORY_LABELS).some((item) => item.name === state), "INVALID_STATE", `Unknown factory state: ${state}`);
  const existing = (pr.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
  const factoryStates = new Set(Object.values(FACTORY_LABELS).map((item) => item.name));
  const kept = existing.filter((name) => !factoryStates.has(name) && !/^ai:repair:\d+$/.test(name));
  const attemptLabel = `ai:repair:${attempt}`;
  try {
    await github.getLabel(attemptLabel);
  } catch (error) {
    if (error.code !== "GITHUB_API_ERROR" || error.details?.status !== 404) throw error;
    await github.createLabel(attemptLabel, "c5def5", `Factory repair cycle ${attempt}`);
  }
  return github.setLabels(pr.number, [...new Set([...kept, FACTORY_LABELS.managed.name, state, attemptLabel, ...extraLabels])]);
}

export async function upsertFactoryComment(github, prNumber, markdown) {
  const marker = "<!-- ai-factory:status:v1 -->";
  const body = `${marker}\n${markdown}`;
  const comments = await github.listComments(prNumber);
  const existing = comments.find((comment) => String(comment.body ?? "").includes(marker));
  return existing ? github.updateComment(existing.id, body) : github.createComment(prNumber, body);
}
