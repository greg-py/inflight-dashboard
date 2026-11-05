// The ledger: every piece of work is one row, placed on one lifecycle track by
// Jira, cross-checked against GitHub, and owned by exactly one person.
// Pure functions only — everything here is decided from normalized inputs.

import { CONFIG } from "./config.js";

export const STAGES = ["To do", "Build", "Review", "QA queue", "Testing", "Merge", "Ship"];
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

export const jiraStage = (ticket) =>
  JIRA_STAGE[ticket.status.toLowerCase()] ??
  (ticket.category === "new" ? TODO : ticket.category === "done" ? SHIP : BUILD);

// Where GitHub says a single pull request is. Engineering approval means ready
// for QA; a QA verdict means ready to merge.
export const prStage = (pr) => {
  if (pr.state === "MERGED") return SHIP;
  if (pr.isDraft) return BUILD;
  if (pr.qaApproval) return MERGE;
  if (pr.engApprovals.length > 0) return QA_QUEUE;
  return REVIEW;
};

// A ticket is only as far along as its least-advanced open pull request.
export const ghStage = (prs) => {
  const open = prs.filter((p) => p.state === "OPEN");
  if (open.length > 0) return Math.min(...open.map(prStage));
  return prs.some((p) => p.state === "MERGED") ? SHIP : null;
};

// GitHub knows an engineer approved, not whether QA has started or finished:
// an approved pull request agrees with any Jira stage from QA queue to Merge.
export const disagreement = (j, g) => {
  if (g === null || g === undefined || g === j) return null;
  if (g === QA_QUEUE && j >= QA_QUEUE && j <= MERGE) return null;
  return g;
};

export const businessDaysSince = (iso, now) => {
  if (!iso) return 0;
  const d = new Date(iso);
  const end = new Date(now);
  let days = 0;
  while (d < end) {
    d.setDate(d.getDate() + 1);
    if (d <= end && d.getDay() !== 0 && d.getDay() !== 6) days += 1;
  }
  return days;
};

const short = (login) => `@${login}`;
const names = (logins) => logins.map(short).join(" ");
const first = (name) => (name ? name.split(" ")[0] : "");
const latest = (...isos) => isos.filter(Boolean).sort().at(-1) ?? null;

// What is wrong with a pull request you own, worst first. Each is your move.
export const prDefects = (pr) => {
  const out = [];
  if (pr.mergeable === "CONFLICTING") out.push({ text: "conflicts", action: "Resolve conflicts", skill: "resolve-conflicts" });
  if (pr.ci.state === "failure") out.push({ text: `CI failing · ${pr.ci.failing.slice(0, 2).join(", ")}`, action: "Fix CI", skill: "fix-ci" });
  if (pr.ci.state === "cancelled") out.push({ text: `CI cancelled · ${pr.ci.failing.slice(0, 2).join(", ")}`, action: "Rerun CI", skill: "fix-ci" });
  if (pr.changesRequested.length > 0) out.push({ text: `changes requested ${names(pr.changesRequested)}`, action: "Address review", skill: "address-review" });
  if (pr.unanswered > 0) out.push({ text: `${pr.unanswered} unanswered thread${pr.unanswered === 1 ? "" : "s"}`, action: "Answer threads", skill: "address-review" });
  return out;
};

// Everything worth saying about a pull request, as short chips.
export const prChips = (pr) => {
  const chips = [];
  if (pr.isDraft) chips.push({ text: "draft" });
  if (pr.parent) chips.push({ text: `on #${pr.parent.number}${pr.parent.author !== pr.author ? ` ${short(pr.parent.author)}` : ""}` });
  for (const d of prDefects(pr)) chips.push({ text: d.text, tone: "bad" });
  if (pr.engApprovals.length) chips.push({ text: `approved ${names(pr.engApprovals.map((a) => a.login))}`, tone: "good" });
  if (pr.qaApproval) chips.push({ text: `QA ✓ ${short(pr.qaApproval.login)}`, tone: "good" });
  if (pr.ci.state === "pending") chips.push({ text: "CI running" });
  return chips;
};

const prRef = (pr) => ({ number: pr.number, repo: pr.repo, url: pr.url });
const skill = (label, name, arg) => ({ label, skill: name, arg });
const link = (label, href) => ({ label, href });

