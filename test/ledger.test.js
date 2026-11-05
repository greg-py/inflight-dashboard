import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLedger, classifyTicket, jiraStage, prStage } from "../lib/ledger.js";
import { normalizePr, ciState } from "../lib/github.js";

const NOW = new Date("2026-11-04T15:00:00Z");
const me = { login: "greg-py", accountId: "me" };
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();

const ticket = (o) => ({
  key: "PY-1", url: "https://jira/PY-1", summary: "Thing", type: "Story", isSubtask: false,
  status: "In Code Review", category: "indeterminate", statusSince: daysAgo(3), created: daysAgo(10),
  assignee: { id: "me", name: "Greg King" }, mine: true, parent: null, subtasks: [], inSprint: true,
  points: 3, qaLead: null, notesEmpty: false, ...o,
});
const pr = (o) => ({
  number: 100, repo: "PerformYard/PerformYard", defaultBranch: "master", url: "https://gh/100", title: "PY-1: Thing",
  author: "greg-py", isDraft: false, state: "OPEN", base: "master", head: "py-1", keys: ["PY-1"],
  mergeable: "MERGEABLE", createdAt: daysAgo(5), mergedAt: null, pushedAt: daysAgo(4), readyAt: null,
  requestedAt: daysAgo(4), requested: [], reviewedBy: [], engApprovals: [], qaApproval: null,
  changesRequested: [], unanswered: 0, ci: { state: "success", failing: [] }, myLastReview: null, parent: null, ...o,
});
const ctx = (tickets = [], prs = []) => ({
  me, now: NOW,
  ticketsByKey: new Map(tickets.map((t) => [t.key, t])),
  prsByNumber: new Map(prs.map((p) => [p.number, p])),
});
const classify = (t, prs, extra = []) => classifyTicket(t, prs, ctx([t, ...extra], prs));
const approved = [{ login: "aroffe-py", at: daysAgo(1) }];

test("engineering approval on a ticket in code review is your move: move it to Ready To Test", () => {
  const r = classify(ticket(), [pr({ engApprovals: approved })]);
  assert.equal(r.group, "yours");
  assert.equal(r.next.label, "Move to Ready To Test");
  assert.equal(r.j, 2);
  assert.equal(r.g, 3);
});

test("an approval still means move to Ready To Test with CI running, bot threads, follow-ups or a stack", () => {
  const p = pr({ engApprovals: approved, ci: { state: "pending", failing: [] }, base: "py-0", parent: { number: 99, author: "greg-py", keys: ["PY-0"] } });
  const r = classify(ticket(), [p]);
  assert.equal(r.next.label, "Move to Ready To Test");
});

test("an approval still moves the ticket when CI is red, because the drift comes first", () => {
  const r = classify(ticket(), [pr({ engApprovals: approved, ci: { state: "failure", failing: ["Prettier"] } })]);
  assert.equal(r.next.label, "Move to Ready To Test");
  assert.ok(r.prs[0].chips.some((c) => c.text.startsWith("CI failing")));
});

test("QA's approval is not an engineering approval", () => {
  const raw = (reviews) => ({
    number: 1, title: "PY-1: x", url: "u", isDraft: false, state: "OPEN", createdAt: daysAgo(3), mergedAt: null,
    mergeable: "MERGEABLE", baseRefName: "master", headRefName: "py-1", author: { login: "greg-py" },
    repository: { nameWithOwner: "PerformYard/PerformYard", defaultBranchRef: { name: "master" } },
    reviewRequests: { nodes: [] }, reviews: { nodes: reviews }, timelineItems: { nodes: [] },
    head: { nodes: [{ commit: { committedDate: daysAgo(3), checkSuites: { nodes: [{ createdAt: daysAgo(3) }] } } }] },
  });
  const teams = { eng: new Set(["aroffe-py", "doug-py", "greg-py"]), qa: new Set(["mkennedypy22", "doug-py"]), login: "greg-py" };
  const review = (login, state, body = "") => ({ author: { __typename: "User", login }, state, submittedAt: daysAgo(1), body });

  const qa = normalizePr(raw([review("mkennedypy22", "APPROVED", "QA:APPROVED")]), teams);
  assert.equal(qa.engApprovals.length, 0);
  assert.equal(qa.qaApproval.login, "mkennedypy22");

  const doug = normalizePr(raw([review("doug-py", "APPROVED", "Looks good")]), teams);
  assert.deepEqual(doug.engApprovals.map((a) => a.login), ["doug-py"]);
  assert.equal(doug.qaApproval, null);

  const dougKoala = normalizePr(raw([review("doug-py", "APPROVED", "🐨")]), teams);
  assert.equal(dougKoala.engApprovals.length, 0);
  assert.equal(dougKoala.qaApproval.login, "doug-py");

  const bot = normalizePr(raw([review("chatgpt-codex-connector", "COMMENTED", "P1")]), teams);
  assert.deepEqual(bot.reviewedBy, []);
});

