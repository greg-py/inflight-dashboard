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
  buildInbox,
  reviewerWaits,
  prNumbersInCommits,
  buildShipping,
  withStacks,
  statusSince,
  daysSince,
  buildPodWatch,
  buildGoalie,
  promptForPr,
  promptForReview,
} from "./model.js";
import { fetchAiUsage } from "./ai-usage.js";

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

const graphql = async (query, variables, attempt = 1) => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${githubToken()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    // Gateway errors here are nearly always a momentary blip; one retry costs
    // little and saves a banner over data that is about to arrive anyway.
    if (TRANSIENT_STATUSES.has(res.status) && attempt <= CONFIG.upstreamRetries) {
      return graphql(query, variables, attempt + 1);
    }
    const timedOut = res.status === 504 ? " (timed out)" : "";
    throw new Error(`GitHub GraphQL ${res.status}${timedOut}${await failureReason(res)}`);
  }
  const data = await res.json();
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
  viewerLatestReview { state }
  commits(last: 1) { nodes { commit { committedDate statusCheckRollup { contexts(first: 100) {
    nodes { ... on CheckRun { name conclusion status } ... on StatusContext { context state } }
  } } } } }`;

// Only your own pull requests need the review detail; the queue of PRs waiting
// on you renders from the core fields alone.
const REVIEW_DETAIL_FIELDS = `number
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

const MERGED_FIELDS = `number title url headRefName mergedAt repository { nameWithOwner }`;

// The pod's pull requests need only enough to say whether one has stalled.
// Asking for their review threads as well is what pushed the original single
// query over GitHub's time limit, and none of it reaches a pod row.
const POD_FIELDS = `${CORE_FIELDS}
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login } ... on Team { name } } } }`;

const searchQuery = (fields) =>
  `query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ... on PullRequest {
    ${fields}
  } } } }`;

const basePrOf = (node, now) => {
  const lastCommit = node.commits?.nodes?.[0]?.commit;
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
  return {
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
    qaGate: qaGateState(lastCommit?.statusCheckRollup?.contexts?.nodes),
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
    ci: effectiveCi(lastCommit?.statusCheckRollup?.contexts?.nodes),
    ageDays: Math.max(0, Math.floor((now - Date.parse(node.createdAt)) / 86_400_000)),
    // The clock a re-review runs on: time since the fix landed, not since the
    // review was first requested.
    lastCommitDaysAgo: lastCommit?.committedDate
      ? Math.max(0, Math.floor((now - Date.parse(lastCommit.committedDate)) / 86_400_000))
      : null,
  };
};

