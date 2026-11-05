// Every piece of work becomes one row with exactly one owner, decided purely
// from normalized Jira tickets and GitHub pull requests.

import { CONFIG } from "./config.js";

const [TODO, BUILD, REVIEW, QA_QUEUE, TESTING, MERGE, SHIP] = [0, 1, 2, 3, 4, 5, 6];

const JIRA_STAGE = {
  drafting: TODO, ready: TODO, "need clarification": TODO, "to do": TODO,
  "in progress": BUILD,
  "in design review": REVIEW, "in code review": REVIEW,
  "ready to test": QA_QUEUE,
  "in testing": TESTING,
  "ready to merge": MERGE,
  done: SHIP,
};

export const jiraStage = (t) =>
  JIRA_STAGE[t.status.toLowerCase()] ?? { new: TODO, done: SHIP }[t.category] ?? BUILD;

const approved = (pr) => pr.engApprovals.length > 0;

// Engineering approval means ready for QA; a QA verdict means ready to merge.
export const prStage = (pr) =>
  pr.state === "MERGED" ? SHIP : pr.isDraft ? BUILD : pr.qaApproval ? MERGE : approved(pr) ? QA_QUEUE : REVIEW;

// A ticket is only as far along as its least-advanced open pull request.
export const ghStage = (prs) => {
  const open = prs.filter((p) => p.state === "OPEN");
  if (open.length) return Math.min(...open.map(prStage));
  return prs.length ? SHIP : null;
};

export const businessDaysSince = (iso, now) => {
  if (!iso) return 0;
  const day = new Date(iso);
  let days = 0;
  while (day.setDate(day.getDate() + 1) && day <= now) {
    if (day.getDay() % 6 !== 0) days += 1;
  }
  return days;
};

const handles = (logins) => logins.map((l) => `@${l}`).join(" ");
const firstName = (name) => name?.split(" ")[0] ?? "";
const latest = (...isos) => isos.filter(Boolean).sort().at(-1) ?? null;
const withoutKey = (title) => title.replace(CONFIG.ticketKey, "").replace(/^[\s:|-]+/, "");
const skill = (label, name, arg = "") => ({ label, skill: name, arg });
const link = (label, href) => ({ label, href });

const URGENCY = { bug: 0, drift: 1, defect: 2, merge: 3, review: 4, start: 5, assign: 6, build: 7, groom: 8, ship: 9 };

const mine = (row, next, urgency, extra = {}) => ({ ...row, lane: "mine", next, urgency, ...extra });
const waiting = (row, waitingOn, extra = {}) => ({ ...row, lane: "waiting", waitingOn, ...extra });
const shelved = (row, why) => ({ ...row, lane: "shelf", waitingOn: why });

// What is wrong with a pull request, worst first, with the skill that fixes it.
export const prDefects = (pr) => {
  const ref = `#${pr.number}`;
  const checks = pr.ci.failing.slice(0, 2).join(", ");
  return [
    pr.mergeable === "CONFLICTING" && { text: "conflicts", next: skill("Resolve conflicts", "resolve-conflicts", ref) },
    pr.ci.state === "failure" && { text: `CI failing · ${checks}`, next: skill("Fix CI", "fix-ci", ref) },
    pr.ci.state === "cancelled" && { text: `CI cancelled · ${checks}`, next: skill("Rerun CI", "fix-ci", ref) },
    pr.changesRequested.length > 0 && { text: `changes requested ${handles(pr.changesRequested)}`, next: skill("Address review", "address-review", ref) },
    pr.unanswered > 0 && { text: `${pr.unanswered} unanswered thread${pr.unanswered === 1 ? "" : "s"}`, next: skill("Answer threads", "address-review", ref) },
  ].filter(Boolean);
};

const prSummary = (pr) => ({
  number: pr.number,
  repo: pr.repo,
  url: pr.url,
  chips: [
    pr.state === "MERGED" && { text: "merged" },
    pr.isDraft && { text: "draft" },
    pr.parent && { text: `on #${pr.parent.number}${pr.parent.author === pr.author ? "" : ` @${pr.parent.author}`}` },
    ...prDefects(pr).map((d) => ({ text: d.text, tone: "bad" })),
    approved(pr) && { text: `approved ${handles(pr.engApprovals.map((a) => a.login))}`, tone: "good" },
    pr.qaApproval && { text: `QA ✓ @${pr.qaApproval.login}`, tone: "good" },
    pr.ci.state === "pending" && { text: "CI running" },
  ].filter(Boolean),
});

