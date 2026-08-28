import { createServer } from "node:http";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, rmSync } from "node:fs";
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
  // The human QA approval gate. Excluded from CI, but its pass state is the
  // true merge-readiness signal: passed only when every run of it is green.
  qaGateCheck: "QA Code Review",
  // How far back the merged-PR search looks, for annotating shipped-but-
  // untransitioned tickets.
  mergedLookbackDays: 14,
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
  // Sessions launched from the dashboard report progress by writing this file
  // at their worktree root (see the skills' "Session status file" section).
  // It's ignored when judging worktree cleanliness and removed before cleanup.
  statusFileName: ".agent-status.json",
  // Auto-diagnosis of red signals via one-shot headless claude runs. Read-only:
  // the allowed tools are gh inspection commands. Disable with DIAGNOSE=off.
  diagnosis: {
    enabled: process.env.DIAGNOSE !== "off",
    model: "sonnet",
    maxTurns: 15,
    timeoutMs: 240_000,
    maxConcurrent: 1,
    allowedTools: [
      "Bash(gh pr checks:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr diff:*)",
      "Bash(gh run view:*)",
      "Bash(gh api:*)",
    ],
    // Failure patterns known to be rerun-safe flakes, given to the classifier.
    knownFlakes: [
      "React Timezone Tests failing near a UTC hour boundary",
      "cohortQuery integration tests (clock skew or hook timeout)",
      "meeting form 15-minute clock flake across unit shards",
      "post-teardown window-undefined cancellations (red with 0 failures)",
    ],
  },
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

