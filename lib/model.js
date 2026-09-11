// Pure domain logic: turning Jira issues + GitHub PRs into categorized work
// items. No I/O here — everything is unit-testable.
import { CONFIG } from "./config.js";

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

// One CI verdict from raw check contexts: noisy checks dropped, reruns of the
// same check name count as passing if any run passed.
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

// The QA gate is passed only when every run of the gate check is green.
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

// True when commits landed after the latest changes-requested review: the ball
// is back in the reviewer's court even though reviewDecision hasn't reset.
export const changesAddressed = (pr) => {
  if (pr.reviewDecision !== "CHANGES_REQUESTED") return false;
  if (!pr.changesRequestedAt || !pr.lastCommitAt) return false;
  if (Date.parse(pr.lastCommitAt) <= Date.parse(pr.changesRequestedAt)) return false;
  // A thread opened after that push cannot have been answered by it, so the
  // ball is back in your court however new the commits are.
  return !(
    pr.newestOpenThreadAt && Date.parse(pr.newestOpenThreadAt) > Date.parse(pr.lastCommitAt)
  );
};

// Which requested reviewers are still on the hook, and since when. A re-request
// restarts that reviewer's clock, so the newest event for each person wins.
export const reviewerWaits = (requestedNodes, eventNodes, now) => {
  const nameOf = (reviewer) => reviewer?.login ?? reviewer?.name ?? null;
  const requestedAt = new Map();
  for (const event of eventNodes ?? []) {
    const name = nameOf(event?.requestedReviewer);
    if (!name || !event.createdAt) continue;
    const prior = requestedAt.get(name);
    if (!prior || Date.parse(event.createdAt) > Date.parse(prior)) {
      requestedAt.set(name, event.createdAt);
    }
  }
  return (requestedNodes ?? [])
    .map((node) => nameOf(node?.requestedReviewer))
    .filter(Boolean)
    .map((login) => {
      const since = requestedAt.get(login) ?? null;
      return {
        login,
        requestedAt: since,
        // No matching event means the request predates the timeline window.
        waitingDays: since ? Math.max(0, Math.floor((now - Date.parse(since)) / 86_400_000)) : null,
      };
    })
    .sort((a, b) => (b.waitingDays ?? -1) - (a.waitingDays ?? -1));
};

// Name the reviewer who has been sitting longest, so the row says who to nudge
// rather than only how long it has been.
export const awaitingReason = (pr) => {
  const [longest, ...rest] = pr.pendingReviewers ?? [];
  // Nobody on the hook at all is a different problem from a slow reviewer, and
  // it is the one that will never resolve itself.
  if (!longest) return `no reviewer requested · ${pr.ageDays}d`;
  const others = rest.length > 0 ? ` +${rest.length}` : "";
  // A request older than the timeline window has no known start; say who, and
  // do not invent a clock for it.
  return longest.waitingDays === null
    ? `awaiting @${longest.login}${others}`
    : `awaiting @${longest.login}${others} · ${longest.waitingDays}d`;
};

// Who owes the re-review, timed from the push that answered the feedback.
export const reReviewReason = (pr) => {
  const [longest, ...rest] = pr.pendingReviewers ?? [];
  const since = pr.lastCommitDaysAgo === null || pr.lastCommitDaysAgo === undefined
    ? ""
    : ` · ${pr.lastCommitDaysAgo}d`;
  if (!longest) return `changes pushed · awaiting re-review${since}`;
  const others = rest.length > 0 ? ` +${rest.length}` : "";
  return `re-review @${longest.login}${others}${since}`;
};