// Who a review waits on, and whether it has waited long enough to chase.
const reviewStep = (pr, now) => {
  if (pr.requested.length === 0) {
    return pr.reviewedBy.length
      ? { next: skill(`Re-request ${handles(pr.reviewedBy)}`, "address-review", `#${pr.number}`), since: pr.pushedAt }
      : { next: link("Request review", pr.url), since: pr.readyAt ?? pr.createdAt };
  }
  const since = pr.requestedAt ?? pr.readyAt ?? pr.createdAt;
  return businessDaysSince(since, now) >= CONFIG.nudgeBusinessDays
    ? { next: link(`Nudge ${handles(pr.requested)}`, pr.url), since }
    : { waitingOn: handles(pr.requested), since };
};

// Jira and GitHub disagree about where the work is. Reconciling is always yours.
const drift = (t, j, g, open, prs) => {
  const ready = open.filter((p) => !p.isDraft);
  if (g === null) return null;
  if (g === SHIP && j < SHIP) {
    return { next: link("Set Done", t.url), since: latest(...prs.map((p) => p.mergedAt)) };
  }
  if (g >= QA_QUEUE && j <= REVIEW) {
    const approvals = ready.flatMap((p) => [...p.engApprovals.map((a) => a.at), p.qaApproval?.at]);
    return { next: link(g === MERGE ? "Move to READY TO MERGE" : "Move to Ready To Test", t.url), since: latest(...approvals) };
  }
  if (g === REVIEW && j <= BUILD) {
    return { next: link("Move to In Code Review", t.url), since: ready[0].readyAt ?? ready[0].createdAt };
  }
  if ((g === BUILD && j >= QA_QUEUE) || (g === REVIEW && j === MERGE)) {
    const p = open.find((x) => x.isDraft) ?? open.find((x) => !approved(x));
    const fallback = link(p.isDraft ? `Mark #${p.number} ready` : `Get #${p.number} approved`, p.url);
    return { next: prDefects(p)[0]?.next ?? fallback, since: t.statusSince };
  }
  return null;
};

// QA has passed, in Jira or on GitHub. A stacked PR merges after the one beneath it.
const mergeStep = (row, t, ready, ctx) => {
  const p = ready.find((x) => x.parent) ?? ready[0];
  if (!p) return mine(row, link("Set Done", t.url), URGENCY.merge);
  if (p.parent) {
    const below = p.parent.keys.map((k) => ctx.tickets.get(k)).find(Boolean);
    if (below && jiraStage(below) === MERGE) return mine(row, link(`Merge stack from #${p.number}`, p.url), URGENCY.merge);
    return waiting(row, below?.mine ? `#${p.parent.number}` : `@${p.parent.author}`);
  }
  if (p.ci.state === "pending") return waiting(row, "CI", { since: p.pushedAt });
  return mine(row, link(`Merge #${p.number}`, p.url), URGENCY.merge, { since: p.qaApproval?.at ?? t.statusSince });
};

export const classifyTicket = (t, prs, ctx) => {
  const j = jiraStage(t);
  const g = ghStage(prs);
  const open = prs.filter((p) => p.state === "OPEN");
  const ready = open.filter((p) => !p.isDraft);
  const row = {
    ticket: true, key: t.key, title: t.summary, url: t.url, status: t.status, j,
    since: t.statusSince, prs: prs.map(prSummary), chips: [],
    parentKey: t.isSubtask ? t.parent : null, isBug: t.type === "Bug Sub-task",
  };

  if (CONFIG.hold.test(t.summary) || open.some((p) => CONFIG.hold.test(p.title))) return shelved(row, "held");

  // QA's bug holds the parent until it is fixed; the fix is the bug's own row.
  const bug = t.subtasks.map((k) => ctx.tickets.get(k)).find((s) => s?.type === "Bug Sub-task" && s.mine && jiraStage(s) < QA_QUEUE);
  if (bug && j >= QA_QUEUE) return waiting(row, bug.key, { since: bug.created, chips: [{ text: `held by ${bug.key}`, tone: "bad" }] });

  const fix = drift(t, j, g, open, prs);
  if (fix) return mine(row, fix.next, URGENCY.drift, { since: fix.since });

  if (j >= REVIEW) {
    for (const p of ready.filter((x) => x.author === ctx.me)) {
      const defect = prDefects(p)[0];
      if (defect) return mine(row, defect.next, URGENCY.defect, { since: p.pushedAt });
    }
  }

  if (j === MERGE || g === MERGE) return mergeStep(row, t, ready, ctx);

  if (j === TODO) {
    if (row.isBug) return mine(row, skill("Fix", "diagnose-bug", t.key), URGENCY.bug, { since: t.created, chips: t.parent ? [{ text: `holds ${t.parent}`, tone: "bad" }] : [] });
    if (t.type === "CSM Reported Bug") return mine(row, skill("Triage", "diagnose-bug", t.key), URGENCY.bug);
    if (!t.inSprint) return { ...row, lane: "later" };
    return mine(row, skill("Start", "implement-ticket", t.key), URGENCY.start, { routine: true, since: t.statusSince === t.created ? null : t.statusSince });
  }
  const draft = open.find((p) => p.isDraft);
  if (j === BUILD) {
    return draft
      ? mine(row, link(`Finish #${draft.number}`, draft.url), URGENCY.build)
      : mine(row, skill("Build", "implement-ticket", t.key), URGENCY.build, { routine: true });
  }
  if (j === REVIEW && ready.length === 0) {
    return mine(row, draft ? link(`Mark #${draft.number} ready`, draft.url) : skill("Open PR", "implement-ticket", t.key), URGENCY.build);
  }
  // QA may test before an engineer approves, but the review is still owed.
  const unreviewed = ready.find((p) => !approved(p) && !p.qaApproval);
  if (unreviewed) {
    const r = reviewStep(unreviewed, ctx.now);
    if (r.next) return mine(row, r.next, URGENCY.review, { since: r.since });
    if (j === REVIEW) return waiting(row, r.waitingOn, { since: r.since });
  }
  return waiting(row, j === TESTING ? firstName(t.qaLead) || "QA" : "QA");
};

