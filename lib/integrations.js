// Upstream fetchers: Jira REST + GitHub GraphQL, with a TTL cache and
// stale-over-broken fallback shared by every dashboard tab.
import { execSync } from "node:child_process";
import { CONFIG } from "./config.js";
import {
  effectiveCi,
  qaGateState,
  extractTicketKeys,
  categorizePr,
  summarizeThreads,
  reviewerWaits,
  prNumbersInCommits,
  buildShipping,
  withStacks,
  daysSince,
  ciStuckHours,
  promptForPr,
  promptForReview,
} from "./model.js";

// One `gh auth token` spawn per process, not one per request.
let cachedToken = null;
const githubToken = () => {
  cachedToken ??= process.env.GITHUB_TOKEN || execSync("gh auth token", { encoding: "utf8" }).trim();
  return cachedToken;
};

// A gateway failure arrives as an HTML error page. Quoting that at the reader
// fills the banner with GitHub's page source and says nothing, so only a JSON
// or short text body is worth repeating.
export const failureReason = async (res) => {
  const body = (await res.text().catch(() => "")).trim();
  if (!body || body.startsWith("<")) return "";
  try {
    const parsed = JSON.parse(body);
    const message = parsed.errorMessages?.[0] ?? parsed.message ?? parsed.error;
    return message ? `: ${String(message).slice(0, 160)}` : "";
  } catch {
    return `: ${body.slice(0, 160)}`;
  }
};

const TRANSIENT_STATUSES = new Set([502, 503, 504]);

// Every upstream call gets a deadline and the same retry budget. A hung call
// otherwise holds the shared refresh for Node's five-minute default, and a
// dropped connection throws rather than answering 5xx, so it was never retried
// at all.
const upstreamFetch = async (label, url, init, attempt = 1) => {
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(CONFIG.upstreamTimeoutMs) });
  } catch (err) {
    if (attempt <= CONFIG.upstreamRetries) return upstreamFetch(label, url, init, attempt + 1);
    throw new Error(
      err.name === "TimeoutError"
        ? `${label}: no answer in ${CONFIG.upstreamTimeoutMs / 1000}s`
        : `${label}: ${err.cause?.code ?? err.message}`,
    );
  }
  // Gateway errors are nearly always a momentary blip; one retry costs little
  // and saves a banner over data that is about to arrive anyway.
  if (TRANSIENT_STATUSES.has(res.status) && attempt <= CONFIG.upstreamRetries) {
    return upstreamFetch(label, url, init, attempt + 1);
  }
  return res;
};

const graphql = async (query, variables, attempt = 1) => {
  const res = await upstreamFetch("GitHub GraphQL", "https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${githubToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const timedOut = res.status === 504 ? " (timed out)" : "";
    throw new Error(`GitHub GraphQL ${res.status}${timedOut}${await failureReason(res)}`);
  }
  // A query that runs long enough can answer 200 and then have its body cut
  // off mid-write. That reaches the reader as "Unexpected end of JSON input",
  // which names the symptom and hides both the cause and the fact that it is
  // transient — so it is caught, named, and retried like any other blip.
  const body = await res.text().catch(() => "");
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    if (attempt <= CONFIG.upstreamRetries) return graphql(query, variables, attempt + 1);
    throw new Error(`GitHub GraphQL: truncated response (${body.length} bytes) — query too slow`);
  }
  if (data.errors) throw new Error(`GitHub GraphQL: ${data.errors[0]?.message}`);
  return data.data;
};

// GitHub allows a GraphQL request roughly ten seconds, and asking for every
// pull request's checks, threads and review timeline at once sat right on that
// edge — slow on a good day, a 504 on a bad one. The same work runs as parallel
// calls that each stay well inside the limit.
const CORE_FIELDS = `number title url isDraft headRefName baseRefName mergeable reviewDecision createdAt updatedAt
  additions deletions
  author { login }
  repository { nameWithOwner defaultBranchRef { name } }
  viewerLatestReview { state }`;