test("a QA-only approval leaves the ticket in review, waiting on engineers", () => {
  const r = classify(ticket(), [pr({ qaApproval: { login: "mkennedypy22", at: daysAgo(1) }, requested: ["aroffe-py"], requestedAt: daysAgo(0.5) })]);
  assert.notEqual(r.next?.label, "Move to Ready To Test");
});

test("an open Bug Sub-task from QA holds the parent in testing, and the fix is yours on the bug", () => {
  const bug = ticket({ key: "PY-2", type: "Bug Sub-task", isSubtask: true, status: "TO DO", category: "new", parent: "PY-1", created: daysAgo(0.1) });
  const parent = ticket({ status: "In Testing", subtasks: [{ key: "PY-2" }] });
  const p = pr({ engApprovals: approved });
  const rows = buildLedger({ me, tickets: [parent, bug], podTickets: [], myPrs: [p], allPrs: [p], release: null, now: NOW });
  const fix = rows.find((r) => r.key === "PY-2");
  const held = rows.find((r) => r.key === "PY-1");
  assert.equal(fix.yours, true);
  assert.equal(fix.next.label, "Fix");
  assert.equal(held.yours, false);
  assert.equal(held.ball, "PY-2");
});

test("a QA-passed PR stacked on someone else's open PR waits on that PR", () => {
  const parentPr = pr({ number: 7865, author: "aboulle-py", keys: ["PY-9"], head: "andy" });
  const child = pr({ number: 7920, base: "andy", parent: { number: 7865, author: "aboulle-py", keys: ["PY-9"] }, engApprovals: approved, qaApproval: { login: "mkennedypy22", at: daysAgo(0.5) } });
  const r = classifyTicket(ticket({ status: "In Testing" }), [child], ctx([], [parentPr, child]));
  assert.equal(r.yours, false);
  assert.equal(r.ball, "@aboulle-py");
});

test("a PR open for review while the ticket is still In Progress is yours to move", () => {
  const r = classify(ticket({ status: "In Progress" }), [pr({ requested: ["jnguyencd"] })]);
  assert.equal(r.next.label, "Move to In Code Review");
});

test("routine sub-tasks fold into their parent; ones with their own action keep a row", () => {
  const parent = ticket({ key: "PY-10", status: "In Progress" });
  const sub = (key, status, o = {}) => ticket({ key, status, isSubtask: true, parent: "PY-10", category: status === "TO DO" ? "new" : "indeterminate", ...o });
  const subs = [sub("PY-11", "In Progress"), sub("PY-12", "In Progress"), sub("PY-13", "TO DO"), sub("PY-14", "In Progress", { summary: "has a PR" })];
  const p = pr({ number: 14, keys: ["PY-14"], requested: ["x"] });
  const rows = buildLedger({ me, tickets: [parent, ...subs], podTickets: [], myPrs: [p], allPrs: [p], release: null, now: NOW });
  assert.deepEqual(rows.map((r) => r.key).sort(), ["PY-10", "PY-14"]);
  const top = rows.find((r) => r.key === "PY-10");
  assert.deepEqual(top.children.sort(), ["PY-11", "PY-12", "PY-13"]);
  assert.ok(top.chips.some((c) => c.text === "+3 sub-tasks · 2 in progress · 1 to do"));
});

test("READY TO MERGE with a draft, conflicting PR is drift you reconcile", () => {
  const r = classify(ticket({ status: "READY TO MERGE" }), [pr({ isDraft: true, mergeable: "CONFLICTING" })]);
  assert.equal(r.ball, "You · drift");
  assert.equal(r.g, 1);
  assert.equal(r.next.skill, "resolve-conflicts");
});

test("a review request waits on the reviewer, then becomes a nudge after two business days", () => {
  const fresh = classify(ticket(), [pr({ requested: ["jnguyencd"], requestedAt: "2026-11-04T09:00:00Z" })]);
  assert.equal(fresh.group, "waiting");
  assert.equal(fresh.ball, "@jnguyencd");
  const stale = classify(ticket(), [pr({ requested: ["jnguyencd"], requestedAt: "2026-10-30T14:00:00Z" })]);
  assert.equal(stale.group, "yours");
  assert.match(stale.next.label, /^Nudge @jnguyencd/);
});

test("a reviewer who commented and was not asked again needs a re-request", () => {
  const r = classify(ticket(), [pr({ reviewedBy: ["marcuswithers-py"] })]);
  assert.equal(r.next.label, "Re-request @marcuswithers-py");
});

test("nobody requested is yours", () => {
  const r = classify(ticket(), [pr()]);
  assert.equal(r.next.label, "Request review");
});

test("Ready To Test with an approved PR is QA's", () => {
  const r = classify(ticket({ status: "Ready To Test" }), [pr({ engApprovals: approved })]);
  assert.equal(r.group, "waiting");
  assert.equal(r.ball, "QA");
});

test("In Testing names the QA lead", () => {
  const r = classify(ticket({ status: "In Testing", qaLead: "Mark Kennedy" }), [pr({ engApprovals: approved })]);
  assert.equal(r.ball, "Mark");
});