// The QA gate is passed only when every run of the gate check is green — a
// stray success among failing runs still means QA hasn't signed off.
export const qaGateState = (contextNodes) => {
  const gate = CONFIG.qaGateCheck.toLowerCase();
  const runs = (contextNodes ?? []).filter((node) =>
    String(node.name ?? node.context ?? "").toLowerCase().includes(gate),
  );
  if (runs.length === 0) return null;
  const states = runs.map(checkStateOf);
  if (states.every((state) => state === "success")) return "passed";
  if (states.some((state) => state === "pending")) return "pending";
  return "blocked";
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
  if (pr.openThreads > 0) {
    reasons.push(`${pr.openThreads} open thread${pr.openThreads === 1 ? "" : "s"}`);
  }
  if (pr.ci === "failure") reasons.push("CI failing");
  if (pr.mergeable === "CONFLICTING") reasons.push("conflicts with base");
  if (pr.isDraft) reasons.push("draft");
  const defect = reasons.length > 0;
  let bucket = defect ? "needs_you" : "waiting";
  if (bucket === "waiting" && pr.reviewDecision === "APPROVED" && pr.ci !== "pending") {
    reasons.push(
      pr.qaGate === "passed" ? "QA passed · ready to merge" : "approved · ready to merge",
    );
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
  if ((pr.reviewDecision === "CHANGES_REQUESTED" && !changesAddressed(pr)) || pr.openThreads > 0) {
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
  return {
    label: "implement",
    prompt: `/implement-ticket ${item.key}`,
    repo: item.parentPrs?.[0]?.repo ?? null,
  };
};

export const sectionFor = (item) => {
  if (item.prs.length > 0) {
    const qaHold = CONFIG.qaHoldStatuses.includes(item.status?.toLowerCase());
    return item.prs.some(
      (pr) => pr.bucket === "needs_you" && (pr.defect || pr.qaGate === "passed" || !qaHold),
    )
      ? "needs_you"
      : "waiting";
  }
  return CONFIG.waitingStatuses.includes(item.status.toLowerCase()) ? "waiting" : "no_pr";
};

// Ids of manually hidden items and a memory of launched agent sessions, both
// persisted to a local gitignored file so a server restart doesn't wipe them.
export const hiddenIds = new Set();
export const launches = new Map();
export const diagnoses = new Map();
const STATE_PATH = join(__dirname, ".state.json");

const loadState = () => {
  try {
    const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    for (const id of state.hidden ?? []) hiddenIds.add(id);
    for (const [id, launch] of Object.entries(state.launches ?? {})) launches.set(id, launch);
    for (const [key, diagnosis] of Object.entries(state.diagnoses ?? {})) {
      diagnoses.set(key, diagnosis);
    }
  } catch {}
};
loadState();

const saveState = () => {
  try {
    writeFileSync(
      STATE_PATH,
      JSON.stringify({
        hidden: [...hiddenIds],
        launches: Object.fromEntries(launches),
        diagnoses: Object.fromEntries(diagnoses),
      }),
    );
  } catch {}
};

// Append-only activity journal — every agent action (yours or a supervisor's)
// lands here so autonomy stays auditable. JSONL, gitignored.
const JOURNAL_PATH = join(__dirname, ".journal.jsonl");

export const appendJournal = (event) => {
  const entry = {
    at: Date.now(),
    actor: String(event.actor ?? "you").slice(0, 24),
    action: String(event.action ?? "").slice(0, 60),
    id: event.id != null ? String(event.id).slice(0, 80) : null,
    detail: String(event.detail ?? "").slice(0, 300),
  };
  try {
    writeFileSync(JOURNAL_PATH, `${JSON.stringify(entry)}\n`, { flag: "a" });
  } catch {}
  return entry;
};

export const readJournal = (limit = 30) => {
  try {
    return readFileSync(JOURNAL_PATH, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line))
      .reverse();
  } catch {
    return [];
  }
};

export const buildItems = (jiraIssues, prs, mergedPrs = []) => {
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
  const prsByKey = new Map();
  for (const pr of prs) {
    const keys = extractTicketKeys(pr);
    for (const key of keys) {
      if (!prsByKey.has(key)) prsByKey.set(key, []);
      prsByKey.get(key).push(pr);
    }
    const matched = keys.map((key) => byKey.get(key)).filter(Boolean);
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
    // A subtask with no PR of its own usually rides the parent ticket's
    // branch/PR — reference those PRs for display, but never attach them:
    // their CI/review/conflict signals belong to the parent's row only.
    if (item.isSubtask && item.prs.length === 0 && item.parentKey) {
      const parentPrs = prsByKey.get(item.parentKey) ?? [];
      if (parentPrs.length > 0) {
        item.parentPrs = parentPrs.map((pr) => ({ number: pr.number, url: pr.url, repo: pr.repo }));
      }
    }
    // Display-only: a PR-less ticket whose PR recently merged isn't unstarted.
    if (item.key && item.prs.length === 0 && !item.parentPrs) {
      const merged = mergedPrs.filter((pr) => extractTicketKeys(pr).includes(item.key));
      if (merged.length > 0) {
        item.mergedPrs = merged.map((pr) => ({ number: pr.number, url: pr.url, repo: pr.repo }));
      }
    }
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

const GITHUB_QUERY = `query($mine: String!, $reviews: String!, $merged: String!) {
  mine: search(query: $mine, type: ISSUE, first: 50) { nodes { ...PrFields } }
  reviews: search(query: $reviews, type: ISSUE, first: 50) { nodes { ...PrFields } }
  merged: search(query: $merged, type: ISSUE, first: 50) { nodes { ... on PullRequest {
    number title url headRefName repository { nameWithOwner }
  } } }
}
fragment PrFields on PullRequest {
  number title url isDraft headRefName mergeable reviewDecision createdAt updatedAt
  additions deletions
  author { login }
  repository { nameWithOwner }
  viewerLatestReview { state }
  latestOpinionatedReviews(first: 10) { nodes { state submittedAt } }
  reviewThreads(first: 100) { nodes { isResolved comments(last: 1) { nodes { author { login } } } } }
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
    // Actionable threads only: unresolved, last word isn't the author's (the
    // ball is in the author's court), and never on approved PRs — reviewers
    // here rarely click resolve, so approval supersedes stale threads.
    openThreads:
      node.reviewDecision === "APPROVED"
        ? 0
        : (node.reviewThreads?.nodes ?? []).filter(
            (thread) =>
              !thread.isResolved &&
              thread.comments?.nodes?.[0]?.author?.login !== node.author?.login,
          ).length,
    qaGate: qaGateState(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes),
    lastCommitAt: lastCommit?.committedDate ?? null,
    changesRequestedAt: changesRequestedTimes.at(-1) ?? null,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    ci: effectiveCi(lastCommit?.statusCheckRollup?.contexts?.nodes),
    ageDays: Math.max(0, Math.floor((now - Date.parse(node.createdAt)) / 86_400_000)),
  };
};

export const mapReviewPr = (node, now) => {
  const pr = basePrOf(node, now);
  const ticketKey = extractTicketKeys(pr)[0] ?? null;
  return {
    ...pr,
    id: `${pr.repo}#${pr.number}`,
    ticketKey,
    ticketUrl: ticketKey ? `${CONFIG.jiraBaseUrl}/browse/${ticketKey}` : null,
  };
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
      variables: {
        mine: CONFIG.githubSearch,
        reviews: CONFIG.githubReviewSearch,
        merged: `${CONFIG.githubSearch.replace("is:open", "is:merged")} merged:>=${new Date(
          Date.now() - CONFIG.mergedLookbackDays * 86_400_000,
        )
          .toISOString()
          .slice(0, 10)}`,
      },
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
    merged: prNodes(data.data.merged).map((node) => ({
      number: node.number,
      title: node.title,
      url: node.url,
      headRefName: node.headRefName,
      repo: node.repository.nameWithOwner,
    })),
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

// ---------------------------------------------------------------------------
// Auto-diagnosis: one-shot, read-only headless claude runs that turn raw red
// signals into causes. Results are cached per (PR, state) key so each state is
// diagnosed exactly once; keys change when a new commit or review arrives.
// ---------------------------------------------------------------------------

export const diagnosisKeyFor = (pr) => {
  if (pr.ci === "failure") return `ci:${pr.repo}#${pr.number}:${pr.lastCommitAt}`;
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !changesAddressed(pr)) {
    return `review:${pr.repo}#${pr.number}:${pr.changesRequestedAt}`;
  }
  return null;
};

export const parseDiagnosis = (output) => {
  const line = String(output)
    .trim()
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1);
  const match = line?.match(/^(FLAKE|REAL|WANTS):\s*(.+)$/i);
  if (!match) return null;
  const kind = { flake: "flake", real: "real", wants: "digest" }[match[1].toLowerCase()];
  return { kind, detail: match[2].slice(0, 160) };
};