// The checks are their own call because telling one workflow's job from
// another's with the same name costs a join per check run — about as much as
// everything else about the pull request put together.
const CHECK_FIELDS = `number repository { nameWithOwner }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { contexts(first: 100) { nodes {
    ... on CheckRun { name conclusion status startedAt checkSuite { workflowRun { workflow { name } } } }
    ... on StatusContext { context state createdAt }
  } } } } } }`;

// Only your own pull requests need the review detail; the queue of PRs waiting
// on you renders from the core fields and checks alone.
const REVIEW_DETAIL_FIELDS = `number repository { nameWithOwner }
  latestOpinionatedReviews(first: 10) { nodes { state submittedAt } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }
  timelineItems(last: 20, itemTypes: [REVIEW_REQUESTED_EVENT]) { nodes { ... on ReviewRequestedEvent {
    createdAt requestedReviewer { __typename ... on User { login } ... on Team { name } }
  } } }
  reviewThreads(first: 50) { nodes {
    isResolved isOutdated
    firstComment: comments(first: 1) { nodes { body author { login __typename } } }
    lastComment: comments(last: 1) { nodes { createdAt author { login __typename } } }
  } }`;

const MERGED_FIELDS = `number title url headRefName baseRefName mergedAt
  repository { nameWithOwner defaultBranchRef { name } }`;

const searchQuery = (fields) =>
  `query($q: String!, $after: String) { search(query: $q, type: ISSUE, first: 50, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ${fields} } }
  } }`;

// Search answers fifty at a time. One page used to be the whole answer, until a
// fortnight of merges came within reach of it — and a page that silently stops
// is worse than a slow one: the missing merges drop out of "Merged, not
// shipped", and their tickets start offering to implement work already done.
const searchPrs = async (fields, q) => {
  const nodes = [];
  let after = null;
  do {
    const { search } = await graphql(searchQuery(fields), { q, after });
    nodes.push(...(search?.nodes ?? []).filter((node) => node.number !== undefined));
    after = search?.pageInfo?.hasNextPage ? search.pageInfo.endCursor : null;
  } while (after);
  return nodes;
};

// Numbers repeat across repos, so a pull request is only ever named by both.
const prId = (node) => `${node.repository?.nameWithOwner}#${node.number}`;

const basePrOf = (node, now) => {
  const lastCommit = node.commits?.nodes?.[0]?.commit;
  const checks = lastCommit?.statusCheckRollup?.contexts?.nodes;
  // Flatten the two aliased comment edges into the shape the domain reads, so
  // thread classification stays pure and testable.
  const endOf = (edge) => {
    const comment = edge?.nodes?.[0];
    return comment
      ? {
          body: comment.body ?? "",
          login: comment.author?.login ?? null,
          isBot: comment.author?.__typename === "Bot",
          createdAt: comment.createdAt ?? null,
        }
      : null;
  };
  const threads = summarizeThreads(
    (node.reviewThreads?.nodes ?? []).map((thread) => ({
      isResolved: thread.isResolved,
      isOutdated: thread.isOutdated,
      firstComment: endOf(thread.firstComment),
      lastComment: endOf(thread.lastComment),
    })),
    node.author?.login,
  );
  const changesRequestedTimes = (node.latestOpinionatedReviews?.nodes ?? [])
    .filter((review) => review.state === "CHANGES_REQUESTED" && review.submittedAt)
    .map((review) => review.submittedAt)
    .sort();
  const pr = {
    number: node.number,
    title: node.title,
    url: node.url,
    repo: node.repository.nameWithOwner,
    author: node.author?.login ?? "unknown",
    isDraft: node.isDraft,
    headRefName: node.headRefName,
    baseRefName: node.baseRefName ?? null,
    // Whether this can merge on its own or is queued behind another pull
    // request comes down to one comparison, so it is made once here.
    baseIsDefault: node.baseRefName === node.repository?.defaultBranchRef?.name,
    mergeable: node.mergeable,
    reviewDecision: node.reviewDecision,
    viewerReviewState:
      node.viewerLatestReview?.state === "PENDING" ? null : (node.viewerLatestReview?.state ?? null),
    // Threads still wanting something from you, praise and already-answered
    // feedback excluded. These survive approval: a reviewer who approves and
    // leaves notes inline still left notes. Bot threads (codex, cursor, CodeQL)
    // are counted apart — bots review every push, often post-approval, and
    // their findings need their own triage. Codex badges its findings by
    // priority and only P1 counts; the rest are dropped, not shown. Both
    // self-clear when you reply.
    ...threads,
    qaGate: qaGateState(checks),
    lastCommitAt: lastCommit?.committedDate ?? null,
    changesRequestedAt: changesRequestedTimes.at(-1) ?? null,
    pendingReviewers: reviewerWaits(
      node.reviewRequests?.nodes,
      node.timelineItems?.nodes,
      now,
    ),
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    additions: node.additions ?? 0,
    deletions: node.deletions ?? 0,
    ci: effectiveCi(checks),
    ageDays: daysSince(node.createdAt, now),
    // The clock a re-review runs on: time since the fix landed, not since the
    // review was first requested.
    lastCommitDaysAgo: daysSince(lastCommit?.committedDate, now),
  };
  return { ...pr, ciStuckHours: ciStuckHours(pr, now) };
};