// Who a review is waiting on, and whether it has waited long enough to chase.
const reviewState = (pr, now) => {
  const reviewers = pr.requested;
  if (reviewers.length === 0) {
    // Somebody reviewed without approving and nobody asked again: GitHub drops
    // them from the requested list, so nothing will happen until you re-request.
    if (pr.reviewedBy.length > 0) {
      return { yours: true, next: skill(`Re-request ${names(pr.reviewedBy)}`, "address-review", `#${pr.number}`), since: pr.pushedAt };
    }
    return { yours: true, next: link("Request review", pr.url), since: pr.readyAt ?? pr.createdAt };
  }
  const since = pr.requestedAt ?? pr.readyAt ?? pr.createdAt;
  if (businessDaysSince(since, now) >= CONFIG.nudgeBusinessDays) {
    return { yours: true, next: link(`Nudge ${names(reviewers)}`, pr.url), since };
  }
  return { yours: false, ball: names(reviewers), since };
};

const URGENCY = { bug: 0, drift: 1, defect: 2, merge: 3, review: 4, start: 5, build: 6, ship: 7 };

export const classifyTicket = (t, prs, ctx) => {
  const { now, ticketsByKey, prsByNumber } = ctx;
  const j = jiraStage(t);
  const open = prs.filter((p) => p.state === "OPEN");
  const ready = open.filter((p) => !p.isDraft);
  const g = ghStage(prs);
  const row = {
    kind: "ticket",
    key: t.key,
    title: t.summary,
    url: t.url,
    type: t.type,
    status: t.status,
    parentKey: t.isSubtask ? t.parent : null,
    isSubtask: t.isSubtask,
    j,
    g: disagreement(j, g),
    prs: prs.map((p) => ({ ...prRef(p), chips: prChips(p) })),
    chips: [],
    group: "waiting",
    yours: false,
    ball: "",
    since: t.statusSince,
    next: null,
    urgency: 9,
  };
  const mine = (patch) => ({ ...row, group: "yours", yours: true, ball: "You", ...patch });
  const theirs = (patch) => ({ ...row, group: "waiting", yours: false, ...patch });

  if (CONFIG.hold.test(t.summary) || open.some((p) => CONFIG.hold.test(p.title))) {
    return { ...row, group: "shelf", ball: "held" };
  }

  // A stacked pull request cannot merge before its parent, whoever owns it.
  const stacked = ready.find((p) => p.parent);
  const parentPr = stacked ? prsByNumber.get(stacked.parent.number) : null;
  const parentTicket = stacked?.parent.keys?.map((k) => ticketsByKey.get(k)).find(Boolean) ?? null;
  // QA has passed, but a stacked change merges only after the one beneath it.
  const behindParent = () => {
    if (!stacked || parentPr?.state !== "OPEN") return null;
    if (parentTicket && jiraStage(parentTicket) === MERGE) {
      return mine({ next: link(`Merge stack from #${stacked.number}`, stacked.url), urgency: URGENCY.merge });
    }
    return theirs({ ball: parentTicket?.mine ? `#${stacked.parent.number}` : short(stacked.parent.author) });
  };

  // An open bug QA filed holds the parent in testing until you close it.
  const bug = t.subtasks
    .map((s) => ticketsByKey.get(s.key))
    .find((s) => s && s.type === "Bug Sub-task" && s.category !== "done" && s.mine && jiraStage(s) < QA_QUEUE);
  if (bug && j >= QA_QUEUE) {
    // The action lives on the bug's own row; this one waits on it.
    return theirs({ ball: bug.key, since: bug.created, chips: [...row.chips, { text: `held by ${bug.key}`, tone: "bad" }] });
  }

  // Jira and GitHub disagree. Reconciling is always yours.
  if (g === SHIP && j < SHIP) {
    return mine({ ball: "You · drift", next: link("Set Done", t.url), since: latest(...prs.map((p) => p.mergedAt)), urgency: URGENCY.drift });
  }
  if (j === SHIP && open.length > 0) {
    return mine({ ball: "You · drift", next: link(`Merge or close #${open[0].number}`, open[0].url), since: open[0].pushedAt, urgency: URGENCY.drift });
  }
  if (j <= REVIEW && g !== null && g >= QA_QUEUE) {
    const approvedAt = latest(...ready.flatMap((p) => [...p.engApprovals.map((a) => a.at), p.qaApproval?.at]));
    const label = g === MERGE ? "Move to READY TO MERGE" : "Move to Ready To Test";
    return mine({ ball: "You · drift", next: link(label, t.url), since: approvedAt, urgency: URGENCY.drift });
  }
  if (j === MERGE && g !== null && g <= REVIEW) {
    const p = open.find((x) => x.isDraft || x.engApprovals.length === 0) ?? open[0];
    const defect = prDefects(p)[0];
    return mine({ ball: "You · drift", next: defect ? skill(defect.action, defect.skill, `#${p.number}`) : link(`Ready #${p.number}`, p.url), since: t.statusSince, urgency: URGENCY.drift });
  }
  if (j <= BUILD && g === REVIEW) {
    const p = ready[0];
    return mine({ ball: "You · drift", next: link("Move to In Code Review", t.url), since: p.readyAt ?? p.createdAt, urgency: URGENCY.drift });
  }
  if ((j === QA_QUEUE || j === TESTING) && g === BUILD) {
    const p = open.find((x) => x.isDraft);
    return mine({ ball: "You · drift", next: link(`Mark #${p.number} ready`, p.url), since: t.statusSince, urgency: URGENCY.drift });
  }

  // Something on your own pull request needs fixing before anyone else can act.
  if (j >= REVIEW && j <= MERGE) {
    for (const p of ready.filter((x) => x.author === ctx.me.login)) {
      const defect = prDefects(p)[0];
      if (defect) return mine({ next: skill(defect.action, defect.skill, `#${p.number}`), since: p.pushedAt, urgency: URGENCY.defect });
    }
  }

  if ((j === QA_QUEUE || j === TESTING) && g === MERGE) {
    const waits = behindParent();
    if (waits) return waits;
    const p = ready[0];
    return mine({ ball: "You · drift", next: link(`Merge #${p.number}`, p.url), since: p.qaApproval.at, urgency: URGENCY.merge });
  }

  switch (j) {
    case TODO:
      if (t.type === "Bug Sub-task") return mine({ next: skill("Fix", "diagnose-bug", t.key), since: t.created, urgency: URGENCY.bug, chips: t.parent ? [{ text: `holds ${t.parent}`, tone: "bad" }] : [] });
      if (t.type === "CSM Reported Bug") return mine({ next: skill("Triage", "diagnose-bug", t.key), since: t.statusSince, urgency: URGENCY.bug });
      if (!t.inSprint) return { ...row, group: "later", ball: "You" };
      return mine({ next: skill("Start", "implement-ticket", t.key), since: t.statusSince !== t.created ? t.statusSince : null, urgency: URGENCY.start });
    case BUILD: {
      const draft = open.find((p) => p.isDraft);
      return mine({ next: draft ? link(`Finish #${draft.number}`, draft.url) : skill("Build", "implement-ticket", t.key), urgency: URGENCY.build });
    }
    case REVIEW: {
      const p = ready[0];
      if (!p) return mine({ next: skill("Open PR", "implement-ticket", t.key), urgency: URGENCY.build });
      const r = reviewState(p, now);
      return r.yours ? mine({ next: r.next, since: r.since, urgency: URGENCY.review }) : theirs({ ball: r.ball, since: r.since });
    }
    case QA_QUEUE:
    case TESTING: {
      // QA can test before an engineer approves, but the review still owes you.
      const unreviewed = ready.find((p) => p.engApprovals.length === 0 && !p.qaApproval);
      if (unreviewed) {
        const r = reviewState(unreviewed, now);
        if (r.yours) return mine({ next: r.next, since: r.since, urgency: URGENCY.review });
      }
      return theirs({ ball: j === TESTING ? (first(t.qaLead) || "QA") : "QA" });
    }
    case MERGE: {
      if (open.length === 0) return mine({ next: link("Set Done", t.url), urgency: URGENCY.merge });
      const waits = behindParent();
      if (waits) return waits;
      const p = ready[0];
      if (p.ci.state === "pending") return theirs({ ball: "CI", since: p.pushedAt });
      return mine({ next: link(`Merge #${p.number}`, p.url), urgency: URGENCY.merge });
    }
    default:
      return { ...row, group: "ship", yours: true, ball: "You · release", next: skill("Release", "production-release", ""), urgency: URGENCY.ship };
  }
};


