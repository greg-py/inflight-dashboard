import { execSync } from "node:child_process";
import { CONFIG } from "./config.js";

let token;
const githubToken = () => (token ??= process.env.GITHUB_TOKEN || execSync("gh auth token", { encoding: "utf8" }).trim());

const request = async (url, init = {}) => {
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${githubToken()}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(CONFIG.timeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};
const rest = (path) => request(`https://api.github.com/${path}`);
const graphql = async (query, variables) => {
  const body = await request("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query, variables }) });
  if (body.errors?.length) throw new Error(`GitHub GraphQL: ${body.errors[0].message}`);
  return body.data;
};

const PR_CORE = `
  number title url isDraft state createdAt mergedAt mergeable baseRefName headRefName
  author { login }
  repository { nameWithOwner defaultBranchRef { name } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { slug } } } }
  reviews(last: 60) { nodes { author { __typename login } state submittedAt body } }
  head: commits(last: 1) { nodes { commit { committedDate checkSuites(first: 1) { nodes { createdAt } } } } }
  timelineItems(last: 40, itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT]) {
    nodes { __typename ... on ReviewRequestedEvent { createdAt } ... on ReadyForReviewEvent { createdAt } }
  }
`;

const CHECKS = `
  rollup: commits(last: 1) { nodes { commit {
    statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } }
      ... on StatusContext { context state createdAt }
    } } }
  } } }`;

const THREADS = `
  reviewThreads(first: 80) { nodes {
    isResolved isOutdated
    opener: comments(first: 1) { nodes { author { __typename login } body } }
    last: comments(last: 1) { nodes { author { login } } }
  } }`;

const searchPrs = async (q, { threads = false, checks = true } = {}) => {
  const query = `query($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { ${PR_CORE} ${checks ? CHECKS : ""} ${threads ? THREADS : ""} } }
    }
  }`;
  const out = [];
  let after = null;
  do {
    const { search } = await graphql(query, { q, after });
    out.push(...search.nodes.filter((n) => n?.number));
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (after);
  return out;
};

const BOTS = /\[bot\]$|^(chatgpt-codex-connector|cursor|claude|copilot|github-actions|coderabbitai)$/i;
const isBot = (author) => !author || author.__typename === "Bot" || BOTS.test(author.login);
const NON_ACTIONABLE = /^\s*[_*]{0,2}(praise|thought|note)\b/i;

export const keysIn = (...texts) => {
  const keys = new Set();
  const re = new RegExp(CONFIG.ticketKey.source, "gi");
  for (const t of texts) for (const m of String(t ?? "").matchAll(re)) keys.add(`PY-${m[1]}`);
  return [...keys];
};

// The newest run of each check decides it: a failure that was re-run is running.
export const ciState = (contexts) => {
  const newest = new Map();
  for (const c of contexts) {
    const name = c.__typename === "CheckRun" ? c.name : c.context;
    if (CONFIG.ignoredChecks.includes(name)) continue;
    const id = c.__typename === "CheckRun" ? `${c.checkSuite?.workflowRun?.workflow?.name ?? ""}/${name}` : `status/${name}`;
    const at = c.startedAt ?? c.createdAt ?? "";
    if (!newest.has(id) || at >= newest.get(id).at) newest.set(id, { name, at, c });
  }
  const failing = [], cancelled = [];
  let pending = false;
  for (const { name, c } of newest.values()) {
    if (c.__typename === "StatusContext") {
      if (c.state === "FAILURE" || c.state === "ERROR") failing.push(name);
      else if (c.state === "PENDING" || c.state === "EXPECTED") pending = true;
    } else if (c.status !== "COMPLETED") pending = true;
    else if (["FAILURE", "TIMED_OUT", "STARTUP_FAILURE"].includes(c.conclusion)) failing.push(name);
    else if (c.conclusion === "CANCELLED") cancelled.push(name);
  }
  if (failing.length) return { state: "failure", failing };
  if (cancelled.length) return { state: "cancelled", failing: cancelled };
  if (pending) return { state: "pending", failing: [] };
  return { state: newest.size ? "success" : "none", failing: [] };
};

export const normalizePr = (n, ctx) => {
  const author = n.author?.login ?? "ghost";
  const commit = n.head?.nodes[0]?.commit;
  const pushedAt = commit?.checkSuites?.nodes[0]?.createdAt ?? commit?.committedDate ?? n.mergedAt ?? n.createdAt;
  const reviews = n.reviews.nodes.filter((r) => r.author && r.author.login !== author && !isBot(r.author));

  // QA approves with a real review, so GitHub's own decision cannot tell QA
  // from engineering. Classify every reviewer instead.
  const isQa = (r) => CONFIG.qaPhrase.test(r.body ?? "") || (ctx.qa.has(r.author.login) && !ctx.eng.has(r.author.login));
  const qaReviews = reviews.filter((r) => isQa(r) && r.state !== "CHANGES_REQUESTED" && (r.state === "APPROVED" || CONFIG.qaPhrase.test(r.body ?? "")));
  const qaApproval = qaReviews.at(-1) ? { login: qaReviews.at(-1).author.login, at: qaReviews.at(-1).submittedAt } : null;

  const latestBy = new Map();
  const latestAnyBy = new Map();
  for (const r of reviews) {
    if (isQa(r)) continue;
    latestAnyBy.set(r.author.login, r);
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") latestBy.set(r.author.login, r);
  }
  const engApprovals = [...latestBy.values()]
    .filter((r) => r.state === "APPROVED" && ctx.eng.has(r.author.login))
    .map((r) => ({ login: r.author.login, at: r.submittedAt }));
  const changesRequested = [...latestBy.values()]
    .filter((r) => r.state === "CHANGES_REQUESTED" && r.submittedAt > pushedAt)
    .map((r) => r.author.login);

  const requested = n.reviewRequests.nodes
    .map((x) => x.requestedReviewer?.login ?? (x.requestedReviewer?.slug ? `team/${x.requestedReviewer.slug}` : null))
    .filter(Boolean);
  const reviewedBy = [...latestAnyBy.values()]
    .filter((r) => latestBy.get(r.author.login)?.state !== "APPROVED" && !requested.includes(r.author.login) && pushedAt > r.submittedAt)
    .map((r) => r.author.login);

  const events = n.timelineItems.nodes;
  const lastOf = (type) => events.filter((e) => e.__typename === type).map((e) => e.createdAt).sort().at(-1) ?? null;
  const mineLast = n.reviews.nodes.filter((r) => r.author?.login === ctx.login && r.state !== "COMMENTED").at(-1);

  let unanswered = 0;
  for (const t of n.reviewThreads?.nodes ?? []) {
    const opener = t.opener.nodes[0];
    if (t.isResolved || t.isOutdated || !opener || isBot(opener.author) || NON_ACTIONABLE.test(opener.body)) continue;
    if (t.last.nodes[0]?.author?.login !== author) unanswered += 1;
  }

  return {
    number: n.number,
    repo: n.repository.nameWithOwner,
    defaultBranch: n.repository.defaultBranchRef?.name ?? "master",
    url: n.url,
    title: n.title,
    author,
    isDraft: n.isDraft,
    state: n.state,
    base: n.baseRefName,
    head: n.headRefName,
    keys: keysIn(n.title, n.headRefName),
    mergeable: n.mergeable,
    createdAt: n.createdAt,
    mergedAt: n.mergedAt,
    pushedAt,
    readyAt: lastOf("ReadyForReviewEvent"),
    requestedAt: lastOf("ReviewRequestedEvent"),
    requested,
    reviewedBy,
    engApprovals,
    qaApproval,
    changesRequested,
    unanswered,
    ci: n.state === "OPEN" ? ciState(n.rollup?.nodes[0]?.commit?.statusCheckRollup?.contexts.nodes ?? []) : { state: "none", failing: [] },
    myLastReview: mineLast ? { state: mineLast.state, at: mineLast.submittedAt } : null,
    parent: null,
  };
};

// GitHub only records a stack as a base branch name; rebuild it from heads.
const linkStacks = (prs) => {
  const byHead = new Map(prs.filter((p) => p.state === "OPEN").map((p) => [`${p.repo}:${p.head}`, p]));
  for (const p of prs) {
    if (p.state !== "OPEN" || p.base === p.defaultBranch) continue;
    const parent = byHead.get(`${p.repo}:${p.base}`);
    if (parent) p.parent = { number: parent.number, author: parent.author, keys: parent.keys, state: parent.state };
  }
};

const unreleased = async () => {
  const releases = await rest(`repos/${CONFIG.repo}/releases?per_page=10`);
  const published = releases.find((r) => !r.draft);
  const draft = releases.find((r) => r.draft) ?? null;
  if (!published) return null;
  const cmp = await rest(`repos/${CONFIG.repo}/compare/${published.tag_name}...master`);
  return {
    tag: published.tag_name,
    publishedAt: published.published_at,
    draft: draft && { tag: draft.tag_name, createdAt: draft.created_at },
    aheadBy: cmp.ahead_by,
    unreleased: cmp.commits.map((c) => {
      const title = c.commit.message.split("\n")[0];
      const number = Number(title.match(/\(#(\d+)\)\s*$/)?.[1]) || null;
      return {
        number,
        title: title.replace(/\s*\(#\d+\)\s*$/, ""),
        url: number ? `https://github.com/${CONFIG.repo}/pull/${number}` : c.html_url,
        author: c.author?.login ?? c.commit.author.name,
        keys: keysIn(title),
        mergedAt: c.commit.committer.date,
      };
    }),
  };
};

let teams = null;
const fetchTeams = async () => {
  if (teams && Date.now() - teams.at < 3_600_000) return teams;
  const members = (slug) => rest(`orgs/${CONFIG.org}/teams/${slug}/members?per_page=100`).then((xs) => new Set(xs.map((x) => x.login)));
  const [eng, qa, viewer] = await Promise.all([members(CONFIG.engineeringTeam), members(CONFIG.qaTeam), rest("user")]);
  teams = { eng, qa, login: viewer.login, at: Date.now() };
  return teams;
};

export const fetchGithub = async () => {
  const ctx = await fetchTeams();
  const since = new Date(Date.now() - 21 * 86_400_000).toISOString().slice(0, 10);
  const [mineOpen, mineMerged, repoOpen, release] = await Promise.all([
    searchPrs(`is:pr is:open author:${ctx.login} org:${CONFIG.org} archived:false`, { threads: true }),
    searchPrs(`is:pr is:merged author:${ctx.login} org:${CONFIG.org} merged:>=${since}`, { checks: false }),
    // Everyone else's PRs only need reviews, requests and heads: CI is read on yours.
    searchPrs(`is:pr is:open repo:${CONFIG.repo} archived:false`, { checks: false }),
    unreleased(),
  ]);
  const myPrs = [...mineOpen, ...mineMerged].map((n) => normalizePr(n, ctx));
  const mineByNumber = new Map(myPrs.map((p) => [`${p.repo}#${p.number}`, p]));
  const allPrs = repoOpen.map((n) => mineByNumber.get(`${n.repository.nameWithOwner}#${n.number}`) ?? normalizePr(n, ctx));
  linkStacks([...allPrs, ...myPrs.filter((p) => p.repo !== CONFIG.repo)]);
  return { login: ctx.login, myPrs, allPrs, release };
};
