// Pure domain logic: turning Jira issues + GitHub PRs into categorized work
// items with derived actions. No I/O here — everything is unit-testable.
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
  if (pr.openThreads > 0 && !changesAddressed(pr)) {
    reasons.push(`${pr.openThreads} open thread${pr.openThreads === 1 ? "" : "s"}`);
  }
  if (pr.botThreads > 0) {
    reasons.push(`${pr.botThreads} codex thread${pr.botThreads === 1 ? "" : "s"}`);
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

const autonomous = (skillPrompt) =>
  CONFIG.autonomousLaunches ? `${skillPrompt} --autonomous` : skillPrompt;

// Derived agent actions. Prompts are built only from validated PR numbers and
// ticket keys — never from titles or other free text. `kind` names the action
// for the policy engine; `fingerprint` is what "acted once per state" keys on.
export const launchForPr = (pr) => {
  if (!Number.isInteger(pr.number)) return null;
  if (
    (pr.reviewDecision === "CHANGES_REQUESTED" && !changesAddressed(pr)) ||
    (pr.openThreads > 0 && !changesAddressed(pr)) ||
    pr.botThreads > 0
  ) {
    return {
      kind: "address-review",
      label: "address review",
      prompt: autonomous(`/address-review #${pr.number}`),
      repo: pr.repo,
      fingerprint: `review:${pr.repo}#${pr.number}:${pr.changesRequestedAt ?? pr.lastCommitAt}`,
    };
  }
  if (pr.mergeable === "CONFLICTING") {
    return {
      kind: "resolve-conflicts",
      label: "resolve conflicts",
      prompt: autonomous(`/resolve-conflicts #${pr.number}`),
      repo: pr.repo,
      fingerprint: `conflicts:${pr.repo}#${pr.number}:${pr.lastCommitAt}`,
    };
  }
  if (pr.ci === "failure") {
    return {
      kind: "fix-ci",
      label: "fix CI",
      prompt: CONFIG.autonomousLaunches
        ? `Investigate and fix the failing CI checks on PR #${pr.number}. Work autonomously: commit and push the fix to the PR branch without stopping for approval.`
        : `Investigate and fix the failing CI checks on PR #${pr.number}.`,
      repo: pr.repo,
      fingerprint: `fixci:${pr.repo}#${pr.number}:${pr.lastCommitAt}`,
    };
  }
  return null;
};

export const launchForReview = (pr) => {
  if (!Number.isInteger(pr.number)) return null;
  return pr.viewerReviewState
    ? {
        kind: "verify-review",
        label: "re-review",
        prompt: autonomous(`/verify-review #${pr.number}`),
        repo: pr.repo,
        fingerprint: `prereview:${pr.repo}#${pr.number}`,
      }
    : {
        kind: "deep-review",
        label: "review",
        prompt: autonomous(`/deep-review #${pr.number}`),
        repo: pr.repo,
        fingerprint: `prereview:${pr.repo}#${pr.number}`,
      };
};

export const launchForTicket = (item) => {
  if (item.prs.length > 0 || !/^PY-\d+$/.test(item.key ?? "")) return null;
  return {
    kind: "implement",
    label: "implement",
    prompt: autonomous(`/implement-ticket ${item.key}`),
    repo: item.parentPrs?.[0]?.repo ?? null,
    fingerprint: `implement:${item.key}`,
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

// ---------------------------------------------------------------------------
// Difficulty tiers — deterministic routing from payload signals. `exceptional`
// is deliberately manual-only.
// ---------------------------------------------------------------------------

export const tierFor = (action, { pr = null, item = null } = {}) => {
  const t = CONFIG.tierThresholds;
  const diff = pr ? (pr.additions ?? 0) + (pr.deletions ?? 0) : 0;
  switch (action.kind) {
    case "implement":
      return item?.isSubtask ? "standard" : "heavy";
    case "deep-review":
    case "verify-review":
      return diff <= t.reviewLightMax ? "light" : diff >= t.reviewHeavyMin ? "heavy" : "standard";
    case "address-review":
      return diff >= t.addressHeavyMin ? "heavy" : "standard";
    case "resolve-conflicts":
    case "fix-ci":
    default:
      return "standard";
  }
};

export const routeFor = (tier) => CONFIG.routing[tier] ?? CONFIG.routing.standard;

export const slugFor = (prompt) =>
  String(prompt)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

// ---------------------------------------------------------------------------
// Diagnosis keys and parsing (the LLM calls themselves live in diagnosis.js).
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
