import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLedger, classifyTicket, classifyPodTicket, jiraStage, prStage, businessDaysSince } from "../lib/ledger.js";
import { normalizePr, ciState } from "../lib/github.js";

const NOW = new Date("2026-11-04T15:00:00Z");
const ME = "greg-py";
const daysAgo = (d) => new Date(NOW - d * 86_400_000).toISOString();
const approved = [{ login: "aroffe-py", at: daysAgo(1) }];
const qaPassed = { login: "mkennedypy22", at: daysAgo(0.5) };

const ticket = (o = {}) => ({
  key: "PY-1", url: "https://jira/PY-1", summary: "Thing", type: "Story", isSubtask: false,
  status: "In Code Review", category: "indeterminate", created: daysAgo(10), statusSince: daysAgo(3),
  assignee: "Greg King", mine: true, parent: null, subtasks: [], inSprint: true,
  points: 3, qaLead: null, groomed: true, ...o,
});
const pr = (o = {}) => ({
  number: 100, repo: "PerformYard/PerformYard", defaultBranch: "master", url: "https://gh/100", title: "PY-1: Thing",
  author: ME, isDraft: false, state: "OPEN", base: "master", head: "py-1", keys: ["PY-1"],
  mergeable: "MERGEABLE", createdAt: daysAgo(5), mergedAt: null, pushedAt: daysAgo(4), readyAt: null,
  requestedAt: daysAgo(4), requested: [], reviewedBy: [], engApprovals: [], qaApproval: null,
  changesRequested: [], unanswered: 0, ci: { state: "success", failing: [] }, myReview: null, parent: null, ...o,
});
const ctx = (tickets = []) => ({ me: ME, now: NOW, tickets: new Map(tickets.map((t) => [t.key, t])) });
const classify = (t, prs, others = []) => classifyTicket(t, prs, ctx([t, ...others]));
const ledger = (o) => buildLedger({ me: ME, tickets: [], podTickets: [], myPrs: [], otherPrs: [], release: null, now: NOW, ...o });

test("engineering approval on a ticket in code review: move it to Ready To Test", () => {
  const r = classify(ticket(), [pr({ engApprovals: approved })]);
  assert.equal(r.lane, "mine");
  assert.equal(r.next.label, "Move to Ready To Test");
});

test("the move to Ready To Test is not hidden by running or red CI, bot threads or a stack", () => {
  for (const extra of [{ ci: { state: "pending", failing: [] } }, { ci: { state: "failure", failing: ["Prettier"] } }, { parent: { number: 99, author: ME, keys: ["PY-0"] } }]) {
    assert.equal(classify(ticket(), [pr({ engApprovals: approved, ...extra })]).next.label, "Move to Ready To Test");
  }
});

test("QA's approval is not an engineering approval", () => {
  const raw = (reviews) => ({
    number: 1, title: "PY-1: x", url: "u", isDraft: false, state: "OPEN", createdAt: daysAgo(3), mergedAt: null,
    mergeable: "MERGEABLE", baseRefName: "master", headRefName: "py-1", author: { login: ME },
    repository: { nameWithOwner: "PerformYard/PerformYard", defaultBranchRef: { name: "master" } },
    reviewRequests: { nodes: [] }, reviews: { nodes: reviews }, timelineItems: { nodes: [] },
    head: { nodes: [{ commit: { committedDate: daysAgo(3), checkSuites: { nodes: [{ createdAt: daysAgo(3) }] } } }] },
  });
  const teams = { eng: new Set(["aroffe-py", "doug-py", ME]), qa: new Set(["mkennedypy22", "doug-py"]), login: ME };
  const review = (login, state, body = "") => ({ author: { __typename: "User", login }, state, submittedAt: daysAgo(1), body });

  const qa = normalizePr(raw([review("mkennedypy22", "APPROVED", "QA:APPROVED")]), teams);
  assert.deepEqual([qa.engApprovals.length, qa.qaApproval.login], [0, "mkennedypy22"]);

  const doug = normalizePr(raw([review("doug-py", "APPROVED", "Looks good")]), teams);
  assert.deepEqual([doug.engApprovals.map((a) => a.login), doug.qaApproval], [["doug-py"], null]);

  const dougKoala = normalizePr(raw([review("doug-py", "APPROVED", "🐨")]), teams);
  assert.deepEqual([dougKoala.engApprovals.length, dougKoala.qaApproval.login], [0, "doug-py"]);

  const qaComment = normalizePr(raw([review("tradu1097", "COMMENTED", "how do I test this?")]), { ...teams, qa: new Set(["tradu1097"]) });
  assert.equal(qaComment.qaApproval, null);

  const bot = normalizePr(raw([review("chatgpt-codex-connector", "COMMENTED", "P1")]), teams);
  assert.deepEqual(bot.reviewedBy, []);
});