// A pod ticket earns a row only when something is stuck on it.
export const classifyPodTicket = (t, prs, ctx) => {
  const j = jiraStage(t);
  const g = ghStage(prs);
  const open = prs.filter((p) => p.state === "OPEN" && !p.isDraft);
  const base = {
    kind: "pod", key: t.key, title: t.summary, url: t.url, type: t.type, status: t.status,
    parentKey: null, j, g: disagreement(j, g),
    prs: prs.map((p) => ({ ...prRef(p), chips: prChips(p) })), chips: [],
    group: "pod", yours: false, ball: first(t.assignee?.name) || "nobody", since: t.statusSince, next: null, urgency: 9,
  };
  if (CONFIG.hold.test(t.summary)) return null;
  if (!t.assignee && t.category !== "done") {
    return { ...base, yours: true, ball: "nobody", next: skill("Assign", "ticket-lead-assigner", t.key), since: t.created, urgency: 6 };
  }
  if (g === SHIP && j < SHIP) return { ...base, next: link("Set Done?", t.url), since: latest(...prs.map((p) => p.mergedAt)), urgency: 2 };
  if (j <= REVIEW && g !== null && g >= QA_QUEUE && g < SHIP) {
    const approvedAt = latest(...open.flatMap((p) => p.engApprovals.map((a) => a.at)));
    return { ...base, next: link("Ready To Test?", t.url), since: approvedAt, urgency: 2 };
  }
  if (j === MERGE && businessDaysSince(t.statusSince, ctx.now) >= 1 && open.length > 0) {
    return { ...base, next: link(`Merge #${open[0].number}?`, open[0].url), urgency: 3 };
  }
  const lonely = open.find((p) => p.requested.length === 0 && p.reviewedBy.length === 0 && p.engApprovals.length === 0);
  if (lonely && j <= TESTING) {
    return { ...base, yours: true, next: link("Find reviewer", lonely.url), since: lonely.readyAt ?? lonely.createdAt, urgency: 6 };
  }
  return null;
};

