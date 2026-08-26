import { createServer } from "node:http";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { execFile, execSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
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
  githubReviewSearch: "is:pr is:open review-requested:@me archived:false org:PerformYard",
  ticketKeyPattern: /\bPY-\d+\b/gi,
  // Checks that are red until a human acts and therefore say nothing about the
  // build (e.g. the QA Code Review approval gate). Matched case-insensitively
  // by substring against the check name.
  noisyChecks: ["QA Code Review"],
  // Ticket statuses (lowercased) that mean "someone else has it" when the
  // ticket has no open PR.
  waitingStatuses: ["in code review", "ready to test", "in testing", "ready to merge", "blocked"],
  // Statuses where QA holds the merge gate: an approved, green PR is waiting
  // on QA there, not on you. PR defects (changes requested, CI, conflicts,
  // draft) still count as yours regardless of status.
  qaHoldStatuses: ["ready to test", "in testing"],
  // Statuses before QA in the pipeline: an approved, green PR there isn't
  // "ready to merge" (merge is QA-gated) — the move is handing it to QA.
  preQaStatuses: ["in progress", "in code review"],
  // Sort order within each section, by lowercased status. "Draft PR" and
  // "Open PR" are the synthetic statuses of PRs with no matched ticket.
  // Unknown statuses sort last.
  statusOrder: [
    "draft pr",
    "open pr",
    "to do",
    "ready",
    "in progress",
    "in code review",
    "ready to test",
    "in testing",
    "ready to merge",
  ],
  // Root directory holding local clones, overridable via REPOS_DIR in .env.
  // Each GitHub repo maps to <reposDir>/<repo name>.
  reposDir: process.env.REPOS_DIR || join(homedir(), "Projects"),
  knownRepos: ["PerformYard/PerformYard", "PerformYard/Logan", "PerformYard/QA", "PerformYard/koala"],
  defaultRepo: "PerformYard/PerformYard",
  // Coding agent CLIs the launch buttons can start, keyed by the name the UI
  // sends. The prompt is passed as the initial message. `models`/`efforts` are
  // the selectable per-session overrides; the config-file default is always
  // offered first and used when no override is picked.
  agents: {
    claude: {
      cmd: "claude",
      models: ["fable", "opus", "opus[1m]", "sonnet", "haiku"],
      efforts: ["low", "medium", "high", "xhigh", "max"],
    },
    codex: {
      cmd: "codex",
      models: [],
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
    },
  },
  // Every launch runs in a fresh worktree detached at the latest
  // origin/<default branch>, created here — never in the main checkout.
  worktreeRoot: join(homedir(), ".cache/inflight-worktrees"),
  // Clean worktrees older than this are removed on the next launch. Dirty
  // ones are never removed (git worktree remove refuses without --force).
  worktreeMaxAgeMs: 72 * 60 * 60 * 1000,
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

// True when you've pushed commits after the latest changes-requested review:
// the ball is back in the reviewer's court even though GitHub's reviewDecision
// stays CHANGES_REQUESTED until they re-review. Self-correcting — a newer
// changes-requested review flips it back.
export const changesAddressed = (pr) =>
  Boolean(
    pr.reviewDecision === "CHANGES_REQUESTED" &&
      pr.changesRequestedAt &&
      pr.lastCommitAt &&
      Date.parse(pr.lastCommitAt) > Date.parse(pr.changesRequestedAt),
  );

export const categorizePr = (pr) => {
  const reasons = [];
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !changesAddressed(pr)) {
    reasons.push("changes requested");
  }
  if (pr.ci === "failure") reasons.push("CI failing");
  if (pr.mergeable === "CONFLICTING") reasons.push("conflicts with base");
  if (pr.isDraft) reasons.push("draft");
  const defect = reasons.length > 0;
  let bucket = defect ? "needs_you" : "waiting";
  if (bucket === "waiting" && pr.reviewDecision === "APPROVED" && pr.ci !== "pending") {
    reasons.push("approved · ready to merge");
    bucket = "needs_you";
  } else if (bucket === "waiting") {
    if (pr.reviewDecision === "APPROVED") reasons.push("approved");
    else if (changesAddressed(pr)) reasons.push("changes pushed · awaiting re-review");
    else reasons.push(`awaiting review · ${pr.ageDays}d`);
  }
  if (pr.ci === "success") reasons.push("CI green");
  if (pr.ci === "pending") reasons.push("CI running");
  return { bucket, reasons, defect };
};