test("a QA-only approval leaves the ticket waiting on engineers", () => {
  const r = classify(ticket(), [pr({ qaApproval: qaPassed, requested: ["aroffe-py"], requestedAt: daysAgo(0.5) })]);
  assert.notEqual(r.next?.label, "Move to Ready To Test");
});

test("an open Bug Sub-task from QA is your move, and its parent waits on it", () => {
  const bug = ticket({ key: "PY-2", type: "Bug Sub-task", isSubtask: true, status: "TO DO", category: "new", parent: "PY-1", created: daysAgo(0.1) });
  const parent = ticket({ status: "In Testing", subtasks: ["PY-2"] });
  const p = pr({ engApprovals: approved });
  const rows = ledger({ tickets: [parent, bug], myPrs: [p] });
  const fix = rows.find((r) => r.key === "PY-2");
  const held = rows.find((r) => r.key === "PY-1");
  assert.deepEqual([fix.lane, fix.next.label], ["mine", "Fix"]);
  assert.deepEqual([held.lane, held.waitingOn], ["waiting", "PY-2"]);
});

test("READY TO MERGE with a draft, conflicting PR: resolve the conflicts", () => {
  const r = classify(ticket({ status: "READY TO MERGE" }), [pr({ isDraft: true, mergeable: "CONFLICTING" })]);
  assert.equal(r.next.skill, "resolve-conflicts");
});

test("a review request waits on the reviewer, then becomes a nudge after two business days", () => {
  const fresh = classify(ticket(), [pr({ requested: ["jnguyencd"], requestedAt: "2026-11-04T09:00:00Z" })]);
  assert.deepEqual([fresh.lane, fresh.waitingOn], ["waiting", "@jnguyencd"]);
  const stale = classify(ticket(), [pr({ requested: ["jnguyencd"], requestedAt: "2026-10-30T14:00:00Z" })]);
  assert.equal(stale.next.label, "Nudge @jnguyencd");
});

test("with two PRs in review, the nudge is for the one not yet approved", () => {
  const done = pr({ number: 1, engApprovals: approved, requested: ["a"], requestedAt: daysAgo(9) });
  const open = pr({ number: 2, requested: ["b"], requestedAt: daysAgo(9) });
  assert.equal(classify(ticket(), [done, open]).next.label, "Nudge @b");
});

test("a reviewer who commented and was not asked again needs a re-request", () => {
  assert.equal(classify(ticket(), [pr({ reviewedBy: ["marcuswithers-py"] })]).next.label, "Re-request @marcuswithers-py");
});

test("nobody requested: request review", () => {
  assert.equal(classify(ticket(), [pr()]).next.label, "Request review");
});

test("in code review with only a draft: mark it ready", () => {
  assert.equal(classify(ticket(), [pr({ isDraft: true })]).next.label, "Mark #100 ready");
});

test("a PR open for review while the ticket is still In Progress: move the ticket", () => {
  assert.equal(classify(ticket({ status: "In Progress" }), [pr({ requested: ["x"] })]).next.label, "Move to In Code Review");
});

