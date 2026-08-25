import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const loadDotEnv = () => {
  const path = join(__dirname, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
};
loadDotEnv();

// All configuration lives here. No config UI, no filters, no tabs — edit these
// constants if the queries ever need to change.
export const CONFIG = {
  port: Number(process.env.PORT || 4477),
  jiraBaseUrl: process.env.JIRA_BASE_URL || "https://performyard.atlassian.net",
  jiraJql:
    "assignee = currentUser() AND project = PY AND statusCategory != Done ORDER BY updated DESC",
  githubSearch: "is:pr is:open author:@me archived:false org:PerformYard",
  ticketKeyPattern: /\bPY-\d+\b/gi,
  // Checks that are red until a human acts and therefore say nothing about the
  // build (e.g. the QA Code Review approval gate). Matched case-insensitively
  // by substring against the check name.
  noisyChecks: ["QA Code Review"],
  // Ticket statuses (lowercased) that mean "someone else has it" when the
  // ticket has no open PR.
  waitingStatuses: ["in code review", "ready to test", "in testing", "ready to merge", "blocked"],
};

export const SECTIONS = ["needs_you", "waiting", "no_pr"];

export const extractTicketKeys = (pr) => {
  const haystack = `${pr.headRefName ?? ""} ${pr.title ?? ""}`;
  const keys = haystack.match(CONFIG.ticketKeyPattern) ?? [];
  return [...new Set(keys.map((k) => k.toUpperCase()))];
};

const CHECK_RANK = { pending: 0, failure: 1, success: 2 };

const checkStateOf = (node) => {
  const raw = String(node.conclusion ?? node.state ?? node.status ?? "").toUpperCase();
  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(raw)) return "success";
  if (["FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE"].includes(raw)) {
    return "failure";
  }
  return "pending";
};

// Collapses raw check contexts into one CI verdict. Noisy checks are dropped;
// duplicate runs of the same check name count as passing if any run passed
// (reruns of flaky shards are routine here).
export const effectiveCi = (contextNodes) => {
  const byName = new Map();
  for (const node of contextNodes ?? []) {
    const name = node.name ?? node.context;
    if (!name) continue;
    if (CONFIG.noisyChecks.some((noise) => name.toLowerCase().includes(noise.toLowerCase()))) {
      continue;
    }
    const state = checkStateOf(node);
    const prev = byName.get(name);
    if (prev === undefined || CHECK_RANK[state] > CHECK_RANK[prev]) byName.set(name, state);
  }
  const states = [...byName.values()];
  if (states.length === 0) return "none";
  if (states.includes("failure")) return "failure";
  if (states.includes("pending")) return "pending";
  return "success";
};

export const categorizePr = (pr) => {
  const reasons = [];
  if (pr.reviewDecision === "CHANGES_REQUESTED") reasons.push("changes requested");
  if (pr.ci === "failure") reasons.push("CI failing");
  if (pr.mergeable === "CONFLICTING") reasons.push("conflicts with base");
  if (pr.isDraft) reasons.push("draft");
  let bucket = reasons.length > 0 ? "needs_you" : "waiting";
  if (bucket === "waiting" && pr.reviewDecision === "APPROVED" && pr.ci !== "pending") {
    reasons.push("approved · ready to merge");
    bucket = "needs_you";
  } else if (bucket === "waiting") {
    reasons.push(pr.reviewDecision === "APPROVED" ? "approved" : `awaiting review · ${pr.ageDays}d`);
  }
  if (pr.ci === "success") reasons.push("CI green");
  if (pr.ci === "pending") reasons.push("CI running");
  return { bucket, reasons };
};

export const sectionFor = (item) => {
  if (item.prs.length > 0) {
    return item.prs.some((pr) => pr.bucket === "needs_you") ? "needs_you" : "waiting";
  }
  return CONFIG.waitingStatuses.includes(item.status.toLowerCase()) ? "waiting" : "no_pr";
};

