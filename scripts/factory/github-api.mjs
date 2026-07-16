import { FactoryError, invariant } from "./lib.mjs";

const RETRYABLE_READ_STATUSES = new Set([429, 502, 503, 504]);
const DEFAULT_MAX_READ_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;

function defaultWait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function responseRetryDelay(response, attempt, now = Date.now()) {
  const retryAfter = response?.headers?.get?.("retry-after");
  if (retryAfter !== null && retryAfter !== undefined && retryAfter !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(date - now, 0), MAX_RETRY_DELAY_MS);
  }
  return Math.min(BASE_RETRY_DELAY_MS * (2 ** (attempt - 1)), MAX_RETRY_DELAY_MS);
}

function defaultRetryLogger(event) {
  process.stderr.write(`${JSON.stringify(event)}\n`);
}

export class GitHubApi {
  constructor({
    token = process.env.GITHUB_TOKEN,
    repository = process.env.GITHUB_REPOSITORY,
    apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com",
    fetchImpl = globalThis.fetch,
    wait = defaultWait,
    retryLogger = defaultRetryLogger,
    maxReadAttempts = DEFAULT_MAX_READ_ATTEMPTS,
  } = {}) {
    invariant(token, "MISSING_GITHUB_TOKEN", "GITHUB_TOKEN is required");
    invariant(typeof repository === "string" && /^[^/]+\/[^/]+$/.test(repository), "INVALID_REPOSITORY", "GITHUB_REPOSITORY must be owner/name");
    invariant(typeof fetchImpl === "function", "INVALID_GITHUB_CLIENT", "GitHub fetch implementation must be a function");
    invariant(typeof wait === "function", "INVALID_GITHUB_CLIENT", "GitHub retry wait implementation must be a function");
    invariant(typeof retryLogger === "function", "INVALID_GITHUB_CLIENT", "GitHub retry logger must be a function");
    invariant(Number.isInteger(maxReadAttempts) && maxReadAttempts >= 1 && maxReadAttempts <= DEFAULT_MAX_READ_ATTEMPTS, "INVALID_GITHUB_CLIENT", `GitHub read attempts must be between 1 and ${DEFAULT_MAX_READ_ATTEMPTS}`);
    this.token = token;
    this.repository = repository;
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.fetchImpl = fetchImpl;
    this.wait = wait;
    this.retryLogger = retryLogger;
    this.maxReadAttempts = maxReadAttempts;
  }

  async request(method, path, { body, accept = "application/vnd.github+json", raw = false } = {}) {
    const normalizedMethod = method.toUpperCase();
    const maxAttempts = normalizedMethod === "GET" ? this.maxReadAttempts : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let response;
      try {
        response = await this.fetchImpl(`${this.apiUrl}${path}`, {
          method: normalizedMethod,
          redirect: "follow",
          headers: {
            Accept: accept,
            Authorization: `Bearer ${this.token}`,
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "shans-ai-software-factory",
            ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        if (attempt === maxAttempts) {
          throw new FactoryError("GITHUB_API_ERROR", `GitHub API ${normalizedMethod} ${path} failed after ${attempt} attempt${attempt === 1 ? "" : "s"}`, {
            attempts: attempt,
            cause: error instanceof Error ? error.message : String(error),
          });
        }
        await this.#retry({ method: normalizedMethod, path, attempt, status: null });
        continue;
      }

      if (response.ok) {
        if (response.status === 204) return null;
        return raw ? Buffer.from(await response.arrayBuffer()) : await response.json();
      }

      if (attempt < maxAttempts && RETRYABLE_READ_STATUSES.has(response.status)) {
        await this.#retry({ method: normalizedMethod, path, attempt, status: response.status, response });
        continue;
      }

      const responseText = await response.text();
      throw new FactoryError("GITHUB_API_ERROR", `GitHub API ${normalizedMethod} ${path} returned ${response.status}`, {
        status: response.status,
        attempts: attempt,
        body: responseText.slice(0, 4000),
      });
    }
    throw new FactoryError("GITHUB_API_ERROR", `GitHub API ${normalizedMethod} ${path} exhausted its retry policy`);
  }

  async #retry({ method, path, attempt, status, response = null }) {
    const delayMs = responseRetryDelay(response, attempt);
    try {
      await response?.body?.cancel();
    } catch {
      // The response body is discarded before retry; a cancellation failure does not make the read unsafe to repeat.
    }
    this.retryLogger({
      level: "warning",
      code: "GITHUB_API_RETRY",
      method,
      path,
      status,
      failed_attempt: attempt,
      next_attempt: attempt + 1,
      delay_ms: delayMs,
    });
    await this.wait(delayMs);
  }

  repoPath(suffix) {
    return `/repos/${this.repository}${suffix}`;
  }

  async paginate(path, { itemKey = null, maxPages = 100 } = {}) {
    const separator = path.includes("?") ? "&" : "?";
    const items = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const response = await this.request("GET", `${path}${separator}per_page=100&page=${page}`);
      const pageItems = itemKey ? response[itemKey] : response;
      invariant(Array.isArray(pageItems), "GITHUB_API_ERROR", `Paginated response for ${path} has no ${itemKey ?? "array"}`);
      items.push(...pageItems);
      if (pageItems.length < 100) return items;
    }
    throw new FactoryError("GITHUB_PAGINATION_LIMIT", `Refusing to truncate ${path} after ${maxPages * 100} records`);
  }