test("Ready To Test with an approved PR is QA's; In Testing names the QA lead", () => {
  assert.equal(classify(ticket({ status: "Ready To Test" }), [pr({ engApprovals: approved })]).waitingOn, "QA");
  assert.equal(classify(ticket({ status: "In Testing", qaLead: "Mark Kennedy" }), [pr({ engApprovals: approved })]).waitingOn, "Mark");
});

test("QA passed on GitHub while Jira still says testing: merge", () => {
  assert.equal(classify(ticket({ status: "In Testing" }), [pr({ engApprovals: approved, qaApproval: qaPassed })]).next.label, "Merge #100");
});

test("READY TO MERGE and clean: merge; with CI running: wait on CI", () => {
  assert.equal(classify(ticket({ status: "READY TO MERGE" }), [pr({ engApprovals: approved, qaApproval: qaPassed })]).next.label, "Merge #100");
  assert.equal(classify(ticket({ status: "READY TO MERGE" }), [pr({ engApprovals: approved, ci: { state: "pending", failing: [] } })]).waitingOn, "CI");
});

test("merged but not Done: set Done", () => {
  assert.equal(classify(ticket({ status: "In Testing" }), [pr({ state: "MERGED", mergedAt: daysAgo(0.5) })]).next.label, "Set Done");
});

test("a stacked PR waits on its parent: someone else's, or your own not yet at Merge", () => {
  const onAndy = pr({ base: "andy", parent: { number: 7865, author: "aboulle-py", keys: ["PY-9"] }, engApprovals: approved, qaApproval: qaPassed });
  assert.equal(classify(ticket({ status: "In Testing" }), [onAndy]).waitingOn, "@aboulle-py");

  const below = ticket({ key: "PY-0", status: "In Testing" });
  const onMine = pr({ base: "py-0", parent: { number: 99, author: ME, keys: ["PY-0"] }, engApprovals: approved, qaApproval: qaPassed });
  assert.equal(classify(ticket({ status: "READY TO MERGE" }), [onMine], [below]).waitingOn, "#99");
  assert.equal(classify(ticket({ status: "READY TO MERGE" }), [onMine], [{ ...below, status: "READY TO MERGE" }]).next.label, "Merge stack from #100");
});

test("held work goes to the shelf whatever else is true", () => {
  assert.equal(classify(ticket({ summary: "(HOLD MERGE) Remove nav" }), [pr({ engApprovals: approved })]).lane, "shelf");
});

test("routine sub-tasks fold into their parent; ones with their own action keep a row", () => {
  const sub = (key, status, o = {}) => ticket({ key, status, isSubtask: true, parent: "PY-10", category: status === "TO DO" ? "new" : "indeterminate", ...o });
  const tickets = [ticket({ key: "PY-10", status: "In Progress" }), sub("PY-11", "In Progress"), sub("PY-12", "In Progress"), sub("PY-13", "TO DO"), sub("PY-14", "In Progress")];
  const rows = ledger({ tickets, myPrs: [pr({ number: 14, keys: ["PY-14"], requested: ["x"] })] });
  assert.deepEqual(rows.map((r) => r.key).sort(), ["PY-10", "PY-14"]);
  assert.ok(rows.find((r) => r.key === "PY-10").chips.some((c) => c.text === "+3 sub-tasks · 2 in progress · 1 to do"));
});

test("pod tickets show only when something is stuck, and say what", () => {
  const pod = (o) => ticket({ mine: false, assignee: "James Nguyen", ...o });
  assert.equal(classifyPodTicket(pod({ key: "PY-7" }), [pr({ author: "jnguyencd", keys: ["PY-7"], requested: ["x"] })], ctx()), null);
  assert.equal(classifyPodTicket(pod({ key: "PY-8", assignee: null, status: "TO DO", category: "new" }), [], ctx()).next.label, "Assign");
  const stuck = classifyPodTicket(pod({ key: "PY-9", status: "In Progress" }), [pr({ author: "jnguyencd", keys: ["PY-9"], engApprovals: approved })], ctx());
  assert.deepEqual([stuck.lane, stuck.waitingOn, stuck.chips[0].text], ["waiting", "James", "approved, still In Progress"]);
  assert.equal(classifyPodTicket(pod({ key: "PY-6" }), [pr({ author: "mw", keys: ["PY-6"] })], ctx()), null);
});