export const mapReviewPr = (node, now) => {
  const pr = basePrOf(node, now);
  const ticketKey = extractTicketKeys(pr)[0] ?? null;
  return {
    ...pr,
    id: `${pr.repo}#${pr.number}`,
    ticketKey,
    ticketUrl: ticketKey ? `${CONFIG.jiraBaseUrl}/browse/${ticketKey}` : null,
    action: promptForReview(pr),
  };
};

export const fetchGithub = async () => {
  const mergedSince = new Date(Date.now() - CONFIG.mergedLookbackDays * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const [core, checks, detail, reviews, merged] = await Promise.all([
    searchPrs(CORE_FIELDS, CONFIG.githubSearch),
    searchPrs(CHECK_FIELDS, CONFIG.githubSearch),
    searchPrs(REVIEW_DETAIL_FIELDS, CONFIG.githubSearch),
    // The review queue is short, so it can afford its checks in the same call.
    searchPrs(`${CORE_FIELDS} ${CHECK_FIELDS}`, CONFIG.githubReviewSearch),
    searchPrs(
      MERGED_FIELDS,
      `${CONFIG.githubSearch.replace("is:open", "is:merged")} merged:>=${mergedSince}`,
    ),
  ]);
  const now = Date.now();
  // The passes over your own pull requests are joined by repo and number. A
  // pull request that lands between the calls simply arrives without its
  // checks or review detail, which reads as none rather than as wrong ones.
  // The core fields are spread last, since they are the only pass that knows
  // the repo's default branch.
  const checksById = new Map(checks.map((node) => [prId(node), node]));
  const detailById = new Map(detail.map((node) => [prId(node), node]));
  // Stacks are a property of the whole set, not of any one pull request, so the
  // chain is resolved across all of them before anything is categorized — a row
  // cannot know it is blocked until it knows what sits underneath it.
  const mine = withStacks(
    core.map((node) =>
      basePrOf({ ...checksById.get(prId(node)), ...detailById.get(prId(node)), ...node }, now),
    ),
  ).map((pr) => ({ ...pr, ...categorizePr(pr), action: promptForPr(pr) }));
  return {
    mine,
    reviewRequests: reviews
      .map((node) => mapReviewPr(node, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    merged: merged.map((node) => ({
      number: node.number,
      title: node.title,
      url: node.url,
      headRefName: node.headRefName,
      baseRefName: node.baseRefName ?? null,
      baseIsDefault: node.baseRefName === node.repository?.defaultBranchRef?.name,
      mergedAt: node.mergedAt ?? null,
      repo: node.repository.nameWithOwner,
    })),
  };
};

// Comparing the last release tag to the default branch answers exactly what has
// merged but not shipped — more reliable than merge timestamps, which say
// nothing about which commits a tag actually contains.
//
// GraphQL rather than REST: the REST compare returns every changed file's
// patch alongside the commits — over a megabyte for a day's gap — and the
// board reads nothing but the commit subjects. The whole message is asked for
// all the same, because messageHeadline cuts a subject off at about seventy
// characters, and the "(#7562)" a squash merge ends on goes with it.
const RELEASE_QUERY = `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {
  latestRelease { tagName publishedAt }
  defaultBranchRef { name }
} }`;

const COMPARE_QUERY = `query($owner: String!, $name: String!, $tag: String!, $head: String!, $after: String) {
  repository(owner: $owner, name: $name) { ref(qualifiedName: $tag) { compare(headRef: $head) {
    aheadBy
    commits(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { message } }
  } } } }`;

const releaseGapOf = async (repo) => {
  const [owner, name] = repo.split("/");
  const { repository } = await graphql(RELEASE_QUERY, { owner, name });
  // A repo that has never released has no answer to give, which is different
  // from a lookup that failed.
  const release = repository?.latestRelease;
  if (!release) return { none: true };
  const messages = [];
  let ahead = 0;
  let after = null;
  do {
    const data = await graphql(COMPARE_QUERY, {
      owner,
      name,
      tag: `refs/tags/${release.tagName}`,
      head: repository.defaultBranchRef.name,
      after,
    });
    const compare = data.repository?.ref?.compare;
    if (!compare) throw new Error(`tag ${release.tagName} not found`);
    ahead = compare.aheadBy ?? 0;
    messages.push(...compare.commits.nodes.map((commit) => commit.message));
    after =
      compare.commits.pageInfo.hasNextPage && messages.length < CONFIG.releaseGapCommitLimit
        ? compare.commits.pageInfo.endCursor
        : null;
  } while (after);
  return {
    tag: release.tagName,
    publishedAt: release.publishedAt,
    ahead,
    // Say so rather than under-report when the gap is deeper than was read.
    truncated: ahead > messages.length,
    numbers: prNumbersInCommits(messages),
  };
};

// A lookup that failed says nothing about the release, so it keeps the last
// answer that repo gave rather than claiming it has never released.
const lastGoodGaps = new Map();

export const fetchShipping = async (mergedPrs, openPrs) => {
  const repos = [...new Set((mergedPrs ?? []).map((pr) => pr.repo))];
  const gaps = await Promise.all(
    repos.map(async (repo) => {
      try {
        const gap = await releaseGapOf(repo);
        lastGoodGaps.set(repo, gap);
        return [repo, gap];
      } catch (err) {
        return [repo, lastGoodGaps.get(repo) ?? { error: err.message }];
      }
    }),
  );
  return buildShipping(mergedPrs, new Map(gaps), openPrs);
};

const jiraAuth = () => {
  const email = process.env.JIRA_EMAIL;
  const token = process.env.JIRA_API_TOKEN;
  if (!email || !token) {
    throw new Error(
      "Set JIRA_EMAIL and JIRA_API_TOKEN in .env (create a token at https://id.atlassian.com/manage-profile/security/api-tokens)",
    );
  }
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
};

const JIRA_FIELDS = "summary,status,issuetype,parent,updated,priority,labels,assignee";

export const fetchJiraIssues = async (jql) => {
  const auth = jiraAuth();
  const issues = [];
  let nextPageToken;
  do {
    const params = new URLSearchParams({ jql, fields: JIRA_FIELDS, maxResults: "100" });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const res = await upstreamFetch("Jira", `${CONFIG.jiraBaseUrl}/rest/api/3/search/jql?${params}`, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Jira ${res.status}${await failureReason(res)}`);
    const data = await res.json();
    issues.push(...(data.issues ?? []));
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
  return issues;
};

// `updated` moves on every comment and every bulk grooming edit, so how long a
// ticket has sat in its current status can only come from the changelog. Only
// a QA wait ever shows that age, and expanding the changelog on every ticket
// made the search thirteen times heavier to answer a question about two of
// them — so the history is fetched for those alone, and status changes only.
const withStatusHistory = async (issues) => {
  const timed = issues.filter((issue) =>
    CONFIG.qaHoldStatuses.includes(issue.fields?.status?.name?.toLowerCase()),
  );
  if (timed.length === 0) return issues;
  const histories = new Map();
  let nextPageToken;
  do {
    // A POST, but a read: the bulk endpoint takes its issue list as a body.
    const res = await upstreamFetch("Jira changelog", `${CONFIG.jiraBaseUrl}/rest/api/3/changelog/bulkfetch`, {
      method: "POST",
      headers: { Authorization: jiraAuth(), Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        issueIdsOrKeys: timed.map((issue) => issue.key),
        fieldIds: ["status"],
        maxResults: 1000,
        ...(nextPageToken ? { nextPageToken } : {}),
      }),
    });
    if (!res.ok) throw new Error(`Jira changelog ${res.status}${await failureReason(res)}`);
    const data = await res.json();
    for (const log of data.issueChangeLogs ?? []) {
      // This endpoint stamps changes in epoch milliseconds; the search API,
      // and everything downstream, speaks ISO.
      const changes = (log.changeHistories ?? []).map((history) => ({
        ...history,
        created: new Date(history.created).toISOString(),
      }));
      histories.set(log.issueId, [...(histories.get(log.issueId) ?? []), ...changes]);
    }
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
  return issues.map((issue) =>
    histories.has(issue.id) ? { ...issue, changelog: { histories: histories.get(issue.id) } } : issue,
  );
};

export const fetchJira = async () => withStatusHistory(await fetchJiraIssues(CONFIG.jiraJql));

// Tickets I am Engineering Lead on that nobody has picked up. Its own query
// rather than a widened jiraJql, because the board must never pull in work I
// lead that someone else is already assigned to — that is theirs.
export const fetchLeadUnassigned = () =>
  fetchJiraIssues(
    CONFIG.jiraLeadUnassignedJql.replace("%DAYS%", String(CONFIG.leadUnassignedLookbackDays)),
  );

// Cached upstream: one fetch per TTL shared by all consumers; failures serve
// the last good data marked stale.
let cache = null;
let fetchedAt = 0;
let inFlight = null;
const lastGood = new Map();

// Each source resolves to its own value plus a status: fresh, or the last good
// value labelled with when it was captured. One failing source never blanks the
// rest of the board.
const settle = (name, result, fallback) => {
  if (result.status === "fulfilled") {
    lastGood.set(name, { value: result.value, at: Date.now() });
    return { value: result.value, status: { ok: true } };
  }
  const prior = lastGood.get(name);
  return {
    value: prior?.value ?? fallback,
    status: {
      ok: false,
      error: result.reason.message,
      ...(prior ? { staleDataFrom: new Date(prior.at).toISOString() } : {}),
    },
  };
};

const fetchUpstream = async () => {
  const [jira, github, lead] = await Promise.allSettled([
    fetchJira(),
    fetchGithub(),
    fetchLeadUnassigned(),
  ]);
  const jiraResult = settle("jira", jira, []);
  const githubResult = settle("github", github, { mine: [], reviewRequests: [], merged: [] });
  const leadResult = settle("lead", lead, []);
  // Shipping needs the merged set first, so it settles after the fan-out rather
  // than inside it.
  const shipping = await fetchShipping(githubResult.value.merged, githubResult.value.mine).then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
  const shippingResult = settle("shipping", shipping, { items: [], note: null });
  return {
    fetchedAt: new Date().toISOString(),
    // Only the two sources the board itself is built from raise a banner; the
    // side panels report their own trouble inline.
    sources: { jira: jiraResult.status, github: githubResult.status },
    jiraIssues: jiraResult.value,
    leadIssues: leadResult.value,
    github: githubResult.value,
    shipping: { ...shippingResult.value, error: shippingResult.status.error ?? null },
  };
};

export const getUpstream = async () => {
  if (cache && Date.now() - fetchedAt < CONFIG.upstreamTtlMs) return cache;
  if (!inFlight) {
    inFlight = fetchUpstream()
      .then((result) => {
        cache = result;
        fetchedAt = Date.now();
        return result;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
};
