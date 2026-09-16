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

// Reviewers label comments three ways here: Conventional Comments in italics
// (`_suggestion_`), the same vocabulary in bold (`**issue (blocking):**`), and
// plain bold sentences that happen to open with one of the words. Only the
// leading word is read, and only a recognised one counts — an unlabelled
// comment is treated as actionable, which is the safe way to be wrong.
const LABEL_VOCABULARY = new Set([
  "blocking", "bug", "chore", "issue", "nit", "nitpick", "note", "pattern",
  "performance", "polish", "praise", "question", "robustness", "security",
  "suggestion", "thought", "todo", "typo",
]);

export const commentLabel = (body) => {
  // Review bots lead with a tracking comment; the label, if any, follows it.
  const text = String(body ?? "").replace(/^\s*<!--[\s\S]*?-->/, "").trimStart();
  const word = (text.match(/^_([A-Za-z]+)/) ?? text.match(/^\*\*([A-Za-z]+)/))?.[1]?.toLowerCase();
  return word && LABEL_VOCABULARY.has(word) ? word : null;
};

// Codex stamps each finding with its priority as the alt text of a shields.io
// badge, ahead of the title:
//   **<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?...)</sub></sub>  Title**
// A badge that does not parse reads as no badge, which keeps the finding —
// the same safe way to be wrong that an unlabelled human comment gets.
export const codexPriority = (body) =>
  String(body ?? "").match(/!\[\s*(P\d+)\s+Badge\s*\]/i)?.[1]?.toUpperCase() ?? null;

// A finding the team has agreed not to triage: codex's own, badged below P1.
// Keyed on the comment that opened the thread, since that is the finding —
// later replies carry no badge of their own. Bots that do not use the scheme
// (CodeQL, cursor, claude) never match, so their threads are untouched.
const isDeprioritizedCodex = (comment) => {
  if (!comment?.isBot) return false;
  if (!CONFIG.codexBots.includes(String(comment.login ?? "").toLowerCase())) return false;
  const priority = codexPriority(comment.body);
  return priority !== null && !CONFIG.codexActionablePriorities.includes(priority);
};

// One verdict per review thread. Order matters: an explicitly resolved thread
// is done however it reads, and a thread whose last word is yours is your
// answer whoever opened it.
export const threadState = (thread, prAuthor) => {
  const first = thread?.firstComment;
  const last = thread?.lastComment;
  if (!first || !last || thread.isResolved) return "resolved";
  // A below-P1 codex finding nobody has picked up is deliberately untriaged, so
  // it drops out rather than falling through to "open" — which would make
  // ignoring it cost more attention than reading it. The test sits inside the
  // bot branch on purpose: once a human replies, the thread is a person asking
  // for something and is classified on that, whatever codex badged it.
  if (last.isBot) return isDeprioritizedCodex(first) ? "low" : "bot";
  if (last.login === prAuthor) return "answered";
  if (CONFIG.nonActionableLabels.includes(commentLabel(first.body))) return "praise";
  // The code this was anchored to has changed since the comment landed, so the
  // fix almost always went in without anyone marking the thread. Chasing these
  // forever is the thing that makes the count worth ignoring.
  if (thread.isOutdated) return "stale";
  return "open";
};