const diagnosisPromptFor = (pr, key) =>
  key.startsWith("ci:")
    ? `PR #${pr.number} in ${pr.repo} has failing CI on its latest commit. Run gh pr checks ${pr.number} --repo ${pr.repo} to find the failing checks, then inspect their logs (gh run view --log-failed). Known rerun-safe flaky patterns in this codebase: ${CONFIG.diagnosis.knownFlakes.join("; ")}. Decide whether the failure is a known-pattern flake or a real defect. Reply with EXACTLY one final line, nothing after it: "FLAKE: <which pattern, ≤15 words>" or "REAL: <root cause, ≤15 words>".`
    : `PR #${pr.number} in ${pr.repo} has a changes-requested review. Read the review feedback (gh pr view ${pr.number} --repo ${pr.repo} --comments, and gh api repos/${pr.repo}/pulls/${pr.number}/comments for inline threads). Summarize what the reviewer(s) actually want changed. Reply with EXACTLY one final line, nothing after it: "WANTS: <the asks, ≤25 words>".`;

const diagnosing = new Set();

const runDiagnosis = (pr, key) => {
  diagnosing.add(key);
  // The prompt must precede --allowedTools: that flag is variadic and would
  // swallow a trailing positional argument.
  const args = [
    "-p",
    diagnosisPromptFor(pr, key),
    "--model",
    CONFIG.diagnosis.model,
    "--max-turns",
    String(CONFIG.diagnosis.maxTurns),
    ...CONFIG.diagnosis.allowedTools.flatMap((tool) => ["--allowedTools", tool]),
  ];
  execFile(
    "claude",
    args,
    { cwd: repoPathFor(pr.repo), timeout: CONFIG.diagnosis.timeoutMs, encoding: "utf8" },
    (err, stdout) => {
      diagnosing.delete(key);
      const parsed = err ? null : parseDiagnosis(stdout);
      diagnoses.set(
        key,
        parsed
          ? { ...parsed, at: Date.now() }
          : {
              kind: "error",
              detail: String(err?.message ?? "unparseable output").slice(0, 120),
              at: Date.now(),
            },
      );
      saveState();
      if (parsed) {
        appendJournal({
          actor: "diagnosis",
          action: key.startsWith("ci:") ? "diagnosed CI failure" : "digested review feedback",
          id: `${pr.repo}#${pr.number}`,
          detail: `${parsed.kind}: ${parsed.detail}`,
        });
      }
    },
  );
};