export const categorizePr = (pr) => {
  const reasons = [];
  const addressed = changesAddressed(pr);
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !addressed) {
    reasons.push("changes requested");
  }
  if (pr.openThreads > 0 && !addressed) {
    reasons.push(`${pr.openThreads} open thread${pr.openThreads === 1 ? "" : "s"}`);
  }
  if (pr.botThreads > 0) {
    reasons.push(`${pr.botThreads} bot thread${pr.botThreads === 1 ? "" : "s"}`);
  }
  if (pr.ci === "failure") reasons.push("CI failing");
  if (pr.mergeable === "CONFLICTING") reasons.push("conflicts with base");
  // A draft is unfinished, not defective: it says where the work is, and never
  // by itself makes the change someone's move.
  if (pr.isDraft) reasons.push("draft");
  const defect = reasons.some((reason) => reason !== "draft");

  // The review state is always worth stating. A failing build says nothing
  // about whether the change is one click from shipping or has not been looked
  // at yet, and those need very different responses.
  let bucket = defect ? "needs_you" : "waiting";
  if (pr.reviewDecision === "APPROVED") {
    // "ready to merge" is a claim about the whole pull request, so it takes a
    // clean one; otherwise the approval still stands on its own.
    if (!defect && pr.ci !== "pending") {
      reasons.push(
        pr.qaGate === "passed" ? "QA passed · ready to merge" : "approved · ready to merge",
      );
      bucket = "needs_you";
    } else {
      reasons.push("approved");
    }
  } else if (addressed) {
    reasons.push(reReviewReason(pr));
  } else if (pr.reviewDecision !== "CHANGES_REQUESTED" && !pr.isDraft) {
    // Unaddressed changes-requested already says whose move it is, and nobody
    // is waiting to review a draft.
    reasons.push(awaitingReason(pr));
  }
  if (pr.ci === "success") reasons.push("CI green");
  if (pr.ci === "pending") {
    if ((pr.ciStuckHours ?? 0) > 0) {
      reasons.push(`CI stuck ${pr.ciStuckHours}h`);
      if (!defect && bucket === "waiting") bucket = "needs_you";
      return { bucket, reasons, defect: true };
    }
    reasons.push("CI running");
  }
  return { bucket, reasons, defect };
};

export const sectionFor = (item) => {
  if (item.prs.length > 0) {
    // Work whose every pull request is still a draft is being written, not
    // waiting on anyone — it belongs with the rest of the in-development work
    // however its checks happen to look.
    if (item.prs.every((pr) => pr.isDraft)) return "no_pr";
    const qaHold = CONFIG.qaHoldStatuses.includes(item.status?.toLowerCase());
    return item.prs.some(
      (pr) =>
        !pr.isDraft && pr.bucket === "needs_you" && (pr.defect || pr.qaGate === "passed" || !qaHold),
    )
      ? "needs_you"
      : "waiting";
  }
  return CONFIG.waitingStatuses.includes(item.status?.toLowerCase() ?? "") ? "waiting" : "no_pr";
};

export const statusRank = (status) => {
  const rank = CONFIG.statusOrder.indexOf(String(status ?? "").toLowerCase());
  return rank === -1 ? CONFIG.statusOrder.length : rank;
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
    // A subtask with no PR of its own rides the parent's branch — reference
    // the parent's PRs for display, never attach them.
    if (item.isSubtask && item.prs.length === 0 && item.parentKey) {
      const parentPrs = prsByKey.get(item.parentKey) ?? [];
      if (parentPrs.length > 0) {
        item.parentPrs = parentPrs.map((pr) => ({ number: pr.number, url: pr.url, repo: pr.repo }));
      }
    }
    if (item.key && item.prs.length === 0 && !item.parentPrs) {
      const merged = mergedPrs.filter((pr) => extractTicketKeys(pr).includes(item.key));
      if (merged.length > 0) {
        item.mergedPrs = merged.map((pr) => ({ number: pr.number, url: pr.url, repo: pr.repo }));
      }
    }
    item.section = sectionFor(item);
    const statusKey = item.status.toLowerCase();
    if (item.section === "waiting" && CONFIG.qaHoldStatuses.includes(statusKey)) {
      relabelMerge(
        item,
        CONFIG.qaActiveStatuses.includes(statusKey) ? "approved · in QA" : "approved · awaiting QA",
      );
    } else if (CONFIG.preQaStatuses.includes(statusKey)) {
      relabelMerge(item, "approved · move to QA");
    }
  }
  items.sort(
    (a, b) =>
      statusRank(a.status) - statusRank(b.status) ||
      String(b.updated).localeCompare(String(a.updated)),
  );
  return items;
};

const DAY_MS = 86_400_000;

export const activeSprintOf = (issues) => {
  for (const issue of issues ?? []) {
    for (const sprint of issue.fields?.sprints ?? []) {
      if (sprint.state === "active" && sprint.startDate && sprint.endDate) {
        return {
          id: sprint.id,
          name: sprint.name,
          startDate: sprint.startDate,
          endDate: sprint.endDate,
        };
      }
    }
  }
  return null;
};