export const buildItems = (jiraIssues, prs) => {
  const items = jiraIssues.map((issue) => ({
    key: issue.key,
    url: `${CONFIG.jiraBaseUrl}/browse/${issue.key}`,
    summary: issue.fields.summary,
    status: issue.fields.status?.name ?? "Unknown",
    statusCategory: issue.fields.status?.statusCategory?.key ?? "new",
    isSubtask: Boolean(issue.fields.issuetype?.subtask),
    parentKey: issue.fields.parent?.key ?? null,
    updated: issue.fields.updated,
    prs: [],
  }));
  const byKey = new Map(items.map((item) => [item.key, item]));
  for (const pr of prs) {
    const matched = extractTicketKeys(pr)
      .map((key) => byKey.get(key))
      .filter(Boolean);
    if (matched.length > 0) {
      for (const item of matched) item.prs.push(pr);
    } else {
      items.push({
        key: null,
        url: null,
        summary: pr.title,
        status: pr.isDraft ? "Draft PR" : "Open PR",
        statusCategory: "indeterminate",
        isSubtask: false,
        parentKey: null,
        updated: pr.updatedAt,
        prs: [pr],
      });
    }
  }
  for (const item of items) item.section = sectionFor(item);
  items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
  return items;
};

const githubToken = () =>
  process.env.GITHUB_TOKEN || execSync("gh auth token", { encoding: "utf8" }).trim();

const GITHUB_QUERY = `query($q: String!) {
  search(query: $q, type: ISSUE, first: 50) {
    nodes {
      ... on PullRequest {
        number title url isDraft headRefName mergeable reviewDecision createdAt updatedAt
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) {
          nodes { ... on CheckRun { name conclusion status } ... on StatusContext { context state } }
        } } } } }
      }
    }
  }
}`;

export const fetchGithub = async () => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query: GITHUB_QUERY, variables: { q: CONFIG.githubSearch } }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (data.errors) throw new Error(`GitHub GraphQL: ${data.errors[0]?.message}`);
  const now = Date.now();
  return (data.data.search.nodes ?? [])
    .filter((node) => node.number !== undefined)
    .map((node) => {
      const pr = {
        number: node.number,
        title: node.title,
        url: node.url,
        repo: node.repository.nameWithOwner,
        isDraft: node.isDraft,
        headRefName: node.headRefName,
        mergeable: node.mergeable,
        reviewDecision: node.reviewDecision,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        ci: effectiveCi(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes),
        ageDays: Math.max(0, Math.floor((now - Date.parse(node.createdAt)) / 86_400_000)),
      };
      return { ...pr, ...categorizePr(pr) };
    });
};

export const fetchJira = async () => {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token) {
    throw new Error(
      "Set JIRA_EMAIL and JIRA_API_TOKEN in .env (create a token at https://id.atlassian.com/manage-profile/security/api-tokens)",
    );
  }
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  const issues = [];
  let nextPageToken;
  do {
    const params = new URLSearchParams({
      jql: CONFIG.jiraJql,
      fields: "summary,status,issuetype,parent,updated",
      maxResults: "100",
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const res = await fetch(`${CONFIG.jiraBaseUrl}/rest/api/3/search/jql?${params}`, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    issues.push(...(data.issues ?? []));
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
  return issues;
};

const getData = async () => {
  const [jira, github] = await Promise.allSettled([fetchJira(), fetchGithub()]);
  return {
    fetchedAt: new Date().toISOString(),
    sources: {
      jira: jira.status === "fulfilled" ? { ok: true } : { ok: false, error: jira.reason.message },
      github:
        github.status === "fulfilled" ? { ok: true } : { ok: false, error: github.reason.message },
    },
    items: buildItems(
      jira.status === "fulfilled" ? jira.value : [],
      github.status === "fulfilled" ? github.value : [],
    ),
  };
};

const startServer = () => {
  createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/data")) {
        const body = JSON.stringify(await getData());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(__dirname, "index.html")));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }).listen(CONFIG.port, () => {
    console.log(`inflight dashboard → http://localhost:${CONFIG.port}`);
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