// Derives the agent action for a PR of yours. Prompts are built only from the
// validated PR number — never from titles or other free text.
export const launchForPr = (pr) => {
  if (!Number.isInteger(pr.number)) return null;
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !changesAddressed(pr)) {
    return { label: "address review", prompt: `/address-review #${pr.number}`, repo: pr.repo };
  }
  if (pr.mergeable === "CONFLICTING") {
    return { label: "resolve conflicts", prompt: `/resolve-conflicts #${pr.number}`, repo: pr.repo };
  }
  if (pr.ci === "failure") {
    return {
      label: "fix CI",
      prompt: `Investigate and fix the failing CI checks on PR #${pr.number}.`,
      repo: pr.repo,
    };
  }
  return null;
};

// A review request where you already have an opinionated review on record is a
// re-review (verify the author addressed your feedback), not a first pass.
export const launchForReview = (pr) => {
  if (!Number.isInteger(pr.number)) return null;
  return pr.viewerReviewState
    ? { label: "re-review", prompt: `/verify-review #${pr.number}`, repo: pr.repo }
    : { label: "review", prompt: `/deep-review #${pr.number}`, repo: pr.repo };
};

export const launchForTicket = (item) => {
  if (item.prs.length > 0 || !/^PY-\d+$/.test(item.key ?? "")) return null;
  return { label: "implement", prompt: `/implement-ticket ${item.key}`, repo: null };
};

export const sectionFor = (item) => {
  if (item.prs.length > 0) {
    const qaHold = CONFIG.qaHoldStatuses.includes(item.status?.toLowerCase());
    return item.prs.some((pr) => pr.bucket === "needs_you" && (pr.defect || !qaHold))
      ? "needs_you"
      : "waiting";
  }
  return CONFIG.waitingStatuses.includes(item.status.toLowerCase()) ? "waiting" : "no_pr";
};

// Ids of manually hidden items. In-memory and ephemeral by design — a server
// restart clears them.
export const hiddenIds = new Set();