// A review someone asked of you, or one you asked changes on that has moved.
export const classifyReview = (pr, ctx) => {
  const held = CONFIG.hold.test(pr.title);
  const base = {
    kind: "review", key: pr.keys[0] ?? `#${pr.number}`, title: pr.title.replace(CONFIG.ticketKey, "").replace(/^[\s:|-]+/, ""),
    url: pr.url, type: "PR", status: "", parentKey: null, j: REVIEW, g: null,
    prs: [{ ...prRef(pr), chips: prChips(pr) }], chips: [{ text: short(pr.author) }],
    group: held ? "shelf" : "reviews", yours: !held, ball: held ? "held" : "You", since: pr.requestedAt, urgency: 4,
  };
  if (pr.requested.includes(ctx.me.login)) return { ...base, next: skill("Review", "deep-review", `#${pr.number}`) };
  const mineLast = pr.myLastReview;
  if (mineLast?.state === "CHANGES_REQUESTED" && pr.pushedAt > mineLast.at) {
    return { ...base, since: pr.pushedAt, next: skill("Re-review", "verify-review", `#${pr.number}`) };
  }
  return null;
};

// Your open pull requests that no live ticket of yours accounts for.
export const classifyLoosePr = (pr, ctx) => {
  const idleDays = (ctx.now - new Date(pr.pushedAt ?? pr.createdAt)) / 86_400_000;
  const base = {
    kind: "pr", key: pr.keys[0] ?? `#${pr.number}`, title: pr.title.replace(CONFIG.ticketKey, "").replace(/^[\s:|-]+/, ""),
    url: pr.url, type: "PR", status: "", parentKey: null, j: prStage(pr), g: null,
    prs: [{ ...prRef(pr), chips: prChips(pr) }], chips: [], group: "loose", yours: false, ball: "", since: pr.pushedAt, urgency: 8,
  };
  if (CONFIG.hold.test(pr.title)) return { ...base, group: "shelf", ball: "held" };
  if (pr.isDraft) {
    return idleDays >= CONFIG.staleDraftDays
      ? { ...base, group: "shelf", ball: "parked", next: link("Close?", pr.url) }
      : { ...base, yours: true, ball: "You", next: link(`Finish #${pr.number}`, pr.url) };
  }
  const defect = prDefects(pr)[0];
  if (defect) return { ...base, yours: true, ball: "You", next: skill(defect.action, defect.skill, `#${pr.number}`) };
  if (pr.engApprovals.length || pr.qaApproval) return { ...base, yours: true, ball: "You", next: link(`Merge #${pr.number}`, pr.url) };
  const r = reviewState(pr, ctx.now);
  return { ...base, yours: r.yours, ball: r.yours ? "You" : r.ball, since: r.since, next: r.yours ? r.next : null };
};