// Fire-and-forget after each refresh: diagnose any undiagnosed red signal on
// your own non-draft PRs, a couple at a time.
const scheduleDiagnoses = (items) => {
  if (!CONFIG.diagnosis.enabled) return;
  for (const item of items) {
    for (const pr of item.prs ?? []) {
      if (pr.isDraft) continue;
      const key = diagnosisKeyFor(pr);
      if (!key || diagnoses.has(key) || diagnosing.has(key)) continue;
      if (diagnosing.size >= CONFIG.diagnosis.maxConcurrent) return;
      runDiagnosis(pr, key);
    }
  }
};

// Last payload served, so /api/launch can resolve an id back to its derived
// prompt instead of trusting anything from the client.
let lastPayload = null;

// Resolves a launch record into what the UI shows. Inspects the worktree live;
// a vanished worktree means the session is over, so the note self-clears.
const launchInfoFor = (id) => {
  const record = launches.get(id);
  if (!record) return null;
  const base = { agent: record.agent, at: record.at, actor: record.actor ?? "you" };
  if (record.error) return { ...base, error: record.error };
  if (!record.worktree) return base;
  const status = worktreeStatusOf(record.worktree);
  if (status.state === "gone") {
    launches.delete(id);
    saveState();
    return null;
  }
  return { ...base, status, session: sessionStatusOf(record.worktree) };
};