// The counts a row is built from, plus when the newest live thread landed so it
// can be timed against the last push.
export const summarizeThreads = (threads, prAuthor) => {
  const open = [];
  let bot = 0;
  for (const thread of threads ?? []) {
    const state = threadState(thread, prAuthor);
    if (state === "open") open.push(thread);
    else if (state === "bot") bot += 1;
  }
  return {
    openThreads: open.length,
    botThreads: bot,
    newestOpenThreadAt:
      open.map((thread) => thread.lastComment?.createdAt).filter(Boolean).sort().at(-1) ?? null,
  };
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

// A pull request opened against another open pull request's branch cannot merge
// until that one does, however green its own checks are. GitHub states the
// relationship only as a base branch name, so the chain is rebuilt by matching
// each base to the head it was opened from.
//
// The chain matters more than any single row: eleven approved, green pull
// requests sitting on a twelfth that conflicts are not eleven pieces of good
// news, they are one merge conflict. Anything below the root is reported as
// blocked by it and never claims to be ready for anything.
export const buildStacks = (prs) => {
  const byHead = new Map();
  for (const pr of prs ?? []) byHead.set(`${pr.repo}:${pr.headRefName}`, pr);
  // A base that is the repo's own default branch is not a stack. Neither is one
  // whose parent is already merged — GitHub retargets those to the default
  // branch, and until it does the row is better read as unstacked than as
  // blocked by something that is already in.
  const parentOf = (pr) =>
    pr.baseIsDefault ? null : (byHead.get(`${pr.repo}:${pr.baseRefName}`) ?? null);

  const ancestorsOf = (pr) => {
    const chain = [];
    const seen = new Set([pr.number]);
    for (let next = parentOf(pr); next && !seen.has(next.number); next = parentOf(next)) {
      seen.add(next.number);
      chain.push(next);
    }
    return chain;
  };

  const stackOf = new Map();
  for (const pr of prs ?? []) {
    const ancestors = ancestorsOf(pr);
    const root = ancestors.at(-1) ?? pr;
    stackOf.set(pr.number, {
      root: root.number,
      rootUrl: root.url,
      depth: ancestors.length,
      // The nearest unmerged ancestor is what actually has to land next, but the
      // root is what has to be fixed, so the row names the root.
      blockedBy: ancestors.length > 0 ? root.number : null,
    });
  }
  // Only the root knows how much is riding on it.
  const behind = new Map();
  for (const [number, stack] of stackOf) {
    if (stack.depth > 0) behind.set(stack.root, (behind.get(stack.root) ?? 0) + 1);
  }
  return new Map(
    [...stackOf].map(([number, stack]) => [number, { ...stack, behind: behind.get(number) ?? 0 }]),
  );
};

// Stack facts belong on the pull request before it is categorized, since they
// decide whether a merge-ready claim is allowed at all.
export const withStacks = (prs) => {
  const stacks = buildStacks(prs);
  return (prs ?? []).map((pr) => ({ ...pr, stack: stacks.get(pr.number) ?? null }));
};

export const categorizePr = (pr) => {
  const reasons = [];
  const addressed = changesAddressed(pr);
  const stack = pr.stack ?? null;
  const blockedLabel = stack?.blockedBy ? `blocked · behind #${stack.blockedBy}` : null;
  const rootLabel = stack?.behind > 0 ? `stack root · ${stack.behind} behind` : null;
  // Stated first: a blocked pull request's own review state is real but
  // secondary, and reading it first is what makes eleven blocked rows look like
  // progress.
  if (blockedLabel) reasons.push(blockedLabel);
  if (rootLabel) reasons.push(rootLabel);
  if (pr.reviewDecision === "CHANGES_REQUESTED" && !addressed) {
    reasons.push("changes requested");
  }
  if (pr.openThreads > 0 && !addressed) {
    // Comments left alongside an approval are follow-ups, not blockers: worth
    // doing before the merge, but not the same thing as feedback that is still
    // holding the review open.
    const noun = pr.reviewDecision === "APPROVED" ? "open follow-up" : "open thread";
    reasons.push(`${pr.openThreads} ${noun}${pr.openThreads === 1 ? "" : "s"}`);
  }
  if (pr.botThreads > 0) {
    reasons.push(`${pr.botThreads} bot thread${pr.botThreads === 1 ? "" : "s"}`);
  }
  if (pr.ci === "failure") reasons.push("CI failing");
  if (pr.mergeable === "CONFLICTING") reasons.push("conflicts with base");
  // A draft is unfinished, not defective: it says where the work is, and never
  // by itself makes the change someone's move.
  if (pr.isDraft) reasons.push("draft");
  // "draft", "blocked" and "stack root" all say where a change sits without
  // saying anything is wrong with it. A blocked change in particular is waiting
  // on the pull request underneath it — treating that as a defect would move
  // every row of a stack into your move, which is the opposite of the point.
  const positional = new Set(["draft", blockedLabel, rootLabel].filter(Boolean));
  const defect = reasons.some((reason) => !positional.has(reason));

  // The review state is always worth stating. A failing build says nothing
  // about whether the change is one click from shipping or has not been looked
  // at yet, and those need very different responses.
  let bucket = defect ? "needs_you" : "waiting";
  if (pr.reviewDecision === "APPROVED") {
    // "ready to merge" is a claim about the whole pull request, so it takes a
    // clean one; otherwise the approval still stands on its own. A change
    // stacked on an unmerged pull request can never earn the claim, however
    // green it is — there is nothing for it to merge into yet.
    if (!defect && pr.ci !== "pending" && !stack?.blockedBy) {
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

// The next action on a row, as a prompt ready to paste into Claude Code.
//
// Built only from validated pull request numbers and ticket keys — never from
// titles or branch names, which are free text the board does not control. The
// repo is always stated: the skills default it to whatever repo the shell
// happens to be in, and a prompt copied off this board gets pasted wherever the
// reader is, not where the work is.
//
// Nothing here runs anything. A row that has no honest next action returns
// null rather than a plausible-looking guess, because a wrong prompt costs more
// than an absent one.
const repoFlag = (repo) => (repo ? ` --repo ${repo}` : "");

const skillPrompt = (skill, target, repo) => ({
  skill,
  prompt: `/${skill} ${target}${repoFlag(repo)}`,
});

export const promptForPr = (pr) => {
  if (!Number.isInteger(pr?.number)) return null;
  // A draft is unfinished, not defective — it carries its real problems as
  // signals but never becomes anyone's move, and a parked prototype that has
  // drifted into conflict least of all.
  if (pr.isDraft) return null;
  const addressed = changesAddressed(pr);
  // Feedback first: it is the only one of the three that another person is
  // waiting on, and answering it usually lands the commits that clear the rest.
  if (
    (pr.reviewDecision === "CHANGES_REQUESTED" && !addressed) ||
    (pr.openThreads > 0 && !addressed) ||
    pr.botThreads > 0
  ) {
    return skillPrompt("address-review", pr.number, pr.repo);
  }
  if (pr.mergeable === "CONFLICTING") return skillPrompt("resolve-conflicts", pr.number, pr.repo);
  if (pr.ci === "failure") {
    // No skill covers this one, so the prompt carries what a skill would have:
    // read the logs before touching anything, fix the cause, and do not chase
    // the check that gates on a human rather than on the code.
    return {
      skill: "fix CI",
      prompt:
        `Investigate and fix the failing CI checks on PR ${pr.number} in ${pr.repo}. ` +
        `Read the failing job logs first (\`gh run view --log-failed\`), fix the cause rather ` +
        `than the symptom, and push to the PR's branch. Ignore the "${CONFIG.qaGateCheck}" ` +
        `check — it gates on a human QA approval, not on the code.`,
    };
  }
  return null;
};

// A review someone asked you for. Having reviewed it already makes this a
// second pass over what the author pushed since, which is a different job.
export const promptForReview = (pr) =>
  Number.isInteger(pr?.number)
    ? skillPrompt(pr.viewerReviewState ? "verify-review" : "deep-review", pr.number, pr.repo)
    : null;

export const promptForTicket = (item) => {
  if (!/^PY-\d+$/.test(item?.key ?? "")) return null;
  // Work that already has a pull request — open, or merged and waiting on a
  // release — is not waiting to be implemented.
  if (item.prs.length > 0 || item.mergedPrs) return null;
  // A subtask rides its parent's branch, so the parent's repo is the one to
  // implement in.
  return skillPrompt("implement-ticket", item.key, item.parentPrs?.[0]?.repo ?? CONFIG.primaryRepo);
};

export const sectionFor = (item) => {
  // A hold is a decision, and it outranks every signal underneath it. Held work
  // keeps its real signals on the row but never becomes anyone's next move.
  if (isHeld(item)) return "held";
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

// Work somebody has deliberately frozen. The marker is written into the summary
// — "(HOLD MERGE) Remove the legacy navigation" — and it has to outrank every
// green signal on the row: a held change that reads "ready to merge" at the top
// of the board is the one error that costs more than showing nothing at all.
export const isHeld = (item) =>
  CONFIG.holdPattern.test(item?.summary ?? "") ||
  (item?.labels ?? []).some((label) => CONFIG.holdLabels.includes(String(label).toLowerCase()));

// "P1-High" is one priority scheme among several Jira sites use; only the
// leading token is read, so "P1", "P1-High" and "p1 - high" all agree.
export const priorityKey = (priority) =>
  String(priority ?? "")
    .trim()
    .toLowerCase()
    .split(/[^a-z0-9]/)[0];

export const isUrgent = (item) => CONFIG.urgentPriorities.includes(priorityKey(item?.priority));

// Jira's `updated` moves on every comment, label and bulk grooming edit, so it
// cannot say how long something has sat in QA. The changelog can: the newest
// status transition is when the current status began.
export const statusSince = (changelog) =>
  (changelog?.histories ?? [])
    .filter((history) => (history.items ?? []).some((change) => change.field === "status"))
    .map((history) => history.created)
    .filter(Boolean)
    .sort()
    .at(-1) ?? null;

export const daysSince = (timestamp, now = Date.now()) =>
  timestamp ? Math.max(0, Math.floor((now - Date.parse(timestamp)) / 86_400_000)) : null;

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
    // A story's parent epic was already being fetched and then thrown away for
    // anything that was not a subtask, which is what made twelve tickets of one
    // effort read as twelve unrelated rows.
    parentType: issue.fields.parent?.fields?.issuetype?.name ?? null,
    parentSummary: issue.fields.parent?.fields?.summary ?? null,
    priority: issue.fields.priority?.name ?? null,
    // Decided here so the UI never has to carry a second copy of which
    // priorities count as urgent.
    urgent: CONFIG.urgentPriorities.includes(priorityKey(issue.fields.priority?.name)),
    labels: issue.fields.labels ?? [],
    updated: issue.fields.updated,
    statusSince: statusSince(issue.changelog),
    statusDays: daysSince(statusSince(issue.changelog)),
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
    item.action = promptForTicket(item);
    // Held work is frozen on purpose. Offering to act on it is the same mistake
    // as ranking it top of the board, one click further along.
    if (item.section === "held") {
      item.action = null;
      item.prs = item.prs.map((pr) => ({ ...pr, action: null }));
    }
    const statusKey = item.status.toLowerCase();
    if (item.section === "waiting" && CONFIG.qaHoldStatuses.includes(statusKey)) {
      // How long it has been queued is the part that decides whether to chase
      // it. "approved · awaiting QA" is a state; "approved · awaiting QA · 6d"
      // is a decision.
      const waited = item.statusDays === null ? "" : ` · ${item.statusDays}d`;
      relabelMerge(
        item,
        CONFIG.qaActiveStatuses.includes(statusKey)
          ? `approved · in QA${waited}`
          : `approved · awaiting QA${waited}`,
      );
    } else if (CONFIG.preQaStatuses.includes(statusKey)) {
      relabelMerge(item, "approved · move to QA");
    }
  }
  // Two things outrank "closest to shipping first" inside a section. An urgent
  // priority, because a P1 that has barely started still beats a P3 one click
  // from done. And the root of a blocked stack, because it is the single change
  // that releases everything queued behind it.
  const stackRootRank = (item) => (item.prs.some((pr) => pr.stack?.behind > 0) ? 0 : 1);
  items.sort(
    (a, b) =>
      Number(isUrgent(b)) - Number(isUrgent(a)) ||
      stackRootRank(a) - stackRootRank(b) ||
      statusRank(a.status) - statusRank(b.status) ||
      String(b.updated).localeCompare(String(a.updated)),
  );
  return items;
};

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