const prsFor = (key, prs) => prs.filter((p) => p.keys.includes(key));

export const buildLedger = ({ me, tickets, podTickets, groom = [], myPrs, allPrs, release, now }) => {
  const ticketsByKey = new Map([...podTickets, ...tickets].map((t) => [t.key, t]));
  const prsByNumber = new Map(allPrs.map((p) => [p.number, p]));
  const ctx = { me, now, ticketsByKey, prsByNumber };
  const rows = [];

  const mineKeys = new Set(tickets.map((t) => t.key));
  for (const t of tickets) rows.push(classifyTicket(t, prsFor(t.key, [...myPrs, ...allPrs.filter((p) => p.author !== me.login)]), ctx));

  for (const pr of myPrs.filter((p) => p.state === "OPEN" && !p.keys.some((k) => mineKeys.has(k)))) {
    rows.push(classifyLoosePr(pr, ctx));
  }

  for (const t of podTickets.filter((x) => !mineKeys.has(x.key))) {
    const row = classifyPodTicket(t, prsFor(t.key, allPrs), ctx);
    if (row) rows.push(row);
  }

  for (const pr of allPrs.filter((p) => p.author !== me.login)) {
    const row = classifyReview(pr, ctx);
    if (row) rows.push(row);
  }

  // Tickets you lead with an empty Engineering tab: groom before the meeting.
  for (const t of groom.filter((x) => !mineKeys.has(x.key))) {
    rows.push({
      kind: "groom", key: t.key, title: t.summary, url: t.url, type: t.type, status: t.status, parentKey: null,
      j: TODO, g: null, prs: [], chips: [{ text: t.assignee ? first(t.assignee.name) : "unassigned" }],
      group: "yours", yours: true, ball: "You · lead", since: t.created, next: skill("Groom", "jira-ticket-groomer", t.key), urgency: 8,
    });
  }

  // Merged since the last tag and still yours to ship.
  for (const m of release?.unreleased ?? []) {
    if (m.author !== me.login) continue;
    const key = m.keys[0];
    if (key && rows.some((r) => r.key === key && r.kind === "ticket")) continue;
    rows.push({
      kind: "ship", key: key ?? `#${m.number}`, title: m.title.replace(CONFIG.ticketKey, "").replace(/^[\s:|-]+/, ""),
      url: key ? `${CONFIG.jiraBaseUrl}/browse/${key}` : m.url, type: "", status: "Done", parentKey: null,
      j: SHIP, g: null, prs: [{ number: m.number, repo: CONFIG.repo, url: m.url, chips: [{ text: "merged" }] }], chips: [],
      group: "ship", yours: true, ball: "You · release", since: m.mergedAt, next: skill("Release", "production-release", ""), urgency: URGENCY.ship,
    });
  }

  for (const r of rows) r.ageMs = r.since ? Math.max(0, now - new Date(r.since)) : null;
  rows.sort((a, b) => (b.yours - a.yours) || (a.urgency - b.urgency) || (b.j - a.j) || ((b.ageMs ?? 0) - (a.ageMs ?? 0)));
  return rollUp(rows);
};

// A ticket's routine sub-tasks fold into its own line; a sub-task with a
// specific action of its own (a bug, a drift, a defect) keeps its row.
const ROUTINE = new Set(["Start", "Build"]);
const rollUp = (rows) => {
  const parents = new Map(rows.filter((r) => r.kind === "ticket").map((r) => [r.key, r]));
  const folded = new Map();
  const out = [];
  for (const r of rows) {
    const routine = r.type !== "Bug Sub-task" && (!r.yours || (r.next && ROUTINE.has(r.next.label)));
    if (r.isSubtask && parents.has(r.parentKey) && routine) {
      if (!folded.has(r.parentKey)) folded.set(r.parentKey, []);
      folded.get(r.parentKey).push(r);
    } else out.push(r);
  }
  return out.map((r) => {
    const kids = folded.get(r.key);
    if (!kids) return r;
    const byStatus = new Map();
    for (const k of [...kids].sort((x, y) => y.j - x.j)) byStatus.set(k.status, (byStatus.get(k.status) ?? 0) + 1);
    const summary = [...byStatus].map(([st, n]) => `${n} ${st.toLowerCase()}`).join(" · ");
    return { ...r, children: kids.map((k) => k.key), chips: [...r.chips, { text: `+${kids.length} sub-task${kids.length === 1 ? "" : "s"} · ${summary}` }] };
  });
};