const getData = async () => {
  agentDefaults = readAgentDefaults();
  const [jira, github] = await Promise.allSettled([fetchJira(), fetchGithub()]);
  const withHidden = (entry) => ({
    ...entry,
    hidden: hiddenIds.has(entry.id),
    launched: launchInfoFor(entry.id),
  });
  const items = buildItems(
    jira.status === "fulfilled" ? jira.value : [],
    github.status === "fulfilled" ? github.value.mine : [],
    github.status === "fulfilled" ? github.value.merged : [],
  ).map(withHidden);
  for (const item of items) {
    for (const pr of item.prs) {
      const key = diagnosisKeyFor(pr);
      const diagnosis = key ? diagnoses.get(key) : null;
      if (diagnosis && diagnosis.kind !== "error") pr.diagnosis = diagnosis;
    }
  }
  scheduleDiagnoses(items);
  return (lastPayload = {
    fetchedAt: new Date().toISOString(),
    sources: {
      jira: jira.status === "fulfilled" ? { ok: true } : { ok: false, error: jira.reason.message },
      github:
        github.status === "fulfilled" ? { ok: true } : { ok: false, error: github.reason.message },
    },
    items,
    reviewRequests: (github.status === "fulfilled" ? github.value.reviewRequests : []).map(
      withHidden,
    ),
    journal: readJournal(30),
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
// Re-read on every data refresh so a changed CLI default shows without restart.
export let agentDefaults = readAgentDefaults();

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

// What became of a launched session's worktree: gone (cleaned up), dirty
// (uncommitted changes), unpushed (committed work not on any remote), or clean.
export const worktreeStatusOf = (worktreePath) => {
  if (!existsSync(worktreePath)) return { state: "gone" };
  try {
    const git = (args) => execSync(`git ${args}`, { cwd: worktreePath, encoding: "utf8" }).trim();
    const dirty = git("status --porcelain")
      .split("\n")
      .filter((line) => line.trim() !== "" && !line.endsWith(CONFIG.statusFileName));
    if (dirty.length > 0) return { state: "dirty" };
    const unpushed = Number(git("rev-list --count HEAD --not --remotes"));
    return unpushed > 0 ? { state: "unpushed", unpushed } : { state: "clean" };
  } catch {
    return { state: "unknown" };
  }
};

// The session's own progress report, if it wrote one (skills maintain this at
// the worktree root when launched from the dashboard).
export const sessionStatusOf = (worktreePath) => {
  try {
    const raw = JSON.parse(readFileSync(join(worktreePath, CONFIG.statusFileName), "utf8"));
    const state = ["working", "awaiting-approval", "blocked", "done"].includes(raw.state)
      ? raw.state
      : "working";
    return { state, detail: String(raw.detail ?? "").slice(0, 200) };
  } catch {
    return null;
  }
};

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

const launchTerminal = (command, onError) => {
  const appleScriptSafe = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  execFile(
    "osascript",
    [
      "-e",
      `tell application "Terminal" to do script "${appleScriptSafe}"`,
      "-e",
      'tell application "Terminal" to activate',
    ],
    (err) => {
      if (err && onError) onError(err);
    },
  );
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
        const { id, prNumber, agent, model, effort, actor } = JSON.parse(
          (await readBody(req)) || "{}",
        );
        const agentDef = CONFIG.agents[agent];
        const launch = typeof id === "string" ? findLaunchTarget(id, prNumber) : null;
        const modelOk =
          !model || agentDef?.models.includes(model) || model === agentDefaults[agent]?.model;
        const effortOk = !effort || agentDef?.efforts.includes(effort);
        const repoPath = launch ? repoPathFor(launch.repo) : null;
        const existing = launches.get(id);
        if (!agentDef || !launch || !modelOk || !effortOk) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "unknown item, PR, agent, model, or effort" }));
        } else if (existing && !existing.error) {
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: `already launched (${existing.agent}) — clear the session note to relaunch`,
            }),
          );
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
          const launchActor = typeof actor === "string" && actor ? actor.slice(0, 24) : "you";
          launches.set(id, {
            agent,
            at: Date.now(),
            worktree: worktreePath,
            repoPath,
            actor: launchActor,
          });
          saveState();
          appendJournal({
            actor: launchActor,
            action: `launch ${agent}`,
            id,
            detail: launch.prompt,
          });
          pruneStaleWorktrees();
          launchTerminal(
            buildLaunchCommand({
              repoPath,
              worktreePath,
              branch: defaultBranchOf(repoPath),
              invocation: buildAgentInvocation(agent, { model, effort }, launch.prompt),
            }),
            (err) => {
              const record = launches.get(id);
              if (record) {
                record.error = String(err.message ?? err).split("\n")[0].slice(0, 160);
                saveState();
              }
            },
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        }
      } else if (req.method === "POST" && req.url === "/api/clear-launch") {
        const { id } = JSON.parse((await readBody(req)) || "{}");
        const record = typeof id === "string" ? launches.get(id) : null;
        if (!record) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "no launch recorded for that item" }));
        } else {
          let removalError = null;
          if (record.worktree && existsSync(record.worktree) && !record.error) {
            try {
              rmSync(join(record.worktree, CONFIG.statusFileName), { force: true });
              execSync(`git worktree remove ${shellQuote(record.worktree)}`, {
                cwd: record.repoPath ?? repoPathFor(null),
                encoding: "utf8",
                stdio: "pipe",
              });
            } catch (err) {
              removalError = String(err.stderr ?? err.message).split("\n")[0].slice(0, 160);
            }
          }
          if (removalError) {
            res.writeHead(409, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({ error: `worktree not removed (uncommitted work?): ${removalError}` }),
            );
          } else {
            launches.delete(id);
            saveState();
            appendJournal({ actor: "you", action: "clear launch", id });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
          }
        }
      } else if (req.method === "GET" && req.url.startsWith("/api/journal")) {
        const limit = Number(new URL(req.url, "http://x").searchParams.get("limit")) || 30;
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ events: readJournal(Math.min(limit, 200)) }));
      } else if (req.method === "POST" && req.url === "/api/journal") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (typeof body.action !== "string" || !body.action) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "action is required" }));
        } else {
          const entry = appendJournal(body);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, entry }));
        }
      } else if (req.method === "POST" && (req.url === "/api/hide" || req.url === "/api/restore")) {
        const { id } = JSON.parse((await readBody(req)) || "{}");
        if (typeof id === "string" && id) {
          if (req.url === "/api/hide") hiddenIds.add(id);
          else hiddenIds.delete(id);
          saveState();
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