test("QA's approval on GitHub while Jira still says testing is yours to merge", () => {
  const r = classify(ticket({ status: "In Testing" }), [pr({ engApprovals: approved, qaApproval: { login: "tradu1097", at: daysAgo(0.2) } })]);
  assert.equal(r.next.label, "Merge #100");
});

test("merged but not Done is yours to close out", () => {
  const r = classify(ticket({ status: "In Testing" }), [pr({ state: "MERGED", mergedAt: daysAgo(0.5) })]);
  assert.equal(r.next.label, "Set Done");
});

test("READY TO MERGE stacked on a parent still in testing waits on the parent", () => {
  const parent = ticket({ key: "PY-0", status: "In Testing" });
  const parentPr = pr({ number: 99, keys: ["PY-0"], head: "py-0", engApprovals: approved });
  const child = pr({ base: "py-0", parent: { number: 99, author: "greg-py", keys: ["PY-0"] }, engApprovals: approved, qaApproval: { login: "tradu1097", at: daysAgo(0.1) } });
  const r = classifyTicket(ticket({ status: "READY TO MERGE" }), [child], ctx([parent], [parentPr, child]));
  assert.equal(r.group, "waiting");
  assert.equal(r.ball, "#99");
});

test("READY TO MERGE and clean is yours to merge", () => {
  const r = classify(ticket({ status: "READY TO MERGE" }), [pr({ engApprovals: approved, qaApproval: { login: "tradu1097", at: daysAgo(0.1) } })]);
  assert.equal(r.next.label, "Merge #100");
});

test("held work goes to the shelf whatever else is true", () => {
  const r = classify(ticket({ summary: "(HOLD MERGE) Remove nav" }), [pr({ engApprovals: approved })]);
  assert.equal(r.group, "shelf");
});

test("pod tickets show only when something is stuck", () => {
  const podTicket = (o) => ticket({ mine: false, assignee: { id: "x", name: "James Nguyen" }, ...o });
  const quiet = podTicket({ key: "PY-7" });
  const unowned = podTicket({ key: "PY-8", assignee: null, status: "TO DO", category: "new" });
  const drift = podTicket({ key: "PY-9", status: "In Progress" });
  const prs = [pr({ number: 9, author: "jnguyencd", keys: ["PY-9"], engApprovals: approved }), pr({ number: 7, author: "jnguyencd", keys: ["PY-7"], requested: ["x"] })];
  const rows = buildLedger({ me, tickets: [], podTickets: [quiet, unowned, drift], myPrs: [], allPrs: prs, release: null, now: NOW });
  assert.deepEqual(rows.map((r) => [r.key, r.next.label]).sort(), [["PY-8", "Assign"], ["PY-9", "Ready To Test?"]]);
});

test("a review someone asked of you is yours", () => {
  const p = pr({ number: 5, author: "aroffe-py", keys: ["PY-5"], requested: ["greg-py"] });
  const rows = buildLedger({ me, tickets: [], podTickets: [], myPrs: [], allPrs: [p], release: null, now: NOW });
  assert.equal(rows[0].group, "reviews");
  assert.equal(rows[0].next.skill, "deep-review");
});

test("merged since the last tag is yours to ship", () => {
  const release = { unreleased: [{ number: 7825, title: "PY-14976: MCP tools (#7825)", url: "u", author: "greg-py", keys: ["PY-14976"], mergedAt: daysAgo(1) }, { number: 7939, title: "PY-15237 x", url: "u", author: "aboulle-py", keys: ["PY-15237"], mergedAt: daysAgo(1) }] };
  const rows = buildLedger({ me, tickets: [], podTickets: [], myPrs: [], allPrs: [], release, now: NOW });
  assert.deepEqual(rows.map((r) => [r.key, r.group]), [["PY-14976", "ship"]]);
});

test("CI ignores QA gates, and the newest run of a check decides it", () => {
  const run = (name, conclusion, startedAt, status = "COMPLETED") => ({ __typename: "CheckRun", name, status, conclusion, startedAt, checkSuite: { workflowRun: { workflow: { name: "W" } } } });
  assert.equal(ciState([{ __typename: "StatusContext", context: "QA Code Review", state: "FAILURE" }, run("Lint", "SUCCESS", "1")]).state, "success");
  assert.equal(ciState([run("Lint", "FAILURE", "1"), run("Lint", null, "2", "IN_PROGRESS")]).state, "pending");
  assert.equal(ciState([run("Tests", "CANCELLED", "1")]).state, "cancelled");
});

test("stages", () => {
  assert.equal(jiraStage({ status: "READY", category: "new" }), 0);
  assert.equal(jiraStage({ status: "Something New", category: "indeterminate" }), 1);
  assert.equal(prStage(pr({ isDraft: true, engApprovals: approved })), 1);
});

test("an engineering approval agrees with Jira anywhere from QA queue to Merge", () => {
  for (const status of ["Ready To Test", "In Testing", "READY TO MERGE"]) {
    const r = classify(ticket({ status }), [pr({ engApprovals: approved })]);
    assert.equal(r.g, null, status);
  }
  assert.equal(classify(ticket({ status: "In Progress" }), [pr({ engApprovals: approved })]).g, 3);
});
