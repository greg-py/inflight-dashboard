import { execSync } from "node:child_process";
import { CONFIG } from "./config.js";

let token;
const request = async (url, init = {}) => {
  token ??= process.env.GITHUB_TOKEN || execSync("gh auth token", { encoding: "utf8" }).trim();
  const res = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(CONFIG.timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};
const rest = (path) => request(`https://api.github.com/${path}`);
const graphql = async (query, variables) => {
  const body = await request("https://api.github.com/graphql", { method: "POST", body: JSON.stringify({ query, variables }) });
  if (body.errors?.length) throw new Error(body.errors[0].message);
  return body.data;
};

const PR_FIELDS = `
  number title url isDraft state createdAt mergedAt mergeable baseRefName headRefName
  author { login }
  repository { nameWithOwner defaultBranchRef { name } }
  reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { slug } } } }
  reviews(last: 60) { nodes { author { __typename login } state submittedAt body } }
  head: commits(last: 1) { nodes { commit { committedDate checkSuites(first: 1) { nodes { createdAt } } } } }
  timelineItems(last: 40, itemTypes: [REVIEW_REQUESTED_EVENT, READY_FOR_REVIEW_EVENT]) {
    nodes { __typename ... on ReviewRequestedEvent { createdAt } ... on ReadyForReviewEvent { createdAt } }
  }`;

// Only your own PRs need CI and review threads; everyone else's are context.
const CHECK_FIELDS = `
  rollup: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
    __typename
    ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state createdAt }
  } } } } } }
  reviewThreads(first: 80) { nodes {
    isResolved isOutdated
    opener: comments(first: 1) { nodes { author { __typename login } body } }
    last: comments(last: 1) { nodes { author { login } } }
  } }`;

const searchPrs = async (q, { full = false } = {}) => {
  const query = `query($q: String!, $after: String) {
    search(query: $q, type: ISSUE, first: 25, after: $after) {
      pageInfo { hasNextPage endCursor }
      nodes { ... on PullRequest { ${PR_FIELDS} ${full ? CHECK_FIELDS : ""} } }
    }
  }`;
  const nodes = [];
  let after = null;
  do {
    const { search } = await graphql(query, { q, after });
    nodes.push(...search.nodes.filter((n) => n?.number));
    after = search.pageInfo.hasNextPage ? search.pageInfo.endCursor : null;
  } while (after);
  return nodes;
};

const BOTS = /\[bot\]$|^(chatgpt-codex-connector|cursor|claude|copilot|github-actions|coderabbitai)$/i;
const isBot = (author) => !author || author.__typename === "Bot" || BOTS.test(author.login);
// Conventional Comments labels that ask for nothing.
const NON_ACTIONABLE = /^\s*[_*]{0,2}(praise|thought|note)\b/i;

export const keysIn = (...texts) => {
  const keys = new Set();
  for (const text of texts) {
    for (const m of String(text ?? "").matchAll(new RegExp(CONFIG.ticketKey.source, "gi"))) keys.add(`${CONFIG.project}-${m[1]}`);
  }
  return [...keys];
};

// The newest run of each check decides it: a failure that was re-run is running.
export const ciState = (contexts) => {
  const newest = new Map();
  for (const c of contexts) {
    const isRun = c.__typename === "CheckRun";
    const name = isRun ? c.name : c.context;
    if (CONFIG.ignoredChecks.includes(name)) continue;
    const id = isRun ? `${c.checkSuite?.workflowRun?.workflow?.name}/${name}` : `status/${name}`;
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
  return { state: pending ? "pending" : newest.size ? "success" : "none", failing: [] };
};

// QA approves with real reviews, so GitHub's review decision cannot tell QA
// from engineering: every reviewer is classified by team and review body.
export const normalizePr = (n, teams) => {
  const author = n.author?.login ?? "ghost";
  const commit = n.head?.nodes[0]?.commit;
  const pushedAt = commit?.checkSuites?.nodes[0]?.createdAt ?? commit?.committedDate ?? n.mergedAt ?? n.createdAt;

  const qaOnly = (login) => teams.qa.has(login) && !teams.eng.has(login);
  const isQa = (r) => CONFIG.qaPhrase.test(r.body ?? "") || qaOnly(r.author.login);
  const reviews = n.reviews.nodes.filter((r) => !isBot(r.author) && r.author.login !== author);
  const qaVerdict = reviews
    .filter((r) => r.state !== "CHANGES_REQUESTED" && (CONFIG.qaPhrase.test(r.body ?? "") || (r.state === "APPROVED" && qaOnly(r.author.login))))
    .at(-1);

  const latest = new Map();
  const decided = new Map();
  for (const r of reviews.filter((x) => !isQa(x))) {
    latest.set(r.author.login, r);
    if (r.state === "APPROVED" || r.state === "CHANGES_REQUESTED") decided.set(r.author.login, r);
  }
  const requested = n.reviewRequests.nodes
    .map(({ requestedReviewer: x }) => x?.login ?? (x?.slug && `team/${x.slug}`))
    .filter(Boolean);
  const lastEvent = (type) => n.timelineItems.nodes.filter((e) => e.__typename === type).map((e) => e.createdAt).sort().at(-1) ?? null;
  const myReview = n.reviews.nodes.filter((r) => r.author?.login === teams.login && r.state !== "COMMENTED").at(-1);

  let unanswered = 0;
  for (const t of n.reviewThreads?.nodes ?? []) {
    const opener = t.opener.nodes[0];
    if (t.isResolved || t.isOutdated || !opener || isBot(opener.author) || NON_ACTIONABLE.test(opener.body)) continue;
    if (t.last.nodes[0]?.author?.login !== author) unanswered += 1;
  }

  return {
    number: n.number,
    repo: n.repository.nameWithOwner,
    defaultBranch: n.repository.defaultBranchRef?.name ?? CONFIG.releaseBranch,
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
    readyAt: lastEvent("ReadyForReviewEvent"),
    requestedAt: lastEvent("ReviewRequestedEvent"),
    requested,
    engApprovals: [...decided.values()]
      .filter((r) => r.state === "APPROVED" && teams.eng.has(r.author.login))
      .map((r) => ({ login: r.author.login, at: r.submittedAt })),
    qaApproval: qaVerdict ? { login: qaVerdict.author.login, at: qaVerdict.submittedAt } : null,
    // Requested changes that no push has answered yet.
    changesRequested: [...decided.values()]
      .filter((r) => r.state === "CHANGES_REQUESTED" && r.submittedAt > pushedAt)
      .map((r) => r.author.login),
    // Reviewed without approving, answered with a push, and never asked again:
    // GitHub drops them from the requested list, so only a re-request brings them back.
    reviewedBy: [...latest.values()]
      .filter((r) => decided.get(r.author.login)?.state !== "APPROVED" && !requested.includes(r.author.login) && pushedAt > r.submittedAt)
      .map((r) => r.author.login),
    unanswered,
    ci: n.rollup ? ciState(n.rollup.nodes[0]?.commit?.statusCheckRollup?.contexts.nodes ?? []) : { state: "none", failing: [] },
    myReview: myReview ? { state: myReview.state, at: myReview.submittedAt } : null,
    parent: null,
  };
};

// GitHub records a stack only as a base branch name; rebuild it from heads.
const linkStacks = (prs) => {
  const byHead = new Map(prs.filter((p) => p.state === "OPEN").map((p) => [`${p.repo}:${p.head}`, p]));
  for (const p of prs) {
    if (p.state !== "OPEN" || p.base === p.defaultBranch) continue;
    const parent = byHead.get(`${p.repo}:${p.base}`);
    if (parent) p.parent = { number: parent.number, author: parent.author, keys: parent.keys };
  }
};

const releaseGap = async () => {
  const { tag_name: tag } = await rest(`repos/${CONFIG.repo}/releases/latest`);
  const cmp = await rest(`repos/${CONFIG.repo}/compare/${tag}...${CONFIG.releaseBranch}`);
  return {
    tag,
    aheadBy: cmp.ahead_by,
    unreleased: cmp.commits.map((c) => {
      const subject = c.commit.message.split("\n")[0];
      const number = Number(subject.match(/\(#(\d+)\)\s*$/)?.[1]) || null;
      return {
        number,
        title: subject.replace(/\s*\(#\d+\)\s*$/, ""),
        url: number ? `https://github.com/${CONFIG.repo}/pull/${number}` : c.html_url,
        author: c.author?.login ?? c.commit.author.name,
        keys: keysIn(subject),
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
  const t = await fetchTeams();
  const since = new Date(Date.now() - CONFIG.mergedLookbackDays * 86_400_000).toISOString().slice(0, 10);
  const [mineOpen, mineMerged, repoOpen, release] = await Promise.all([
    searchPrs(`is:pr is:open author:${t.login} org:${CONFIG.org} archived:false`, { full: true }),
    searchPrs(`is:pr is:merged author:${t.login} org:${CONFIG.org} merged:>=${since}`),
    searchPrs(`is:pr is:open repo:${CONFIG.repo} archived:false`),
    releaseGap(),
  ]);
  const myPrs = [...mineOpen, ...mineMerged].map((n) => normalizePr(n, t));
  const mine = new Map(myPrs.map((p) => [`${p.repo}#${p.number}`, p]));
  const otherPrs = repoOpen.filter((n) => !mine.has(`${n.repository.nameWithOwner}#${n.number}`)).map((n) => normalizePr(n, t));
  linkStacks([...myPrs, ...otherPrs]);
  return { login: t.login, myPrs, otherPrs, release };
};