test("a review someone asked of you, or one you asked changes on that has moved", () => {
  const asked = pr({ number: 5, author: "aroffe-py", keys: ["PY-5"], requested: [ME] });
  const moved = pr({ number: 6, author: "aroffe-py", keys: ["PY-6"], myReview: { state: "CHANGES_REQUESTED", at: daysAgo(5) }, pushedAt: daysAgo(1) });
  const quiet = pr({ number: 7, author: "aroffe-py", keys: ["PY-7"] });
  const rows = ledger({ otherPrs: [asked, moved, quiet] });
  assert.deepEqual(rows.map((r) => r.next.skill), ["deep-review", "verify-review"]);
});

test("changes you requested that the author has not answered wait on the author, never on a pod move", () => {
  const mineToAnswer = pr({ number: 8, author: "aroffe-py", keys: ["PY-8"], changesRequested: [ME], myReview: { state: "CHANGES_REQUESTED", at: daysAgo(1) } });
  const podTicket = ticket({ key: "PY-8", mine: false, assignee: "Ari Roffe" });
  const rows = ledger({ podTickets: [podTicket], otherPrs: [mineToAnswer] });
  assert.deepEqual(rows.map((r) => [r.key, r.lane, r.waitingOn]), [["PY-8", "waiting", "@aroffe-py"]]);
});

test("a review asked of your team, or left as comments on a PR that asked for yours, is still your review", () => {
  const raw = (o) => ({
    number: 1, title: "PY-1: x", url: "u", isDraft: false, state: "OPEN", createdAt: daysAgo(3), mergedAt: null,
    mergeable: "MERGEABLE", baseRefName: "master", headRefName: "py-1", author: { login: "aroffe-py" },
    repository: { nameWithOwner: "PerformYard/Logan", defaultBranchRef: { name: "main" } },
    reviewRequests: { nodes: [] }, reviews: { nodes: [] }, timelineItems: { nodes: [] },
    head: { nodes: [{ commit: { committedDate: daysAgo(3) } }] }, ...o,
  });
  const teams = { eng: new Set([ME]), qa: new Set(), mine: new Set(["engineering"]), login: ME };
  const comment = { author: { __typename: "User", login: ME }, state: "COMMENTED", submittedAt: daysAgo(1), body: "" };
  const event = { __typename: "ReviewRequestedEvent", createdAt: daysAgo(2), requestedReviewer: { login: ME } };

  assert.equal(normalizePr(raw({ reviewRequests: { nodes: [{ requestedReviewer: { slug: "engineering" } }] } }), teams).askedMe, true);
  assert.equal(normalizePr(raw({ reviews: { nodes: [comment] }, timelineItems: { nodes: [event] } }), teams).myReview.state, "COMMENTED");
  assert.equal(normalizePr(raw({ reviews: { nodes: [comment] } }), teams).myReview, null);
});

test("a ticket of yours whose PR you are asked to review is one row, and the review is its move", () => {
  const theirs = pr({ number: 9, author: "JustinCoker991", engApprovals: approved, requested: [ME] });
  const rows = ledger({ tickets: [ticket({ status: "In Testing" })], otherPrs: [theirs] });
  assert.deepEqual(rows.map((r) => [r.key, r.lane, r.heading, r.next.skill, r.waitingOn]), [["PY-1", "mine", "In Testing", "deep-review", null]]);
});