export const buildItems = (jiraIssues, prs) => {
  const items = jiraIssues.map((issue) => ({
    id: issue.key,
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
        id: `${pr.repo}#${pr.number}`,
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
  const relabelMerge = (item, replacement) => {
    item.prs = item.prs.map((pr) => ({
      ...pr,
      reasons: pr.reasons.map((reason) =>
        reason === "approved · ready to merge" ? replacement : reason,
      ),
    }));
  };
  for (const item of items) {
    item.section = sectionFor(item);
    const statusKey = item.status.toLowerCase();
    if (item.section === "waiting" && CONFIG.qaHoldStatuses.includes(statusKey)) {
      relabelMerge(item, "approved · awaiting QA");
    } else if (CONFIG.preQaStatuses.includes(statusKey)) {
      relabelMerge(item, "approved · move to QA");
    }
    item.launch = launchForTicket(item);
  }
  items.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      String(b.updated).localeCompare(String(a.updated)),
  );
  return items;
};

export const statusRank = (status) => {
  const rank = CONFIG.statusOrder.indexOf(String(status ?? "").toLowerCase());
  return rank === -1 ? CONFIG.statusOrder.length : rank;
};

const githubToken = () =>
  process.env.GITHUB_TOKEN || execSync("gh auth token", { encoding: "utf8" }).trim();

const GITHUB_QUERY = `query($mine: String!, $reviews: String!) {
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...PrFields } }
  reviews: search(query: $reviews, type: ISSUE, first: 50) { nodes { ...PrFields } }
}
fragment PrFields on PullRequest {
  number title url isDraft headRefName mergeable reviewDecision createdAt updatedAt
  author { login }
  repository { nameWithOwner }
  viewerLatestReview { state }
  latestOpinionatedReviews(first: 10) { nodes { state submittedAt } }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { contexts(first: 100) {
    nodes { ... on CheckRun { name conclusion status } ... on StatusContext { context state } }
  } } } } }
}`;

const basePrOf = (node, now) => {
  const lastCommit = node.commits?.nodes?.[0]?.commit;
  const changesRequestedTimes = (node.latestOpinionatedReviews?.nodes ?? [])
    .filter((review) => review.state === "CHANGES_REQUESTED" && review.submittedAt)
    .map((review) => review.submittedAt)
    .sort();
  return {
    number: node.number,
    title: node.title,
    url: node.url,
    repo: node.repository.nameWithOwner,
    author: node.author?.login ?? "unknown",
    isDraft: node.isDraft,
    headRefName: node.headRefName,
    mergeable: node.mergeable,
    reviewDecision: node.reviewDecision,
    viewerReviewState:
      node.viewerLatestReview?.state === "PENDING" ? null : (node.viewerLatestReview?.state ?? null),
    lastCommitAt: lastCommit?.committedDate ?? null,
    changesRequestedAt: changesRequestedTimes.at(-1) ?? null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    ci: effectiveCi(lastCommit?.statusCheckRollup?.contexts?.nodes),
    ageDays: Math.max(0, Math.floor((now - Date.parse(node.createdAt)) / 86_400_000)),
  };
};

export const mapReviewPr = (node, now) => {
  const pr = basePrOf(node, now);
  return { ...pr, id: `${pr.repo}#${pr.number}` };
};

export const fetchGithub = async () => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: GITHUB_QUERY,
      variables: { mine: CONFIG.githubSearch, reviews: CONFIG.githubReviewSearch },
    }),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  if (data.errors) throw new Error(`GitHub GraphQL: ${data.errors[0]?.message}`);
  const now = Date.now();
  const prNodes = (search) => (search?.nodes ?? []).filter((node) => node.number !== undefined);
  return {
    mine: prNodes(data.data.mine).map((node) => {
      const pr = basePrOf(node, now);
      return { ...pr, ...categorizePr(pr), launch: launchForPr(pr) };
    }),
    // Oldest first: the most overdue review sits at the top.
    reviewRequests: prNodes(data.data.reviews)
      .map((node) => mapReviewPr(node, now))
      .map((pr) => ({ ...pr, launch: launchForReview(pr) }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
  };
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

// Last payload served, so /api/launch can resolve an id back to its derived
// prompt instead of trusting anything from the client.
let lastPayload = null;

const getData = async () => {
  const [jira, github] = await Promise.allSettled([fetchJira(), fetchGithub()]);
  const withHidden = (entry) => ({ ...entry, hidden: hiddenIds.has(entry.id) });
  return (lastPayload = {
    fetchedAt: new Date().toISOString(),
    sources: {
      jira: jira.status === "fulfilled" ? { ok: true } : { ok: false, error: jira.reason.message },
      github:
        github.status === "fulfilled" ? { ok: true } : { ok: false, error: github.reason.message },
    },
    items: buildItems(
      jira.status === "fulfilled" ? jira.value : [],
      github.status === "fulfilled" ? github.value.mine : [],
    ).map(withHidden),
    reviewRequests: (github.status === "fulfilled" ? github.value.reviewRequests : []).map(
      withHidden,
    ),
    agentOptions: Object.fromEntries(
      Object.entries(CONFIG.agents).map(([name, agent]) => [
        name,
        {
          models: agent.models,
          efforts: agent.efforts,
          defaultModel: agentDefaults[name]?.model ?? null,
          defaultEffort: agentDefaults[name]?.effort ?? null,
        },
      ]),
    ),
  });
};

const findLaunchTarget = (id, prNumber) => {
  const entries = [...(lastPayload?.items ?? []), ...(lastPayload?.reviewRequests ?? [])];
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  if (prNumber != null) {
    return (entry.prs ?? []).find((pr) => pr.number === Number(prNumber))?.launch ?? null;
  }
  return entry.launch ?? null;
};

const shellQuote = (value) => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Defaults each CLI would use on its own, read from its config file so the UI
// can show them as the pre-selected option.
const readAgentDefaults = () => {
  const defaults = { claude: { model: null, effort: null }, codex: { model: null, effort: null } };
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf8"));
    defaults.claude = { model: settings.model ?? null, effort: settings.effort ?? null };
  } catch {}
  try {
    const toml = readFileSync(join(homedir(), ".codex/config.toml"), "utf8");
    const value = (key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
    defaults.codex = { model: value("model"), effort: value("model_reasoning_effort") };
  } catch {}
  return defaults;
};
export const agentDefaults = readAgentDefaults();

export const buildAgentInvocation = (agentKey, { model, effort } = {}, prompt) => {
  const agent = CONFIG.agents[agentKey];
  const parts = [agent.cmd];
  if (agentKey === "claude") {
    if (model) parts.push("--model", shellQuote(model));
    if (effort) parts.push("--effort", shellQuote(effort));
  } else if (agentKey === "codex") {
    if (model) parts.push("-m", shellQuote(model));
    if (effort) parts.push("-c", shellQuote(`model_reasoning_effort="${effort}"`));
  }
  parts.push(shellQuote(prompt));
  return parts.join(" ");
};

export const slugFor = (prompt) =>
  String(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

const branchCache = new Map();
const defaultBranchOf = (repoPath) => {
  if (branchCache.has(repoPath)) return branchCache.get(repoPath);
  let branch = "master";
  try {
    branch = execSync("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: repoPath,
      encoding: "utf8",
    })
      .trim()
      .replace(/^origin\//, "");
  } catch {
    try {
      execSync("git rev-parse --verify --quiet origin/main", { cwd: repoPath, encoding: "utf8" });
      branch = "main";
    } catch {}
  }
  branchCache.set(repoPath, branch);
  return branch;
};

export const buildLaunchCommand = ({ repoPath, worktreePath, branch, invocation }) =>
  [
    `cd ${shellQuote(repoPath)}`,
    "git fetch origin",
    `git worktree add --detach ${shellQuote(worktreePath)} ${shellQuote(`origin/${branch}`)}`,
    `cd ${shellQuote(worktreePath)}`,
    invocation,
  ].join(" && ");

export const repoPathFor = (repo) => {
  const known = CONFIG.knownRepos.includes(repo) ? repo : CONFIG.defaultRepo;
  return join(CONFIG.reposDir, known.split("/")[1]);
};

const pruneStaleWorktrees = () => {
  const repoPaths = new Set(CONFIG.knownRepos.map(repoPathFor));
  for (const repoPath of repoPaths) {
    const dir = join(CONFIG.worktreeRoot, basename(repoPath));
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const worktreePath = join(dir, name);
      try {
        if (Date.now() - statSync(worktreePath).mtimeMs < CONFIG.worktreeMaxAgeMs) continue;
        execFile("git", ["-C", repoPath, "worktree", "remove", worktreePath], () => {});
      } catch {}
    }
  }
};

const launchTerminal = (command) => {
  const appleScriptSafe = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile("osascript", [
    "-e",
    `tell application "Terminal" to do script "${appleScriptSafe}"`,
    "-e",
    'tell application "Terminal" to activate',
  ]);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });

const startServer = () => {
  createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/data")) {
        const body = JSON.stringify(await getData());
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(body);
      } else if (req.method === "POST" && req.url === "/api/launch") {
        const { id, prNumber, agent, model, effort } = JSON.parse((await readBody(req)) || "{}");
        const agentDef = CONFIG.agents[agent];
        const launch = typeof id === "string" ? findLaunchTarget(id, prNumber) : null;
        const modelOk =
          !model || agentDef?.models.includes(model) || model === agentDefaults[agent]?.model;
        const effortOk = !effort || agentDef?.efforts.includes(effort);
        const repoPath = launch ? repoPathFor(launch.repo) : null;
        if (!agentDef || !launch || !modelOk || !effortOk) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown item, PR, agent, model, or effort" }));
        } else if (!existsSync(repoPath)) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `repo not found at ${repoPath} — clone it there or set REPOS_DIR in .env`,
            }),
          );
        } else {
          const worktreePath = join(
            CONFIG.worktreeRoot,
            basename(repoPath),
            `${slugFor(launch.prompt)}-${Date.now().toString(36)}`,
          );
          pruneStaleWorktrees();
          launchTerminal(
            buildLaunchCommand({
              repoPath,
              worktreePath,
              branch: defaultBranchOf(repoPath),
              invocation: buildAgentInvocation(agent, { model, effort }, launch.prompt),
            }),
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }
      } else if (req.method === "POST" && (req.url === "/api/hide" || req.url === "/api/restore")) {
        const { id } = JSON.parse((await readBody(req)) || "{}");
        if (typeof id === "string" && id) {
          if (req.url === "/api/hide") hiddenIds.add(id);
          else hiddenIds.delete(id);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(__dirname, "index.html")));
      }
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err.message }));
    }
  }).listen(CONFIG.port, "127.0.0.1", () => {
    console.log(`inflight dashboard → http://localhost:${CONFIG.port}`);
  });
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