const withCiStuck = (pr, now) => ({
  ...pr,
  ciStuckHours:
    pr.ci === "pending" && pr.lastCommitAt && now - Date.parse(pr.lastCommitAt) > CONFIG.ciStuckMs
      ? Math.floor((now - Date.parse(pr.lastCommitAt)) / 3_600_000)
      : 0,
});

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
  const [core, detail, reviews, merged, pod] = await Promise.all([
    graphql(searchQuery(CORE_FIELDS), { q: CONFIG.githubSearch }),
    graphql(searchQuery(REVIEW_DETAIL_FIELDS), { q: CONFIG.githubSearch }),
    graphql(searchQuery(CORE_FIELDS), { q: CONFIG.githubReviewSearch }),
    graphql(searchQuery(MERGED_FIELDS), {
      q: `${CONFIG.githubSearch.replace("is:open", "is:merged")} merged:>=${mergedSince}`,
    }),
    graphql(searchQuery(POD_FIELDS), { q: CONFIG.githubPodSearch }),
  ]);
  const now = Date.now();
  const prNodes = (data) => (data?.search?.nodes ?? []).filter((node) => node.number !== undefined);
  // The two passes over your own pull requests are joined by number. A pull
  // request that lands between the two calls simply arrives without its review
  // detail, which reads as no threads rather than as wrong ones.
  const detailByNumber = new Map(prNodes(detail).map((node) => [node.number, node]));
  // Stacks are a property of the whole set, not of any one pull request, so the
  // chain is resolved across all of them before anything is categorized — a row
  // cannot know it is blocked until it knows what sits underneath it.
  const mine = withStacks(
    prNodes(core).map((node) =>
      withCiStuck(basePrOf({ ...node, ...detailByNumber.get(node.number) }, now), now),
    ),
  ).map((pr) => ({ ...pr, ...categorizePr(pr), action: promptForPr(pr) }));
  return {
    mine,
    // Everything open in the org that is not mine. buildPodWatch keeps only the
    // ones carrying a pod ticket key, so no roster of GitHub logins is needed.
    podPrs: prNodes(pod).map((node) => {
      const pr = basePrOf(node, now);
      return { ...pr, pendingReviewers: reviewerWaits(node.reviewRequests?.nodes, [], now) };
    }),
    reviewRequests: prNodes(reviews)
      .map((node) => mapReviewPr(node, now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    merged: prNodes(merged).map((node) => ({
      number: node.number,
      title: node.title,
      url: node.url,
      headRefName: node.headRefName,
      mergedAt: node.mergedAt ?? null,
      repo: node.repository.nameWithOwner,
    })),
  };
};

// The GitHub inbox: unread notification threads. REST rather than GraphQL —
// notifications have no GraphQL surface.
export const fetchNotifications = async () => {
  const res = await fetch("https://api.github.com/notifications?participating=false", {
    headers: {
      Authorization: `Bearer ${githubToken()}`,
      Accept: "application/vnd.github+json",
    },
    signal: AbortSignal.timeout(CONFIG.probeTimeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub notifications ${res.status}${await failureReason(res)}`);
  return buildInbox(await res.json());
};

const ghRest = async (path) => {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { Authorization: `Bearer ${githubToken()}`, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(CONFIG.probeTimeoutMs),
  });
  if (!res.ok) throw new Error(`GitHub ${path.split("/").at(-1)} ${res.status}`);
  return res.json();
};

// A repo's default branch never moves in practice; resolve it once.
const defaultBranches = new Map();
const defaultBranchOf = async (repo) => {
  if (!defaultBranches.has(repo)) {
    defaultBranches.set(repo, (await ghRest(`repos/${repo}`)).default_branch);
  }
  return defaultBranches.get(repo);
};

// Comparing the last release tag to the default branch answers exactly what has
// merged but not shipped — more reliable than merge timestamps, which say
// nothing about which commits a tag actually contains.
const releaseGapOf = async (repo) => {
  const [release, branch] = await Promise.all([
    ghRest(`repos/${repo}/releases/latest`),
    defaultBranchOf(repo),
  ]);
  const diff = await ghRest(`repos/${repo}/compare/${release.tag_name}...${branch}`);
  return {
    tag: release.tag_name,
    publishedAt: release.published_at,
    ahead: diff.ahead_by ?? 0,
    // The compare endpoint stops at 250 commits; say so rather than under-report.
    truncated: (diff.ahead_by ?? 0) > (diff.commits?.length ?? 0),
    numbers: prNumbersInCommits((diff.commits ?? []).map((entry) => entry.commit?.message)),
  };
};

export const fetchShipping = async (mergedPrs) => {
  const repos = [...new Set((mergedPrs ?? []).map((pr) => pr.repo))];
  const gaps = await Promise.all(
    repos.map(async (repo) => {
      try {
        return [repo, await releaseGapOf(repo)];
      } catch (err) {
        return [repo, { error: err.message }];
      }
    }),
  );
  return buildShipping(mergedPrs, new Map(gaps));
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

// `updated` moves on every comment and every bulk grooming edit, so the age
// that actually matters — how long this has sat in its current status — can
// only come from the changelog.
const JIRA_FIELDS = "summary,status,issuetype,parent,updated,priority,labels,assignee";

export const fetchJiraIssues = async (jql) => {
  const auth = jiraAuth();
  const issues = [];
  let nextPageToken;
  do {
    const params = new URLSearchParams({
      jql,
      fields: JIRA_FIELDS,
      expand: "changelog",
      maxResults: "100",
    });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const res = await fetch(`${CONFIG.jiraBaseUrl}/rest/api/3/search/jql?${params}`, {
      headers: { Authorization: auth, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Jira ${res.status}${await failureReason(res)}`);
    const data = await res.json();
    issues.push(...(data.issues ?? []));
    nextPageToken = data.nextPageToken;
  } while (nextPageToken);
  return issues;
};

export const fetchJira = () => fetchJiraIssues(CONFIG.jiraJql);

// Pod rows are flattened here rather than in the domain, so buildPodWatch stays
// a pure function over a shape that has nothing to do with Jira's REST wire
// format.
const podIssueOf = (issue) => ({
  key: issue.key,
  url: `${CONFIG.jiraBaseUrl}/browse/${issue.key}`,
  summary: issue.fields.summary,
  status: issue.fields.status?.name ?? "Unknown",
  assignee: issue.fields.assignee?.displayName ?? null,
  priority: issue.fields.priority?.name ?? null,
  labels: issue.fields.labels ?? [],
  updated: issue.fields.updated,
  statusSince: statusSince(issue.changelog),
});

export const fetchPod = async () => {
  const [pod, lead] = await Promise.all([
    fetchJiraIssues(CONFIG.jiraPodJql.replace("%POD%", CONFIG.podName)),
    fetchJiraIssues(CONFIG.jiraLeadJql),
  ]);
  return { pod: pod.map(podIssueOf), lead: lead.map(podIssueOf) };
};

// The goalie rotation exists only as a bot announcement in one Slack channel.
// Without a token the strip says so and nothing else on the board is affected —
// the same way a capacity probe fails.
export const fetchGoalie = async () => {
  const token = process.env.SLACK_TOKEN;
  if (!token) throw new Error("set SLACK_TOKEN in .env (needs channels:history)");
  const params = new URLSearchParams({ channel: CONFIG.slackGoalieChannel, limit: "60" });
  const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(CONFIG.probeTimeoutMs),
  });
  if (!res.ok) throw new Error(`Slack ${res.status}`);
  const data = await res.json();
  // Slack answers 200 with ok:false for auth and scope problems, so the status
  // code alone never says whether this worked.
  if (!data.ok) throw new Error(`Slack: ${data.error}`);
  return buildGoalie(data.messages, process.env.SLACK_USER_ID ?? null);
};

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
  const [jira, github, inbox, aiUsage, pod, goalie] = await Promise.allSettled([
    fetchJira(),
    fetchGithub(),
    fetchNotifications(),
    fetchAiUsage(),
    fetchPod(),
    fetchGoalie(),
  ]);
  const jiraResult = settle("jira", jira, []);
  const githubResult = settle("github", github, {
    mine: [],
    reviewRequests: [],
    merged: [],
    podPrs: [],
  });
  const inboxResult = settle("inbox", inbox, []);
  const usageResult = settle("aiUsage", aiUsage, []);
  const podResult = settle("pod", pod, { pod: [], lead: [] });
  const goalieResult = settle("goalie", goalie, null);
  // Shipping needs the merged set first, so it settles after the fan-out rather
  // than inside it.
  const shipping = await fetchShipping(githubResult.value.merged).then(
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
    github: githubResult.value,
    inbox: { items: inboxResult.value, error: inboxResult.status.error ?? null },
    shipping: { ...shippingResult.value, error: shippingResult.status.error ?? null },
    aiUsage: usageResult.value,
    pod: {
      name: CONFIG.podName,
      items: buildPodWatch(podResult.value.pod, podResult.value.lead, githubResult.value.podPrs),
      error: podResult.status.error ?? null,
    },
    goalie: { value: goalieResult.value, error: goalieResult.status.error ?? null },
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
