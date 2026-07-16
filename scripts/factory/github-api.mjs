import { FactoryError, invariant } from "./lib.mjs";

export class GitHubApi {
  constructor({ token = process.env.GITHUB_TOKEN, repository = process.env.GITHUB_REPOSITORY, apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com" } = {}) {
    invariant(token, "MISSING_GITHUB_TOKEN", "GITHUB_TOKEN is required");
    invariant(typeof repository === "string" && /^[^/]+\/[^/]+$/.test(repository), "INVALID_REPOSITORY", "GITHUB_REPOSITORY must be owner/name");
    this.token = token;
    this.repository = repository;
    this.apiUrl = apiUrl.replace(/\/$/, "");
  }

  async request(method, path, { body, accept = "application/vnd.github+json", raw = false } = {}) {
    const response = await fetch(`${this.apiUrl}${path}`, {
      method,
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
    if (!response.ok) {
      const responseText = await response.text();
      throw new FactoryError("GITHUB_API_ERROR", `GitHub API ${method} ${path} returned ${response.status}`, { status: response.status, body: responseText.slice(0, 4000) });
    }
    if (response.status === 204) return null;
    return raw ? Buffer.from(await response.arrayBuffer()) : await response.json();
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