test("a stack merges only when every PR beneath it is at Merge", () => {
  const tickets = [ticket({ key: "PY-2", status: "READY TO MERGE" }), ticket({ key: "PY-1", status: "READY TO MERGE" })];
  const bottom = pr({ number: 1, keys: ["PY-1"], head: "py-1", base: "andy", engApprovals: approved, qaApproval: qaPassed });
  const top = pr({ number: 2, keys: ["PY-2"], head: "py-2", base: "py-1", engApprovals: approved, qaApproval: qaPassed, parent: { number: 1, author: ME, keys: ["PY-1"] } });
  const free = ledger({ tickets, myPrs: [bottom, top] }).find((r) => r.key === "PY-2");
  assert.equal(free.next.label, "Merge stack from #2");
  const onAndy = { ...bottom, parent: { number: 7865, author: "aboulle-py", keys: ["PY-9"] } };
  const blocked = ledger({ tickets, myPrs: [onAndy, top] }).find((r) => r.key === "PY-2");
  assert.deepEqual([blocked.lane, blocked.waitingOn], ["waiting", "@aboulle-py"]);
});

test("anything merged since the latest tag is one release, naming your merges", () => {
  const release = { tag: "v2026.11.03", aheadBy: 2, unreleased: [
    { number: 7825, title: "PY-14976: MCP tools", url: "u", author: ME, keys: ["PY-14976"], mergedAt: daysAgo(1) },
    { number: 7939, title: "PY-15237 x", url: "u", author: "aboulle-py", keys: ["PY-15237"], mergedAt: daysAgo(2) },
  ] };
  const [row] = ledger({ release });
  assert.deepEqual([row.next.skill, row.title, row.chips[0].text], ["production-release", "2 merged since v2026.11.03", "yours: PY-14976"]);
  assert.equal(ledger({ release: { ...release, aheadBy: 0, unreleased: [] } }).length, 0);
});

test("your moves come first by urgency; waiting rows group by heading, closest to shipping first", () => {
  const tickets = [
    ticket({ key: "PY-1", status: "Ready To Test" }),
    ticket({ key: "PY-2", status: "In Testing" }),
    ticket({ key: "PY-3", status: "TO DO", category: "new" }),
    ticket({ key: "PY-4", status: "Ready To Test" }),
  ];
  const myPrs = ["PY-1", "PY-2", "PY-4"].map((k, i) => pr({ number: i, keys: [k], engApprovals: approved }));
  assert.deepEqual(ledger({ tickets, myPrs }).map((r) => [r.key, r.lane, r.heading]), [
    ["PY-3", "mine", "TO DO"],
    ["PY-2", "waiting", "In Testing"],
    ["PY-1", "waiting", "Ready To Test"],
    ["PY-4", "waiting", "Ready To Test"],
  ]);
});

test("CI ignores QA gates, and the newest run of a check decides it", () => {
  const run = (name, conclusion, startedAt, status = "COMPLETED") => ({ __typename: "CheckRun", name, status, conclusion, startedAt, checkSuite: { workflowRun: { workflow: { name: "W" } } } });
  assert.equal(ciState([{ __typename: "StatusContext", context: "QA Code Review", state: "FAILURE" }, run("Lint", "SUCCESS", "1")]).state, "success");
  assert.equal(ciState([run("Lint", "FAILURE", "1"), run("Lint", null, "2", "IN_PROGRESS")]).state, "pending");
  assert.equal(ciState([run("Tests", "CANCELLED", "1")]).state, "cancelled");
});

test("stages and business days", () => {
  assert.equal(jiraStage({ status: "READY", category: "new" }), 0);
  assert.equal(jiraStage({ status: "Something New", category: "indeterminate" }), 1);
  assert.equal(jiraStage({ status: "Closed", category: "done" }), 6);
  assert.equal(prStage(pr({ isDraft: true, engApprovals: approved })), 1);
  assert.equal(businessDaysSince("2026-10-30T14:00:00Z", NOW), 3);
  assert.equal(businessDaysSince("2026-11-04T09:00:00Z", NOW), 0);
});