// A teammate's ticket earns a row only when something is stuck on it.
export const classifyPodTicket = (t, prs, ctx) => {
  if (CONFIG.hold.test(t.summary)) return null;
  const j = jiraStage(t);
  const g = ghStage(prs);
  const ready = prs.filter((p) => !p.isDraft);
  const row = { key: t.key, title: t.summary, url: t.url, status: t.status, heading: "Pod", j, since: t.statusSince, prs: prs.map(prSummary), chips: [] };
  const stuck = (text, since) => waiting(row, firstName(t.assignee), { since, chips: [{ text, tone: "bad" }] });

  if (!t.assignee) return mine(row, skill("Assign", "ticket-lead-assigner", t.key), URGENCY.assign, { since: t.created });
  if (g !== null && g >= QA_QUEUE && j <= REVIEW) {
    return stuck(`approved, still ${t.status}`, latest(...ready.flatMap((p) => p.engApprovals.map((a) => a.at))));
  }
  if (j === MERGE && ready.length && businessDaysSince(t.statusSince, ctx.now) >= 1) return stuck("QA passed, not merged");
  const unreviewed = ready.find((p) => !p.requested.length && !p.reviewedBy.length && !approved(p));
  if (unreviewed && j <= TESTING) {
    return mine(row, link("Find reviewer", unreviewed.url), URGENCY.assign, { since: unreviewed.readyAt ?? unreviewed.createdAt });
  }
  return null;
};

// A review someone asked of you, or one you asked changes on that has moved since.
export const classifyReview = (pr, ctx) => {
  const asked = pr.requested.includes(ctx.me);
  const moved = pr.myReview?.state === "CHANGES_REQUESTED" && pr.pushedAt > pr.myReview.at;
  if (!asked && !moved) return null;
  const row = {
    key: pr.keys[0] ?? `#${pr.number}`, title: withoutKey(pr.title), url: pr.url, status: "Review", j: REVIEW,
    prs: [prSummary(pr)], chips: [{ text: `@${pr.author}` }],
  };
  if (CONFIG.hold.test(pr.title)) return shelved({ ...row, since: pr.pushedAt }, "held");
  return asked
    ? mine(row, skill("Review", "deep-review", `#${pr.number}`), URGENCY.review, { since: pr.requestedAt })
    : mine(row, skill("Re-review", "verify-review", `#${pr.number}`), URGENCY.review, { since: pr.pushedAt });
};

// Your open pull requests that no live ticket of yours accounts for.
export const classifyLoosePr = (pr, ctx) => {
  const row = {
    key: pr.keys[0] ?? `#${pr.number}`, title: withoutKey(pr.title), url: pr.url, status: "", heading: "Other PRs",
    j: prStage(pr), since: pr.pushedAt, prs: [prSummary(pr)], chips: [],
  };
  if (CONFIG.hold.test(pr.title)) return shelved(row, "held");
  if (pr.isDraft) {
    const idleDays = (ctx.now - new Date(pr.pushedAt)) / 86_400_000;
    return idleDays >= CONFIG.staleDraftDays ? shelved(row, "parked") : mine(row, link(`Finish #${pr.number}`, pr.url), URGENCY.build);
  }
  const defect = prDefects(pr)[0];
  if (defect) return mine(row, defect.next, URGENCY.defect);
  if (approved(pr) || pr.qaApproval) return mine(row, link(`Merge #${pr.number}`, pr.url), URGENCY.merge);
  const r = reviewStep(pr, ctx.now);
  return r.next ? mine(row, r.next, URGENCY.review, { since: r.since }) : waiting(row, r.waitingOn, { since: r.since });
};

