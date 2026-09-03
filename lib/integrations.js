// Upstream fetchers: Jira REST + GitHub GraphQL, with a TTL cache and
// stale-over-broken fallback shared by every dashboard tab.
import { execSync } from "node:child_process";
import { CONFIG } from "./config.js";
import { effectiveCi, qaGateState, extractTicketKeys, categorizePr } from "./model.js";

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
  reviewThreads(first: 50) { nodes { isResolved comments(last: 1) { nodes { author { login __typename } } } } }
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
    // Human threads: unresolved, last word isn't the author's, never on
    // approved PRs (approval supersedes stale human threads). Bot threads
    // (codex et al) are counted separately and survive approval — bots review
    // every push, often post-approval, and their findings still need triage.
    // Both self-clear when the PR author replies, becoming the last author.
    openThreads:
      node.reviewDecision === "APPROVED"
        ? 0
        : (node.reviewThreads?.nodes ?? []).filter((thread) => {
            const last = thread.comments?.nodes?.[0]?.author;
            return !thread.isResolved && last?.login !== node.author?.login && last?.__typename !== "Bot";
          }).length,
    botThreads: (node.reviewThreads?.nodes ?? []).filter(
      (thread) => !thread.isResolved && thread.comments?.nodes?.[0]?.author?.__typename === "Bot",
    ).length,
    qaGate: qaGateState(lastCommit?.statusCheckRollup?.contexts?.nodes),
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
  };
};

export const fetchGithub = async () => {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${githubToken()}`, "Content-Type": "application/json" },
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
      const pr = withCiStuck(basePrOf(node, now), now);
      return { ...pr, ...categorizePr(pr) };
    }),
    reviewRequests: prNodes(data.data.reviews)
      .map((node) => mapReviewPr(node, now))
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

export const fetchJira = async () => {
  const auth = jiraAuth();
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

// Cached upstream: one fetch per TTL shared by all consumers; failures serve
// the last good data marked stale.
let cache = null;
let fetchedAt = 0;
let inFlight = null;
const lastGood = { jira: null, jiraAt: 0, github: null, githubAt: 0 };

const fetchUpstream = async () => {
  const [jira, github] = await Promise.allSettled([fetchJira(), fetchGithub()]);
  const now = Date.now();
  if (jira.status === "fulfilled") {
    lastGood.jira = jira.value;
    lastGood.jiraAt = now;
  }
  if (github.status === "fulfilled") {
    lastGood.github = github.value;
    lastGood.githubAt = now;
  }
  const sourceStatus = (result, at) =>
    result.status === "fulfilled"
      ? { ok: true }
      : {
          ok: false,
          error: result.reason.message,
          ...(at ? { staleDataFrom: new Date(at).toISOString() } : {}),
        };
  return {
    fetchedAt: new Date().toISOString(),
    sources: { jira: sourceStatus(jira, lastGood.jiraAt), github: sourceStatus(github, lastGood.githubAt) },
    jiraIssues: jira.status === "fulfilled" ? jira.value : (lastGood.jira ?? []),
    github:
      github.status === "fulfilled"
        ? github.value
        : (lastGood.github ?? { mine: [], reviewRequests: [], merged: [] }),
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