// Where the sprint stands: how much of its calendar is gone against how much of
// your scope is closed. Both as percentages so the UI can show one against the
// other — burn ahead of or behind the clock is the whole point of the reading.
export const buildSprintPulse = (issues, now = Date.now()) => {
  const sprint = activeSprintOf(issues);
  if (!sprint) return null;
  const start = Date.parse(sprint.startDate);
  const end = Date.parse(sprint.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;

  const totalDays = Math.max(1, Math.ceil((end - start) / DAY_MS));
  const elapsedDays = Math.min(totalDays, Math.max(0, Math.ceil((now - start) / DAY_MS)));
  const daysLeft = Math.max(0, Math.ceil((end - now) / DAY_MS));

  const scope = (issues ?? []).filter((issue) =>
    (issue.fields?.sprints ?? []).some((entry) => entry.id === sprint.id),
  );
  const byCategory = (key) =>
    scope.filter((issue) => issue.fields?.status?.statusCategory?.key === key).length;
  const counts = {
    total: scope.length,
    done: byCategory("done"),
    inProgress: byCategory("indeterminate"),
    todo: byCategory("new"),
  };
  const pct = (part, whole) => (whole > 0 ? Math.round((part / whole) * 100) : 0);

  return {
    name: sprint.name,
    endDate: sprint.endDate,
    totalDays,
    elapsedDays,
    daysLeft,
    timePercent: pct(elapsedDays, totalDays),
    donePercent: pct(counts.done, counts.total),
    counts,
  };
};

// Notification subjects arrive as API URLs; the board links to the page a human
// would open.
export const htmlUrlFor = (apiUrl, repoFullName) => {
  const match = String(apiUrl ?? "").match(/\/repos\/([^/]+\/[^/]+)\/(pulls|issues)\/(\d+)/);
  if (match) {
    return `https://github.com/${match[1]}/${match[2] === "pulls" ? "pull" : "issues"}/${match[3]}`;
  }
  return repoFullName ? `https://github.com/${repoFullName}` : "https://github.com/notifications";
};

export const mapNotification = (node) => ({
  id: `gh-notification-${node.id}`,
  reason: String(node.reason ?? "").replace(/_/g, " "),
  title: node.subject?.title ?? "(no title)",
  repo: node.repository?.full_name ?? "",
  url: htmlUrlFor(node.subject?.url, node.repository?.full_name),
  updatedAt: node.updated_at ?? null,
});

// The inbox only earns space by carrying news: reasons the board already
// renders in full are dropped, newest first, clamped to a readable length.
export const buildInbox = (notifications) =>
  (notifications ?? [])
    .filter((node) => !CONFIG.notificationReasonsHidden.includes(node.reason))
    .map(mapNotification)
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
    .slice(0, CONFIG.notificationLimit);

// Squash merges carry their pull request number in the commit subject:
// "PY-14338: Stop a non-finite value breaking employee reads (#7502)".
export const prNumbersInCommits = (messages) => {
  const numbers = new Set();
  for (const message of messages ?? []) {
    for (const match of String(message).matchAll(/\(#(\d+)\)/g)) numbers.add(Number(match[1]));
  }
  return numbers;
};

// Your merged work that has landed on the default branch but is not in the last
// release. Repos with no release to compare against are named rather than
// silently dropped — "nothing to ship" and "no way to tell" are different
// answers.
export const buildShipping = (mergedPrs, releasesByRepo) => {
  const items = [];
  const skipped = new Set();
  for (const pr of mergedPrs ?? []) {
    const release = releasesByRepo?.get(pr.repo);
    if (!release || release.error) {
      skipped.add(pr.repo);
      continue;
    }
    if (!release.numbers.has(pr.number)) continue;
    const ticketKey = extractTicketKeys(pr)[0] ?? null;
    items.push({
      id: `shipping-${pr.repo}#${pr.number}`,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      repo: pr.repo,
      mergedAt: pr.mergedAt ?? null,
      tag: release.tag,
      ticketKey,
      ticketUrl: ticketKey ? `${CONFIG.jiraBaseUrl}/browse/${ticketKey}` : null,
    });
  }
  items.sort((a, b) => String(b.mergedAt).localeCompare(String(a.mergedAt)));
  const notes = [...skipped].map((repo) => `${repo.split("/").at(-1)}: no release to compare`);
  for (const [repo, release] of releasesByRepo ?? []) {
    if (release.truncated) notes.push(`${repo.split("/").at(-1)}: ${release.ahead}+ commits unreleased`);
  }
  return { items, note: notes.join(" · ") || null };
};