// Tickets you lead whose Engineering tab is still empty.
const groomRow = (t) =>
  mine(
    { key: t.key, title: t.summary, url: t.url, status: t.status, j: TODO, since: t.created, prs: [], chips: t.assignee ? [{ text: firstName(t.assignee) }] : [] },
    skill("Groom", "jira-ticket-groomer", t.key),
    URGENCY.groom,
  );

// You run releases: anything merged since the latest tag is waiting on one.
const releaseRow = (release, me) => {
  const yours = release.unreleased.filter((m) => m.author === me).flatMap((m) => m.keys);
  return mine(
    {
      key: CONFIG.releaseBranch, title: `${release.aheadBy} merged since ${release.tag}`, status: "Unreleased", j: SHIP,
      url: `https://github.com/${CONFIG.repo}/compare/${release.tag}...${CONFIG.releaseBranch}`,
      since: release.unreleased.map((m) => m.mergedAt).sort()[0], prs: [],
      chips: yours.length ? [{ text: `yours: ${yours.join(", ")}` }] : [],
    },
    skill("Release", "production-release"),
    URGENCY.ship,
  );
};

// Routine sub-tasks (nothing to do but build them, or waiting on others) fold
// into their parent's line; one with an action of its own keeps its row.
const rollUp = (rows) => {
  const parents = new Set(rows.filter((r) => r.ticket).map((r) => r.key));
  const folds = (r) => r.parentKey && parents.has(r.parentKey) && !r.isBug && (r.lane !== "mine" || r.routine);
  const children = new Map();
  for (const r of rows.filter(folds)) children.set(r.parentKey, [...(children.get(r.parentKey) ?? []), r]);
  return rows.filter((r) => !folds(r)).map((r) => {
    const kids = children.get(r.key);
    if (!kids) return r;
    const counts = new Map();
    for (const k of kids.toSorted((a, b) => b.j - a.j)) counts.set(k.status, (counts.get(k.status) ?? 0) + 1);
    const summary = [...counts].map(([status, n]) => `${n} ${status.toLowerCase()}`).join(" · ");
    return { ...r, chips: [...r.chips, { text: `+${kids.length} sub-task${kids.length === 1 ? "" : "s"} · ${summary}` }] };
  });
};

// Your moves by urgency; everything else by heading, closest to shipping first.
const LANES = ["mine", "waiting", "shelf", "later"];
const rank = (r) => (r.lane === "mine" ? r.urgency : r.heading === "Pod" ? 20 : r.heading === "Other PRs" ? 30 : 10 - r.j);

const publish = (rows, now) =>
  rows
    .map((r) => ({ ...r, heading: r.heading ?? r.status, ageMs: r.since ? Math.max(0, now - new Date(r.since)) : null }))
    .sort((a, b) =>
      LANES.indexOf(a.lane) - LANES.indexOf(b.lane) || rank(a) - rank(b) || a.heading.localeCompare(b.heading) || (b.ageMs ?? 0) - (a.ageMs ?? 0))
    .map(({ key, title, url, status, lane, heading, waitingOn = null, next = null, prs, chips, ageMs }) =>
      ({ key, title, url, status, lane, heading, waitingOn, next, prs, chips, ageMs }));

export const buildLedger = ({ me, tickets, podTickets, ungroomed = [], myPrs, otherPrs, release, now }) => {
  const ctx = { me, now, tickets: new Map([...podTickets, ...tickets].map((t) => [t.key, t])) };
  const prs = [...myPrs, ...otherPrs];
  const prsFor = (key) => prs.filter((p) => p.keys.includes(key));
  const yours = new Set(tickets.map((t) => t.key));
  const rows = [
    ...tickets.map((t) => classifyTicket(t, prsFor(t.key), ctx)),
    ...podTickets.filter((t) => !yours.has(t.key)).map((t) => classifyPodTicket(t, prsFor(t.key).filter((p) => p.state === "OPEN"), ctx)),
    ...otherPrs.map((pr) => classifyReview(pr, ctx)),
    ...myPrs.filter((p) => p.state === "OPEN" && !p.keys.some((k) => yours.has(k))).map((pr) => classifyLoosePr(pr, ctx)),
    ...ungroomed.filter((t) => !yours.has(t.key)).map(groomRow),
    release?.aheadBy ? releaseRow(release, me) : null,
  ].filter(Boolean);
  return publish(rollUp(rows), now);
};