  getIssue(number) { return this.request("GET", this.repoPath(`/issues/${number}`)); }
  getRepository() { return this.request("GET", this.repoPath("")); }
  getPull(number) { return this.request("GET", this.repoPath(`/pulls/${number}`)); }
  getRun(id) { return this.request("GET", this.repoPath(`/actions/runs/${id}`)); }
  async getJobs(id) { return { jobs: await this.paginate(this.repoPath(`/actions/runs/${id}/jobs`), { itemKey: "jobs" }) }; }
  getJobLogs(id) { return this.request("GET", this.repoPath(`/actions/jobs/${id}/logs`), { raw: true, accept: "application/vnd.github+json" }); }
  getRef(ref) { return this.request("GET", this.repoPath(`/git/ref/heads/${encodeURIComponent(ref).replace(/%2F/g, "/")}`)); }
  listPulls({ state = "open", head, base } = {}) {
    const query = new URLSearchParams({ state });
    if (head) query.set("head", head);
    if (base) query.set("base", base);
    return this.paginate(this.repoPath(`/pulls?${query}`));
  }
  listComments(number) { return this.paginate(this.repoPath(`/issues/${number}/comments`)); }
  listIssueEvents(number) { return this.paginate(this.repoPath(`/issues/${number}/events`)); }
  listPullCommits(number) { return this.paginate(this.repoPath(`/pulls/${number}/commits`)); }
  createComment(number, body) { return this.request("POST", this.repoPath(`/issues/${number}/comments`), { body: { body } }); }
  updateComment(id, body) { return this.request("PATCH", this.repoPath(`/issues/comments/${id}`), { body: { body } }); }
  createPull(body) { return this.request("POST", this.repoPath("/pulls"), { body }); }
  updatePull(number, body) { return this.request("PATCH", this.repoPath(`/pulls/${number}`), { body }); }
  setLabels(number, labels) { return this.request("PUT", this.repoPath(`/issues/${number}/labels`), { body: { labels } }); }
  createLabel(name, color, description) { return this.request("POST", this.repoPath("/labels"), { body: { name, color, description } }); }
  getLabel(name) { return this.request("GET", this.repoPath(`/labels/${encodeURIComponent(name)}`)); }
  dispatchWorkflow(file, ref, inputs = {}) { return this.request("POST", this.repoPath(`/actions/workflows/${encodeURIComponent(file)}/dispatches`), { body: { ref, inputs } }); }
  createStatus(sha, body) { return this.request("POST", this.repoPath(`/statuses/${sha}`), { body }); }
}
