import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  extractTicketKeys,
  effectiveCi,
  qaGateState,
  changesAddressed,
  categorizePr,
  sectionFor,
  statusRank,
  buildItems,
  reviewerWaits,
  awaitingReason,
  reReviewReason,
  commentLabel,
  codexPriority,
  threadState,
  summarizeThreads,
  prNumbersInCommits,
  buildShipping,
  buildStacks,
  withStacks,
  isHeld,
  priorityKey,
  isUrgent,
  statusSince,
  daysSince,
  promptForPr,
  promptForReview,
  promptForTicket,
  promptForShipping,
  routinePrompts,
  pastReviewers,
  requestedOfViewerAt,
  ciPendingSince,
  ciStuckHours,
} from "./lib/model.js";
import { mapReviewPr, failureReason, fetchJira, fetchJiraIssues } from "./lib/integrations.js";
import { CONFIG } from "./lib/config.js";

test("extractTicketKeys finds keys in branch and title, case-insensitively, deduped", () => {
  assert.deepEqual(
    extractTicketKeys({ headRefName: "codex/py-14137-dashboard", title: "PY-14137 Show dashboard" }),
    ["PY-14137"],
  );
  assert.deepEqual(
    extractTicketKeys({ headRefName: "PY-13548-calendar", title: "PY-13548 + PY-13549 series" }),
    ["PY-13548", "PY-13549"],
  );
  assert.deepEqual(extractTicketKeys({ headRefName: "koala/machine-api", title: "Koala API" }), []);
});

test("effectiveCi filters noise and combines repeated check runs", () => {
  assert.equal(
    effectiveCi([
      { name: "QA Code Review", conclusion: "FAILURE" },
      { name: "Unit Tests (1/8)", conclusion: "SUCCESS" },
    ]),
    "success",
  );
  assert.equal(
    effectiveCi([
      { name: "Integration Tests (2/3)", conclusion: "FAILURE" },
      { name: "Integration Tests (2/3)", conclusion: "SUCCESS" },
    ]),
    "success",
  );
  assert.equal(
    effectiveCi([
      { name: "Type Check", conclusion: "FAILURE" },
      { name: "Prettier", conclusion: "SUCCESS" },
    ]),
    "failure",
  );
  assert.equal(
    effectiveCi([{ name: "Type Check", conclusion: null, status: "IN_PROGRESS" }]),
    "pending",
  );
  assert.equal(effectiveCi([{ name: "QA Code Review", conclusion: "FAILURE" }]), "none");
  assert.equal(effectiveCi([{ context: "deploy/staging", state: "FAILURE" }]), "failure");
});

test("effectiveCi judges each check by its newest run, per workflow", () => {
  // A failure that has since been re-run is running, not failing.
  assert.equal(
    effectiveCi([
      { name: "Type Check", conclusion: "FAILURE", startedAt: "2026-09-29T10:00:00Z" },
      { name: "Type Check", conclusion: null, status: "IN_PROGRESS", startedAt: "2026-09-29T10:20:00Z" },
    ]),
    "pending",
  );
  // And a pass followed by a failing re-run is a failure, whatever the order listed.
  assert.equal(
    effectiveCi([
      { name: "Type Check", conclusion: "FAILURE", startedAt: "2026-09-29T11:00:00Z" },
      { name: "Type Check", conclusion: "SUCCESS", startedAt: "2026-09-29T10:00:00Z" },
    ]),
    "failure",
  );
  // Two workflows each with a job of the same name are two checks: one passing
  // must not hide the other failing.
  const inWorkflow = (workflow, conclusion, startedAt) => ({
    name: "Notify Deployment Ready",
    conclusion,
    startedAt,
    checkSuite: { workflowRun: { workflow: { name: workflow } } },
  });
  assert.equal(
    effectiveCi([
      inWorkflow("JS/TS Pipeline", "FAILURE", "2026-09-29T10:00:00Z"),
      inWorkflow("Docker Build Apps", "SUCCESS", "2026-09-29T10:05:00Z"),
    ]),
    "failure",
  );
  // A queued run has no start time yet, and is the newest attempt there is.
  assert.equal(
    effectiveCi([
      { name: "Lint", conclusion: "FAILURE", startedAt: "2026-09-29T10:00:00Z" },
      { name: "Lint", conclusion: null, status: "QUEUED", startedAt: null },
    ]),
    "pending",
  );
});

test("the QA gate reads its newest run", () => {
  assert.equal(qaGateState([{ name: "QA Code Review", conclusion: "SUCCESS" }]), "passed");
  // The enforcer runs again when QA approves; the failures from before the
  // approval stay listed on the commit and must not outvote it.
  assert.equal(
    qaGateState([
      { name: "QA Code Review", conclusion: "FAILURE", startedAt: "2026-09-29T21:06:00Z" },
      { name: "QA Code Review", conclusion: "SUCCESS", startedAt: "2026-09-29T22:30:00Z" },
      { name: "QA Code Review", conclusion: "FAILURE", startedAt: "2026-09-29T21:11:00Z" },
    ]),
    "passed",
  );
  // A draft passes the enforcer automatically; marking it ready fails it again.
  assert.equal(
    qaGateState([
      { name: "QA Code Review", conclusion: "FAILURE", startedAt: "2026-09-30T13:36:00Z" },
      { name: "QA Code Review", conclusion: "SUCCESS", startedAt: "2026-09-30T13:22:00Z" },
    ]),
    "blocked",
  );
  assert.equal(
    qaGateState([{ name: "QA Code Review", conclusion: null, status: "IN_PROGRESS" }]),
    "pending",
  );
  assert.equal(qaGateState([{ name: "Unit Tests (1/8)", conclusion: "SUCCESS" }]), null);
});

const basePr = {
  number: 7364,
  repo: "PerformYard/PerformYard",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  ci: "success",
  ageDays: 2,
  openThreads: 0,
  botThreads: 0,
  qaGate: null,
  pushedAt: "2026-08-20T10:00:00Z",
  changesRequestedAt: null,
  // Someone is on the hook, so the fixture is nobody's move until a test says
  // otherwise.
  pendingReviewers: [{ login: "alice", waitingDays: 1 }],
};

test("categorizePr surfaces defects and settled merge-ready work", () => {
  for (const overrides of [
    { reviewDecision: "CHANGES_REQUESTED" },
    { ci: "failure" },
    { mergeable: "CONFLICTING" },
    { openThreads: 2 },
    { botThreads: 1 },
  ]) {
    assert.equal(categorizePr({ ...basePr, ...overrides }).bucket, "needs_you", JSON.stringify(overrides));
  }
  // A draft is unfinished, not defective: it never becomes anyone's move on its
  // own, and sectionFor routes it to the in-development queue.
  const draft = categorizePr({ ...basePr, isDraft: true });
  assert.equal(draft.bucket, "waiting");
  assert.equal(draft.defect, false);
  assert.ok(draft.reasons.includes("draft"));
  // Nobody is waiting to review a draft, so it gets no awaiting label either.
  assert.ok(!draft.reasons.some((reason) => reason.startsWith("awaiting")));
  // How long since anyone pushed to it travels with the label.
  assert.ok(categorizePr({ ...basePr, isDraft: true, pushedDaysAgo: 17 }).reasons.includes("draft · 17d"));
  // A real problem on a draft still counts as a defect.
  assert.equal(categorizePr({ ...basePr, isDraft: true, ci: "failure" }).defect, true);

  const withBot = categorizePr({ ...basePr, botThreads: 2 });
  assert.ok(withBot.reasons.includes("2 bot threads"));
  const approved = categorizePr({ ...basePr, reviewDecision: "APPROVED" });
  assert.equal(approved.bucket, "needs_you");
  assert.equal(approved.defect, false);
  assert.ok(approved.reasons.includes("approved · ready to merge"));
  assert.ok(
    categorizePr({ ...basePr, reviewDecision: "APPROVED", qaGate: "passed" }).reasons.includes(
      "QA passed · ready to merge",
    ),
  );
  assert.equal(categorizePr({ ...basePr, reviewDecision: "APPROVED", ci: "pending" }).bucket, "waiting");
  // Nobody requested is its own signal, and nobody else will act on it.
  const unasked = categorizePr({ ...basePr, pendingReviewers: [] });
  assert.ok(unasked.reasons.includes("no reviewer requested · 2d"));
  assert.equal(unasked.bucket, "needs_you");
  assert.equal(unasked.defect, false);
  // Timed from when it was marked ready, not when it was opened as a draft.
  assert.ok(
    categorizePr({ ...basePr, pendingReviewers: [], ageDays: 9, readyDays: 1 }).reasons.includes(
      "no reviewer requested · 1d",
    ),
  );
  assert.ok(
    categorizePr({ ...basePr, pendingReviewers: [{ login: "alice", waitingDays: 4 }] })
      .reasons.includes("awaiting @alice · 4d"),
  );
});

const thread = (overrides = {}) => ({
  isResolved: false,
  isOutdated: false,
  firstComment: { body: "_suggestion_ do the thing", login: "alice", isBot: false },
  lastComment: { login: "alice", isBot: false, createdAt: "2026-09-11T10:00:00Z" },
  ...overrides,
});

test("commentLabel reads every dialect the reviewers here actually use", () => {
  // Conventional Comments in italics.
  assert.equal(commentLabel("_suggestion_ The five `.default()`s here"), "suggestion");
  assert.equal(commentLabel("_praise_ Nice catch on `.partial()`"), "praise");
  assert.equal(commentLabel("_robustness_ `reports` is one entry per report"), "robustness");
  // The same vocabulary in bold, with and without a parenthetical.
  assert.equal(commentLabel("**issue (blocking):** this guard reads the cookie"), "issue");
  assert.equal(commentLabel("**nit:** `render` still injects kwargs"), "nit");
  assert.equal(commentLabel("**blocking** — this endpoint is blocked by the rules"), "blocking");
  assert.equal(commentLabel("**Blocking — the caller-supplied `meetingId` is never authorized.**"), "blocking");
  // A bold sentence that is not a label reads as unlabelled, which is
  // actionable — the safe way to be wrong.
  assert.equal(commentLabel("**This keyset read has no supporting index.** The query filters"), null);
  assert.equal(commentLabel("**Defense in depth for the same issue** — optional if you take"), null);
  assert.equal(commentLabel("Plain prose with no label at all"), null);
  // Review bots lead with a tracking comment; the label follows it.
  assert.equal(commentLabel("<!-- CURSOR_AUTOMATION_ID: abc -->\n_bug_ the lease is never acquired"), "bug");
  assert.equal(commentLabel(null), null);
});

test("threadState tells apart done, answered, praise and still-open", () => {
  const me = "greg-py";
  // Explicitly resolved wins however the thread reads.
  assert.equal(threadState(thread({ isResolved: true }), me), "resolved");
  // Your own reply is your answer, whoever opened the thread.
  assert.equal(
    threadState(thread({ lastComment: { login: me, isBot: false } }), me),
    "answered",
  );
  // Praise asks for nothing, so it never counts as unaddressed.
  assert.equal(
    threadState(thread({ firstComment: { body: "_praise_ lovely", login: "alice" } }), me),
    "praise",
  );
  // The anchored code has changed since: the fix almost always landed without
  // anyone marking the thread, and chasing it forever is what makes the count
  // worth ignoring.
  assert.equal(threadState(thread({ isOutdated: true }), me), "stale");
  // Bots review every push and get triaged separately.
  assert.equal(
    threadState(thread({ lastComment: { login: "codex", isBot: true } }), me),
    "bot",
  );
  // An unlabelled comment from someone else, on current code: open.
  assert.equal(
    threadState(thread({ firstComment: { body: "is this right?", login: "alice" } }), me),
    "open",
  );
});

// The shape codex actually posts: a shields.io badge whose alt text carries the
// priority, ahead of the bolded title.
const codexFinding = (priority, title) =>
  `**<sub><sub>![${priority} Badge](https://img.shields.io/badge/${priority}-orange?style=flat)` +
  `</sub></sub>  ${title}**\n\nBody of the finding.\n\nUseful? React with 👍 / 👎.`;

const codexThread = (priority, overrides = {}) =>
  thread({
    firstComment: {
      body: priority ? codexFinding(priority, "Keep unexpected tool calls scoreable") : "No badge here",
      login: "chatgpt-codex-connector",
      isBot: true,
    },
    lastComment: { login: "chatgpt-codex-connector", isBot: true, createdAt: "2026-09-11T10:00:00Z" },
    ...overrides,
  });

test("codexPriority reads the badge codex actually posts", () => {
  assert.equal(codexPriority(codexFinding("P1", "Keep judge failures out of model scores")), "P1");
  assert.equal(codexPriority(codexFinding("P2", "Use monetary units for the revenue target")), "P2");
  // Nothing to read is not a priority: an unbadged body keeps the finding.
  assert.equal(codexPriority("**nitpick:** add JSDoc"), null);
  assert.equal(codexPriority("## CodeQL / Database query built from user-controlled sources"), null);
  // The word alone is not the badge — the marker is the image, not prose.
  assert.equal(codexPriority("P2 badge stuff"), null);
  assert.equal(codexPriority(null), null);
});

test("only P1 codex findings count; the rest are dropped, not left open", () => {
  const me = "greg-py";
  // The team triages P1 only, so a P2 finding nobody has touched stops counting
  // entirely — it must not fall through to "open", which would cost more
  // attention than reading it.
  assert.equal(threadState(codexThread("P2"), me), "low");
  assert.equal(threadState(codexThread("P3"), me), "low");
  assert.equal(threadState(codexThread("P1"), me), "bot");
  // Once a human replies, the thread is a person asking for something and is
  // classified on that, whatever codex badged it.
  assert.equal(
    threadState(codexThread("P2", { lastComment: { login: "alice", isBot: false } }), me),
    "open",
  );
  assert.equal(
    threadState(codexThread("P2", { lastComment: { login: me, isBot: false } }), me),
    "answered",
  );
  // A badge that does not parse reads as no badge and keeps the finding: if the
  // format ever moves, the board over-reports rather than going silent.
  assert.equal(threadState(codexThread(null), me), "bot");
  // Bots that do not use the priority scheme at all are untouched by the gate.
  for (const login of ["github-advanced-security", "cursor", "claude"]) {
    assert.equal(
      threadState(
        thread({
          firstComment: { body: "## CodeQL / SQL injection", login, isBot: true },
          lastComment: { login, isBot: true, createdAt: "2026-09-11T10:00:00Z" },
        }),
        me,
      ),
      "bot",
      login,
    );
  }
});

test("a pull request carrying only sub-P1 codex findings is nobody's move", () => {
  const summary = summarizeThreads(
    [codexThread("P2"), codexThread("P2"), codexThread("P3"), codexThread("P1")],
    "greg-py",
  );
  assert.equal(summary.botThreads, 1, "only the P1 survives the count");
  assert.equal(summary.openThreads, 0, "dropped findings never become open threads");

  // The side effect that matters: the row stops claiming your attention.
  const onlyP2 = summarizeThreads([codexThread("P2"), codexThread("P2")], "greg-py");
  const pr = categorizePr({ ...basePr, ...onlyP2 });
  assert.equal(pr.bucket, "waiting");
  assert.equal(pr.defect, false);
  assert.ok(!pr.reasons.some((reason) => /bot thread/.test(reason)));
});

test("summarizeThreads counts only what still wants something from you", () => {
  const summary = summarizeThreads(
    [
      thread(),
      thread({ lastComment: { login: "alice", isBot: false, createdAt: "2026-09-11T18:00:00Z" } }),
      thread({ isResolved: true }),
      thread({ isOutdated: true }),
      thread({ firstComment: { body: "_praise_ nice", login: "alice" } }),
      thread({ lastComment: { login: "greg-py", isBot: false } }),
      thread({ lastComment: { login: "codex", isBot: true } }),
    ],
    "greg-py",
  );
  assert.equal(summary.openThreads, 2);
  assert.equal(summary.botThreads, 1);
  // The newest live thread, for timing against the last push.
  assert.equal(summary.newestOpenThreadAt, "2026-09-11T18:00:00Z");
  assert.deepEqual(summarizeThreads([], "greg-py"), {
    openThreads: 0,
    botThreads: 0,
    newestOpenThreadAt: null,
  });
});

test("comments left alongside an approval read as follow-ups, not blockers", () => {
  // A reviewer who approves and leaves notes inline still left notes: the old
  // shape zeroed these out entirely and the row said only "approved".
  const approved = categorizePr({ ...basePr, reviewDecision: "APPROVED", openThreads: 6 });
  assert.ok(approved.reasons.includes("6 open follow-ups"));
  assert.ok(approved.reasons.includes("approved"));
  // Outstanding work withdraws the merge-ready claim.
  assert.ok(!approved.reasons.some((reason) => reason.includes("ready to merge")));
  assert.equal(approved.bucket, "needs_you");

  // Unapproved, the same threads are feedback still holding the review open.
  const open = categorizePr({ ...basePr, openThreads: 1 });
  assert.ok(open.reasons.includes("1 open thread"));
  assert.equal(categorizePr({ ...basePr, reviewDecision: "APPROVED", openThreads: 1 })
    .reasons.includes("1 open follow-up"), true);
});

test("a defect never hides the review state behind it", () => {
  // The old shape reported only the defect, so "fix CI and merge" and "fix CI
  // and then wait days for a first look" rendered identically.
  const failing = { ...basePr, ci: "failure" };
  const approved = categorizePr({ ...failing, reviewDecision: "APPROVED" });
  assert.deepEqual(approved.reasons, ["CI failing", "approved"]);
  // "ready to merge" is a claim about the whole PR, so a defect withdraws it.
  assert.ok(!approved.reasons.some((reason) => reason.includes("ready to merge")));
  assert.equal(approved.bucket, "needs_you");

  const unreviewed = categorizePr({
    ...failing,
    pendingReviewers: [{ login: "alice", waitingDays: 4 }],
  });
  assert.deepEqual(unreviewed.reasons, ["CI failing", "awaiting @alice · 4d"]);

  // Unaddressed changes-requested already says whose move it is; no second label.
  const rejected = categorizePr({ ...failing, reviewDecision: "CHANGES_REQUESTED" });
  assert.deepEqual(rejected.reasons, ["changes requested", "CI failing"]);
});

test("a thread opened after the fix lands is not answered by it", () => {
  const pushed = {
    ...basePr,
    reviewDecision: "CHANGES_REQUESTED",
    changesRequestedAt: "2026-09-10T14:00:00Z",
    pushedAt: "2026-09-10T20:00:00Z",
    pushedDaysAgo: 1,
    openThreads: 1,
    pendingReviewers: [{ login: "alice", waitingDays: 3 }],
  };
  // Thread predates the push: the push answered it, so it is their move.
  const answered = categorizePr({ ...pushed, newestOpenThreadAt: "2026-09-10T15:00:00Z" });
  assert.deepEqual(answered.reasons, ["re-review @alice · 1d", "CI green"]);

  // Thread lands after the push: it cannot have been answered by it.
  const reopened = categorizePr({ ...pushed, newestOpenThreadAt: "2026-09-11T09:00:00Z" });
  assert.ok(reopened.reasons.includes("1 open thread"));
  assert.ok(reopened.reasons.includes("changes requested"));
  assert.ok(!reopened.reasons.some((reason) => reason.startsWith("re-review")));
  assert.equal(reopened.bucket, "needs_you");
});

test("re-review names the reviewer and times it from the push, not the request", () => {
  const pr = {
    pushedDaysAgo: 1,
    // alice was requested 6 days ago, but the fix landed 1 day ago — the wait
    // that matters started with the push.
    pendingReviewers: [{ login: "alice", waitingDays: 6 }, { login: "bob", waitingDays: 2 }],
  };
  assert.equal(reReviewReason(pr), "re-review @alice +1 · 1d");
  // Requesting changes took the reviewer off the list; a push tells nobody, so
  // until they are asked again the move is yours.
  assert.equal(
    reReviewReason({ pushedDaysAgo: 3, pendingReviewers: [], pastReviewers: [{ login: "bob" }] }),
    "re-request @bob · 3d",
  );
  assert.equal(reReviewReason({ pushedDaysAgo: null, pendingReviewers: [] }), "re-request review");
});

test("human-gated checks never read as a broken build", () => {
  // Both of these are red until a person acts and say nothing about the branch.
  const gated = [
    { name: "QA Code Review", conclusion: "FAILURE" },
    { name: "Check removed test IDs against QA", conclusion: "FAILURE" },
  ];
  assert.equal(effectiveCi([...gated, { name: "Unit Tests", conclusion: "SUCCESS" }]), "success");
  // A real failure still comes through.
  assert.equal(effectiveCi([...gated, { name: "Unit Tests", conclusion: "FAILURE" }]), "failure");
  // The QA gate is still read from the check the CI verdict ignores.
  assert.equal(qaGateState(gated), "blocked");
  assert.equal(qaGateState([{ name: "QA Code Review", conclusion: "SUCCESS" }]), "passed");
});

test("changes pushed after review put the ball back in the reviewer's court", () => {
  const addressed = {
    ...basePr,
    reviewDecision: "CHANGES_REQUESTED",
    openThreads: 2,
    changesRequestedAt: "2026-08-28T17:52:07Z",
    pushedAt: "2026-08-28T18:40:44Z",
  };
  assert.equal(changesAddressed(addressed), true);
  const result = categorizePr(addressed);
  assert.equal(result.bucket, "waiting");
  assert.ok(result.reasons.includes("re-review @alice"));
  assert.ok(!result.reasons.some((reason) => reason.includes("open thread")));
  // Pushed, but nobody asked to look again: still yours.
  const unasked = categorizePr({ ...addressed, pendingReviewers: [], pastReviewers: [{ login: "carol" }] });
  assert.equal(unasked.bucket, "needs_you");
  assert.ok(unasked.reasons.includes("re-request @carol"));
});

test("stuck CI moves otherwise waiting work into needs-you", () => {
  const stuck = categorizePr({ ...basePr, ci: "pending", ciStuckHours: 5 });
  assert.equal(stuck.bucket, "needs_you");
  assert.equal(stuck.defect, true);
  assert.ok(stuck.reasons.includes("CI stuck 5h"));
  const running = categorizePr({ ...basePr, ci: "pending", ciStuckHours: 0 });
  assert.equal(running.bucket, "waiting");
  assert.ok(running.reasons.includes("CI running"));
});

test("sectionFor respects PR state and QA holds", () => {
  const ticket = (status) => ({ key: "PY-1", status, statusCategory: "indeterminate" });
  assert.equal(
    sectionFor({ ...ticket("In Progress"), prs: [{ bucket: "needs_you", defect: true }] }),
    "needs_you",
  );
  // What an approval means is settled against the ticket when it is categorized.
  const approved = { ...basePr, reviewDecision: "APPROVED" };
  const placed = (status, pr = approved) =>
    sectionFor({ ...ticket(status), prs: [{ ...pr, ...categorizePr(pr, { status, statusDays: 2 }) }] });
  assert.equal(placed("In Testing"), "waiting");
  assert.equal(placed("In Testing", { ...approved, qaGate: "passed" }), "needs_you");
  assert.equal(placed("READY TO MERGE"), "needs_you");
  assert.equal(placed("In Code Review"), "needs_you");
  assert.deepEqual(categorizePr(approved, { status: "In Testing", statusDays: 2 }).reasons, ["approved · in QA · 2d", "CI green"]);
  assert.deepEqual(categorizePr(approved, { status: "In Code Review" }).reasons, ["approved · move to QA", "CI green"]);
  assert.equal(sectionFor({ prs: [], status: "In Testing" }), "waiting");
  assert.equal(sectionFor({ prs: [], status: "In Design Review" }), "waiting");
  assert.equal(sectionFor({ prs: [], status: "NEED CLARIFICATION", statusCategory: "new" }), "waiting");
  // Started and not-started split on the status category, not the name.
  assert.equal(sectionFor({ prs: [], status: "TO DO", statusCategory: "new" }), "to_do");
  assert.equal(sectionFor({ prs: [], status: "In Progress", statusCategory: "indeterminate" }), "in_progress");
  // Work I only lead is a staffing question whatever its status says.
  assert.equal(
    sectionFor({ prs: [], status: "TO DO", statusCategory: "new", leadUnassigned: true }),
    "lead",
  );
});

test("statusRank follows the delivery pipeline", () => {
  // Closest to shipping first, so the work that is one action from done sits
  // at the top of its section.
  const ordered = [
    "READY TO MERGE",
    "In Testing",
    "Ready To Test",
    "In Code Review",
    "In Design Review",
    "In Progress",
    "READY",
    "TO DO",
    "Open PR",
    "Draft PR",
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(
      statusRank(ordered[index - 1]) < statusRank(ordered[index]),
      `${ordered[index - 1]} should outrank ${ordered[index]}`,
    );
  }
  // An unrecognised status sorts last rather than jumping the queue.
  assert.ok(statusRank("Some New Status") > statusRank("Draft PR"));
});

const jiraIssue = (key, overrides = {}) => ({
  key,
  fields: {
    summary: `Summary of ${key}`,
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    issuetype: { subtask: false },
    updated: "2026-08-25T10:00:00.000+0000",
    ...overrides,
  },
});

const prFixture = (overrides = {}) => ({
  ...basePr,
  title: "PY-13548: calendar integration",
  headRefName: "PY-13548-calendar",
  url: "https://github.com/PerformYard/PerformYard/pull/7364",
  updatedAt: "2026-08-25T12:00:00Z",
  ...overrides,
});

test("buildItems joins tickets to PRs and gives orphan PRs stable rows", () => {
  const items = buildItems([jiraIssue("PY-13548")], [prFixture()]);
  assert.equal(items.length, 1);
  assert.equal(items[0].prs.length, 1);
  const orphanItems = buildItems(
    [],
    [prFixture({ title: "Koala API", headRefName: "koala/api", number: 703, isDraft: true })],
  );
  assert.equal(orphanItems[0].id, "PerformYard/PerformYard#703");
  assert.equal(orphanItems[0].key, null);
  assert.equal(orphanItems[0].status, "Draft PR");
});

test("buildItems shows subtasks riding a parent PR without attaching it", () => {
  const subtask = jiraIssue("PY-14156", {
    issuetype: { subtask: true },
    parent: { key: "PY-13548" },
  });
  const items = buildItems([jiraIssue("PY-13548"), subtask], [prFixture()]);
  const sub = items.find((item) => item.key === "PY-14156");
  assert.equal(sub.prs.length, 0);
  assert.deepEqual(sub.parentPrs, [
    {
      number: 7364,
      url: "https://github.com/PerformYard/PerformYard/pull/7364",
      repo: "PerformYard/PerformYard",
    },
  ]);
});

test("buildItems annotates merged work and relabels QA-held approvals", () => {
  const merged = [prFixture({ number: 7350, title: "PY-13695 gate", headRefName: "PY-13695-gate" })];
  const items = buildItems(
    [jiraIssue("PY-13695", { status: { name: "In Testing", statusCategory: { key: "indeterminate" } } })],
    [],
    merged,
  );
  assert.equal(items[0].mergedPrs.length, 1);
  const held = buildItems(
    [jiraIssue("PY-13548", { status: { name: "Ready To Test", statusCategory: { key: "indeterminate" } } })],
    [prFixture({ reviewDecision: "APPROVED" })],
  );
  assert.equal(held[0].section, "waiting");
  assert.deepEqual(held[0].prs[0].reasons, ["approved · awaiting QA", "CI green"]);

  // Once QA has actually started, the work is not still queued for it.
  const inQa = buildItems(
    [jiraIssue("PY-13549", { status: { name: "In Testing", statusCategory: { key: "indeterminate" } } })],
    [prFixture({ headRefName: "PY-13549-x", reviewDecision: "APPROVED" })],
  );
  assert.deepEqual(inQa[0].prs[0].reasons, ["approved · in QA", "CI green"]);
});

test("a ticket whose pull requests are all drafts goes where its status puts it", () => {
  const draft = (key) => prFixture({ title: `${key} prototype`, headRefName: `${key}-proto`, isDraft: true, ci: "failure" });
  const ticket = (key, name, category) =>
    jiraIssue(key, { status: { name, statusCategory: { key: category } } });
  const items = buildItems(
    [
      // Research handed over with its prototype still a draft is not being built.
      ticket("PY-1", "READY TO MERGE", "indeterminate"),
      // Moved back to TO DO while a decision is pending: queued, not in progress.
      ticket("PY-2", "TO DO", "new"),
      ticket("PY-3", "In Progress", "indeterminate"),
    ],
    [draft("PY-1"), draft("PY-2"), draft("PY-3")],
  );
  const section = (key) => items.find((item) => item.key === key).section;
  assert.equal(section("PY-1"), "waiting");
  assert.equal(section("PY-2"), "to_do");
  assert.equal(section("PY-3"), "in_progress");
  // None of them offers to implement work that already has a pull request.
  assert.ok(items.every((item) => item.action === null));
});

test("a draft with no ticket of yours parks once nobody pushes to it", () => {
  const orphan = (number, pushedDaysAgo) =>
    prFixture({ number, title: "Prototype", headRefName: `proto-${number}`, isDraft: true, pushedDaysAgo });
  const items = buildItems([], [orphan(1, 2), orphan(2, CONFIG.parkedDraftDays), orphan(3, undefined)]);
  const section = (number) => items.find((item) => item.id.endsWith(`#${number}`)).section;
  assert.equal(section(1), "in_progress");
  assert.equal(section(2), "parked");
  // An unknown push time never hides anything.
  assert.equal(section(3), "in_progress");
  // A key that is not one of mine is linked, never adopted as the row's ticket.
  const [foreign] = buildItems([], [prFixture({ title: "[PROTOTYPE] PY-8339: Billing", headRefName: "billing", isDraft: true })]);
  assert.equal(foreign.key, null);
  assert.equal(foreign.ticketKey, "PY-8339");
  assert.match(foreign.url, /browse\/PY-8339$/);
  assert.equal(foreign.action, null);
});

test("work whose every PR is still a draft sits in progress, not needs-you", () => {
  const draftOnly = buildItems(
    [],
    [prFixture({ number: 700, title: "Prototype", headRefName: "proto", isDraft: true, ci: "failure", mergeable: "CONFLICTING" })],
  );
  // A draft is started work, so it belongs with what is in progress.
  assert.equal(draftOnly[0].section, "in_progress");
  // Even a draft carrying real problems: it is unfinished, not anyone's move.
  assert.ok(draftOnly[0].prs[0].reasons.includes("CI failing"));

  // A ready PR alongside a draft still decides the section.
  const mixed = buildItems(
    [jiraIssue("PY-14000")],
    [
      prFixture({ number: 1, headRefName: "PY-14000-a", isDraft: true }),
      prFixture({ number: 2, headRefName: "PY-14000-b", ci: "failure" }),
    ],
  );
  assert.equal(mixed[0].section, "needs_you");
});

const reviewThread = ({ body, first, last, isResolved = false, isOutdated = false, bot = false }) => ({
  isResolved,
  isOutdated,
  firstComment: { nodes: [{ body, author: { login: first, __typename: bot ? "Bot" : "User" } }] },
  lastComment: {
    nodes: [{ createdAt: "2026-08-24T12:00:00Z", author: { login: last, __typename: bot ? "Bot" : "User" } }],
  },
});

test("mapReviewPr exposes review context without deriving actions", () => {
  const node = {
    number: 7400,
    title: "PY-14000 Some feature",
    url: "u",
    isDraft: false,
    author: { login: "marcus" },
    repository: { nameWithOwner: "PerformYard/PerformYard" },
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-25T00:00:00Z",
    additions: 10,
    deletions: 2,
    reviewThreads: {
      nodes: [
        // The author had the last word: answered.
        reviewThread({ body: "_question_ why here?", first: "greg-py", last: "marcus" }),
        // A reviewer's point the author has not come back to: open.
        reviewThread({ body: "**issue:** this leaks", first: "greg-py", last: "greg-py" }),
        reviewThread({ body: "_bug_ off by one", first: "greg-py", last: "greg-py", isResolved: true }),
        reviewThread({ body: "_praise_ tidy", first: "greg-py", last: "greg-py" }),
        // Codex badges every finding; only P1 reaches the count.
        reviewThread({ body: codexFinding("P1", "Keep judge failures out of scores"), first: "chatgpt-codex-connector", last: "chatgpt-codex-connector", bot: true }),
        reviewThread({ body: codexFinding("P2", "Use monetary units for the target"), first: "chatgpt-codex-connector", last: "chatgpt-codex-connector", bot: true }),
        // CodeQL does not badge priority at all, so the gate leaves it alone.
        reviewThread({ body: "## CodeQL / SQL injection", first: "github-advanced-security", last: "github-advanced-security", bot: true }),
      ],
    },
    commits: {
      nodes: [
        {
          commit: {
            committedDate: "2026-08-24T00:00:00Z",
            statusCheckRollup: {
              contexts: { nodes: [{ name: "QA Code Review", conclusion: "FAILURE" }] },
            },
          },
        },
      ],
    },
  };
  const pr = mapReviewPr(node, Date.parse("2026-08-26T00:00:00Z"));
  assert.equal(pr.id, "PerformYard/PerformYard#7400");
  assert.equal(pr.ticketKey, "PY-14000");
  assert.equal(pr.openThreads, 1, "answered, resolved and praise threads all drop out");
  assert.equal(pr.botThreads, 2, "the P1 and the unbadged CodeQL finding, not the P2");
  assert.equal(pr.qaGate, "blocked");
  assert.equal(pr.ageDays, 6);
  assert.equal("launch" in pr, false);
});

test("upstream failures report a reason, never a page of someone's HTML", async () => {
  const body = (text) => ({ text: async () => text });
  // A gateway 504 returns GitHub's error page, easter-egg comment and all.
  assert.equal(
    await failureReason(body("<!DOCTYPE html>\n<!-- Hello future GitHubber! I bet you're here")),
    "",
  );
  assert.equal(await failureReason(body("  ")), "");
  assert.equal(await failureReason(body('{"message":"Bad credentials"}')), ": Bad credentials");
  // Jira reports its own way.
  assert.equal(
    await failureReason(body('{"errorMessages":["Field \'assignee\' does not exist"]}')),
    ": Field 'assignee' does not exist",
  );
  // Short plain text is worth repeating as-is.
  assert.equal(await failureReason(body("rate limit exceeded")), ": rate limit exceeded");
  // A body that cannot even be read must not break the error path.
  assert.equal(await failureReason({ text: async () => { throw new Error("aborted"); } }), "");
});

test("dashboard has no agent execution or external write endpoints", () => {
  const server = readFileSync(new URL("./server.js", import.meta.url), "utf8");
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const integrations = readFileSync(new URL("./lib/integrations.js", import.meta.url), "utf8");
  const packageJson = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  for (const forbidden of [
    "startSession",
    "runPolicyPass",
    "/api/launch",
    "/api/approve",
    "/api/transition",
    "transitionJiraIssue",
    "child_process.spawn",
  ]) {
    assert.equal(server.includes(forbidden), false, `${forbidden} should not be served`);
    assert.equal(ui.includes(forbidden), false, `${forbidden} should not be rendered`);
    assert.equal(integrations.includes(forbidden), false, `${forbidden} should not be integrated`);
  }
  assert.equal(server.includes('req.method === "POST"'), false, "server should expose GET routes only");
  assert.equal(ui.includes('method: "POST"'), false, "UI should not call write endpoints");
  assert.deepEqual(Object.keys(packageJson.scripts), ["start", "test"]);
});

test("dashboard keeps work queues primary instead of rendering summary metrics", () => {
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.equal(ui.includes('id="overview"'), false);
  assert.equal(ui.includes('class="metric'), false);
  for (const queue of ["needs_you", "waiting", "reviews", "in_progress", "to_do", "lead", "shipping", "held", "parked"]) {
    assert.equal(ui.includes(`id="card-${queue}"`), true, `${queue} queue should remain visible`);
  }
});

test("every reason the model emits has a severity the UI can classify", () => {
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  // Each settled-state label the model can produce must be in the good list, or
  // merge-ready work renders as undifferentiated grey.
  for (const reason of [
    "CI green",
    "approved",
    "approved · ready to merge",
    "QA passed · ready to merge",
    "approved · awaiting QA",
    "approved · in QA",
    "approved · move to QA",
  ]) {
    assert.ok(ui.includes(`"${reason}"`), `GOOD list is missing ${reason}`);
  }
  for (const reason of ["changes requested", "CI failing", "conflicts with base"]) {
    assert.ok(ui.includes(`"${reason}"`), `BAD list is missing ${reason}`);
  }
  // The wait clock is read off both waiting label shapes.
  assert.ok(ui.includes("/^(awaiting|re-review)/"));
  assert.ok(ui.includes("/· (\\d+)d$/"));
  // Nobody asked, or nobody asked again, is flagged at any age.
  assert.ok(ui.includes("/^(no reviewer requested|re-request)/"));
  // Follow-ups on an approved PR are worth doing, but they are not blockers.
  assert.ok(ui.includes("/open follow-up/"));
  assert.ok(ui.includes("/open thread/"));
  // Stack position is a warning, never a defect and never silence.
  assert.ok(ui.includes("/^blocked · behind/"));
  assert.ok(ui.includes("/^stack root/"));
  // A QA label now carries its own clock, so the settled-state lookup has to
  // read the label with the age stripped off.
  assert.ok(ui.includes("QA_WAITS"));
});

test("the theme toggle overrides the system scheme in both directions", () => {
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  // One palette, resolved by color-scheme, so light and dark cannot drift apart.
  assert.equal(ui.includes("prefers-color-scheme"), false);
  assert.ok(ui.includes('--paper: light-dark('));
  assert.ok(ui.includes(':root[data-theme="light"] { color-scheme: light; }'));
  assert.ok(ui.includes(':root[data-theme="dark"] { color-scheme: dark; }'));
  // The row-action defaults set opacity:0, so the toggle's override has to come
  // after them or the control renders invisible.
  assert.ok(ui.indexOf(".row:hover .act") < ui.indexOf(".theme-toggle {"));
  // The stored choice is applied before the stylesheet, not after first paint.
  assert.ok(ui.indexOf('localStorage.getItem("inflight-theme")') < ui.indexOf("<style>"));
});

test("reviewerWaits keeps only still-pending reviewers, newest request winning", () => {
  const now = Date.parse("2026-09-11T00:00:00Z");
  const waits = reviewerWaits(
    [
      { requestedReviewer: { login: "alice" } },
      { requestedReviewer: { name: "platform-team" } },
      { requestedReviewer: { login: "carol" } },
    ],
    [
      { createdAt: "2026-09-01T00:00:00Z", requestedReviewer: { login: "alice" } },
      // A re-request restarts alice's clock.
      { createdAt: "2026-09-09T00:00:00Z", requestedReviewer: { login: "alice" } },
      { createdAt: "2026-09-05T00:00:00Z", requestedReviewer: { name: "platform-team" } },
      // bob reviewed and is no longer requested, so he never appears.
      { createdAt: "2026-08-20T00:00:00Z", requestedReviewer: { login: "bob" } },
    ],
    now,
  );
  assert.deepEqual(
    waits.map((entry) => [entry.login, entry.waitingDays]),
    [["platform-team", 6], ["alice", 2], ["carol", null]],
  );
});

test("awaitingReason names the longest-waiting reviewer and counts the rest", () => {
  assert.equal(
    awaitingReason({ ageDays: 9, pendingReviewers: [{ login: "alice", waitingDays: 4 }] }),
    "awaiting @alice · 4d",
  );
  assert.equal(
    awaitingReason({
      ageDays: 9,
      pendingReviewers: [{ login: "alice", waitingDays: 4 }, { login: "bob", waitingDays: 1 }],
    }),
    "awaiting @alice +1 · 4d",
  );
  // Nobody on the hook is a different problem from a slow reviewer.
  assert.equal(
    awaitingReason({ ageDays: 9, pendingReviewers: [] }),
    "no reviewer requested · 9d",
  );
  // A request older than the timeline window: say who, invent no clock.
  assert.equal(
    awaitingReason({ ageDays: 9, pendingReviewers: [{ login: "alice", waitingDays: null }] }),
    "awaiting @alice",
  );
});

test("prNumbersInCommits reads squash-merge subjects", () => {
  const numbers = prNumbersInCommits([
    "PY-14338: Stop a non-finite numeric field value from breaking reads (#7502)",
    "update plock (#7508)",
    "Merge branch 'master' into thing",
    null,
    // A squash body quoting another pull request is a mention, not a merge.
    "Tidy the release notes (#7510)\n\n* Follow-up to (#7401)",
  ]);
  assert.deepEqual([...numbers].sort((a, b) => a - b), [7502, 7508, 7510]);
});

test("buildShipping lists merged work absent from the last release", () => {
  const merged = [
    { number: 7502, title: "PY-14338 Fix reads", url: "u1", repo: "o/PerformYard", mergedAt: "2026-09-10T20:00:00Z", headRefName: "PY-14338-fix" },
    { number: 7400, title: "Already out", url: "u2", repo: "o/PerformYard", mergedAt: "2026-09-09T20:00:00Z", headRefName: "x" },
    { number: 12, title: "Logan work", url: "u3", repo: "o/Logan", mergedAt: "2026-09-11T20:00:00Z", headRefName: "y" },
  ];
  const releases = new Map([
    ["o/PerformYard", { tag: "v29.37.0", ahead: 1, truncated: false, numbers: new Set([7502]) }],
    ["o/Logan", { none: true }],
  ]);
  const shipping = buildShipping(merged, releases);
  assert.deepEqual(shipping.items.map((item) => item.number), [7502]);
  assert.equal(shipping.items[0].tag, "v29.37.0");
  assert.equal(shipping.items[0].ticketKey, "PY-14338");
  // A repo with no release is named, never silently counted as fully shipped.
  assert.equal(shipping.note, "Logan: no release to compare");
  assert.equal(buildShipping([], new Map()).note, null);
});

test("a release lookup that failed is not a repo that never released", () => {
  const shipping = buildShipping(
    [{ number: 12, title: "t", url: "u", repo: "o/Logan", mergedAt: "2026-09-11T20:00:00Z", headRefName: "y" }],
    new Map([["o/Logan", { error: "GitHub GraphQL: no answer in 15s" }]]),
  );
  assert.equal(shipping.items.length, 0);
  assert.equal(shipping.note, "Logan: release lookup failed");
});

test("a pull request merged into its parent's branch ships when the parent does", () => {
  const merged = (number, head, base, extra = {}) => ({
    number,
    title: `PY-${14000 + number} change ${number}`,
    url: `u${number}`,
    repo: "o/app",
    mergedAt: `2026-09-${10 + number}T00:00:00Z`,
    headRefName: head,
    baseRefName: base,
    baseIsDefault: base === "master",
    ...extra,
  });
  const release = (numbers) =>
    new Map([["o/app", { tag: "v2", ahead: 1, truncated: false, numbers: new Set(numbers) }]]);
  const stack = [merged(1, "root", "master"), merged(2, "mid", "root"), merged(3, "top", "mid")];
  // The root's squash commit carries only its own number, and brings the
  // whole chain with it.
  assert.deepEqual(
    buildShipping(stack, release([1])).items.map((item) => item.number).sort(),
    [1, 2, 3],
  );
  assert.deepEqual(buildShipping(stack, release([])).items, []);
  // Merged into a branch that is still open: not on the default branch yet.
  const open = [{ repo: "o/app", headRefName: "open-parent" }];
  const intoOpen = buildShipping([merged(4, "child", "open-parent")], release([]), open);
  assert.deepEqual(intoOpen.items.map((item) => item.number), [4]);
  // A chain that leads nowhere known is counted, not dropped without a word.
  const lost = buildShipping([merged(5, "orphan", "someone-elses-branch")], release([]));
  assert.equal(lost.items.length, 0);
  assert.equal(lost.note, "app: 1 stacked untraced");
});

test("buildShipping flags a release gap too deep for the compare endpoint", () => {
  const releases = new Map([["o/r", { tag: "v1", ahead: 400, truncated: true, numbers: new Set([5]) }]]);
  const shipping = buildShipping(
    [{ number: 5, title: "t", url: "u", repo: "o/r", mergedAt: "2026-09-10T00:00:00Z", headRefName: "b" }],
    releases,
  );
  assert.equal(shipping.items.length, 1);
  assert.equal(shipping.note, "r: 400+ commits unreleased");
});

const stackPr = (number, head, base, extra = {}) => ({
  number,
  repo: "org/app",
  url: `https://github.com/org/app/pull/${number}`,
  headRefName: head,
  baseRefName: base,
  baseIsDefault: base === "master",
  isDraft: false,
  openThreads: 0,
  botThreads: 0,
  ci: "success",
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  qaGate: null,
  pendingReviewers: [],
  ageDays: 1,
  ...extra,
});

test("a stack is rebuilt from base branches and every link names its root", () => {
  const stacks = buildStacks([
    stackPr(1, "a", "master"),
    stackPr(2, "b", "a"),
    stackPr(3, "c", "b"),
    stackPr(9, "solo", "master"),
  ]);
  assert.deepEqual(
    [...stacks].map(([key, stack]) => [key, stack.depth, stack.root, stack.behind]),
    [["org/app#1", 0, 1, 2], ["org/app#2", 1, 1, 0], ["org/app#3", 2, 1, 0], ["org/app#9", 0, 9, 0]],
  );
  // The root names what is riding on it; the links name what they wait for.
  assert.equal(stacks.get("org/app#1").blockedBy, null);
  assert.equal(stacks.get("org/app#3").blockedBy, 1);
});

test("pull requests that share a number in different repos are different pull requests", () => {
  const [app, other] = withStacks([
    stackPr(7, "a", "master"),
    stackPr(7, "b", "a", { repo: "org/other" }),
  ]);
  // Same number, same branch name underneath — but the base lives in another repo.
  assert.equal(app.stack.behind, 0);
  assert.equal(other.stack.blockedBy, null);
});

test("a pull request stacked on an unmerged one never claims to be mergeable", () => {
  const [root, child] = withStacks([stackPr(1, "a", "master"), stackPr(2, "b", "a")]);
  // Identical review and CI state; only the base differs.
  assert.ok(categorizePr(root).reasons.includes("approved · ready to merge"));
  const blocked = categorizePr(child);
  assert.equal(blocked.reasons.includes("approved · ready to merge"), false);
  assert.deepEqual(blocked.reasons, ["blocked · behind #1", "approved", "CI green"]);
  // Waiting on the change underneath is not a defect of this change, or every
  // row of a stack would become your move at once.
  assert.equal(blocked.defect, false);
  assert.equal(blocked.bucket, "waiting");
});

test("the root of a blocked stack states how much is queued behind it", () => {
  const [root] = withStacks([
    stackPr(1, "a", "master", { mergeable: "CONFLICTING" }),
    stackPr(2, "b", "a"),
    stackPr(3, "c", "b"),
  ]);
  const { reasons, bucket, defect } = categorizePr(root);
  assert.equal(reasons[0], "stack root · 2 behind");
  assert.ok(reasons.includes("conflicts with base"));
  // The conflict is the defect; being a root is only position.
  assert.equal(defect, true);
  assert.equal(bucket, "needs_you");
});

test("a base that is already merged reads as unstacked, not as blocked forever", () => {
  // The parent pull request is gone from the open set; GitHub retargets these
  // to the default branch shortly, and until it does "blocked by something
  // already merged" would be a lie.
  const stacks = buildStacks([stackPr(2, "b", "merged-parent")]);
  assert.equal(stacks.get("org/app#2").blockedBy, null);
  assert.equal(stacks.get("org/app#2").depth, 0);
});

test("a cycle in base branches terminates instead of hanging the board", () => {
  const stacks = buildStacks([stackPr(1, "a", "b"), stackPr(2, "b", "a")]);
  assert.equal(stacks.size, 2);
  for (const stack of stacks.values()) assert.ok(Number.isFinite(stack.depth));
});

test("held work leaves your move however green it reads", () => {
  const items = buildItems(
    [
      {
        key: "PY-1",
        fields: {
          summary: "(HOLD MERGE) Remove the legacy navigation",
          status: { name: "READY TO MERGE", statusCategory: { key: "indeterminate" } },
          issuetype: { subtask: false },
          updated: "2026-09-01T00:00:00Z",
        },
      },
    ],
    [{ ...stackPr(7209, "nav", "master"), qaGate: "passed", title: "PY-1 nav", ...categorizePr(stackPr(7209, "nav", "master")) }],
  );
  const held = items.find((item) => item.key === "PY-1");
  assert.equal(held.section, "held");
  // The signals stay honest — only the routing changes.
  assert.ok(held.prs[0].reasons.includes("QA passed · ready to merge"));
  assert.equal(isHeld({ summary: "(HOLD) SCIM failing" }), true);
  assert.equal(isHeld({ summary: "Withholding a value" }), false);
});

test("only urgent priorities jump the queue, and they jump it whole", () => {
  assert.equal(priorityKey("P1-High"), "p1");
  assert.equal(priorityKey("p1 - high"), "p1");
  assert.equal(isUrgent({ priority: "P1-High" }), true);
  assert.equal(isUrgent({ priority: "P2-Medium" }), false);
  const issue = (key, priority, status) => ({
    key,
    fields: {
      summary: key,
      priority: { name: priority },
      status: { name: status, statusCategory: { key: "indeterminate" } },
      issuetype: { subtask: false },
      updated: "2026-09-01T00:00:00Z",
    },
  });
  const items = buildItems(
    [issue("PY-READY", "P3-Low", "READY TO MERGE"), issue("PY-URGENT", "P1-High", "In Progress")],
    [],
  );
  // A P1 that has barely started outranks a P3 one click from done; nothing
  // below P1 reorders anything.
  assert.deepEqual(items.map((item) => item.key), ["PY-URGENT", "PY-READY"]);
});

test("status age is read from the changelog, not from the updated stamp", () => {
  const changelog = {
    histories: [
      { created: "2026-09-01T00:00:00Z", items: [{ field: "status" }] },
      { created: "2026-09-09T00:00:00Z", items: [{ field: "status" }] },
      // A later comment must not be mistaken for a transition.
      { created: "2026-09-14T00:00:00Z", items: [{ field: "Comment" }] },
    ],
  };
  assert.equal(statusSince(changelog), "2026-09-09T00:00:00Z");
  assert.equal(statusSince({ histories: [] }), null);
  assert.equal(daysSince(null), null);
  assert.equal(daysSince("2026-09-09T00:00:00Z", Date.parse("2026-09-15T00:00:00Z")), 6);
});

test("a QA wait states how long it has been queued", () => {
  const pr = { ...stackPr(1, "a", "master"), title: "PY-2 thing" };
  const items = buildItems(
    [
      {
        key: "PY-2",
        changelog: { histories: [{ created: "2026-09-09T00:00:00Z", items: [{ field: "status" }] }] },
        fields: {
          summary: "thing",
          status: { name: "Ready To Test", statusCategory: { key: "indeterminate" } },
          issuetype: { subtask: false },
          updated: "2026-09-14T00:00:00Z",
        },
      },
    ],
    [{ ...pr, ...categorizePr(pr) }],
  );
  const label = items[0].prs[0].reasons.find((reason) => reason.startsWith("approved · awaiting QA"));
  assert.match(label, /^approved · awaiting QA · \d+d$/);
});

test("each pull request defect routes to the skill that addresses it", () => {
  const pr = (extra) => ({ number: 7486, repo: "PerformYard/PerformYard", openThreads: 0, botThreads: 0, ci: "success", mergeable: "MERGEABLE", ...extra });
  // Feedback outranks the rest: it is the one another person is waiting on.
  assert.deepEqual(promptForPr(pr({ reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING", ci: "failure" })), {
    skill: "address-review",
    prompt: "/address-review 7486 --repo PerformYard/PerformYard",
  });
  assert.deepEqual(promptForPr(pr({ openThreads: 3 })).skill, "address-review");
  // Bot findings are still feedback, and they survive an approval.
  assert.equal(promptForPr(pr({ reviewDecision: "APPROVED", botThreads: 2 })).skill, "address-review");
  assert.deepEqual(promptForPr(pr({ mergeable: "CONFLICTING" })), {
    skill: "resolve-conflicts",
    prompt: "/resolve-conflicts 7486 --repo PerformYard/PerformYard",
  });
  // A clean pull request still offers a review of your own, which fixes what it finds.
  assert.deepEqual(promptForPr(pr({ reviewDecision: "APPROVED" })), {
    skill: "deep-review",
    prompt: "/deep-review 7486 --repo PerformYard/PerformYard",
  });
  assert.equal(promptForPr({ number: null, repo: "x" }), null);
  // A draft never becomes anyone's move, but its problems are still one click away.
  assert.equal(promptForPr(pr({ isDraft: true, mergeable: "CONFLICTING", ci: "failure" })).skill, "resolve-conflicts");
  // A review someone asked for is still a review, draft or not.
  assert.equal(promptForReview({ number: 704, repo: "PerformYard/QA", isDraft: true }).skill, "deep-review");
});

test("feedback already answered by a push is not re-offered as work", () => {
  const answered = {
    number: 7486,
    repo: "PerformYard/PerformYard",
    reviewDecision: "CHANGES_REQUESTED",
    changesRequestedAt: "2026-09-10T00:00:00Z",
    pushedAt: "2026-09-12T00:00:00Z",
    openThreads: 0,
    botThreads: 0,
    ci: "success",
    mergeable: "MERGEABLE",
  };
  assert.equal(changesAddressed(answered), true);
  assert.equal(promptForPr(answered).skill, "deep-review");
});

test("a failing or stuck build goes to fix-ci", () => {
  const pr = (extra) => ({ number: 7486, repo: "PerformYard/PerformYard", openThreads: 0, botThreads: 0, ci: "success", mergeable: "MERGEABLE", ...extra });
  assert.deepEqual(promptForPr(pr({ ci: "failure" })), {
    skill: "fix-ci",
    prompt: "/fix-ci 7486 --repo PerformYard/PerformYard",
  });
  // Pending for hours is stuck, not running — the same skill reruns it.
  assert.equal(promptForPr(pr({ ci: "pending", ciStuckHours: 3 })).skill, "fix-ci");
  assert.notEqual(promptForPr(pr({ ci: "pending", ciStuckHours: 0 })).skill, "fix-ci");
});

test("a stacked pull request's conflicts and CI are fixed across the whole stack", () => {
  const pr = (extra) => ({ number: 7392, repo: "PerformYard/PerformYard", openThreads: 0, botThreads: 0, ci: "success", mergeable: "MERGEABLE", ...extra });
  const root = { blockedBy: null, depth: 0, behind: 3 };
  const middle = { blockedBy: 7392, depth: 1, behind: 0 };
  assert.equal(
    promptForPr(pr({ mergeable: "CONFLICTING", stack: root })).prompt,
    "/resolve-conflicts 7392 --stack --repo PerformYard/PerformYard",
  );
  assert.equal(
    promptForPr(pr({ ci: "failure", stack: middle })).prompt,
    "/fix-ci 7392 --stack --repo PerformYard/PerformYard",
  );
  // A pull request alone on its base has no stack to cascade.
  assert.equal(
    promptForPr(pr({ mergeable: "CONFLICTING", stack: { blockedBy: null, depth: 0, behind: 0 } })).prompt,
    "/resolve-conflicts 7392 --repo PerformYard/PerformYard",
  );
});

test("a review you have already given is a second pass, not a first", () => {
  const pr = { number: 7500, repo: "PerformYard/QA" };
  assert.deepEqual(promptForReview(pr), {
    skill: "deep-review",
    prompt: "/deep-review 7500 --repo PerformYard/QA",
  });
  assert.equal(promptForReview({ ...pr, viewerReviewState: "CHANGES_REQUESTED" }).skill, "verify-review");
});

test("a ticket with no pull request is the one that wants implementing", () => {
  assert.deepEqual(promptForTicket({ key: "PY-14135", prs: [] }), {
    skill: "implement-ticket",
    prompt: "/implement-ticket PY-14135 --repo PerformYard/PerformYard",
  });
  // A subtask rides its parent's branch, so the parent's repo is the target.
  assert.match(
    promptForTicket({ key: "PY-1", prs: [], parentPrs: [{ repo: "PerformYard/Logan" }] }).prompt,
    /--repo PerformYard\/Logan$/,
  );
  // An open pull request carries its own skill on its own line.
  assert.equal(promptForTicket({ key: "PY-1", prs: [{ number: 1 }] }), null);
  // Merged and still open: what is left is QA's.
  assert.deepEqual(promptForTicket({ key: "PY-1", prs: [], mergedPrs: [{ number: 1 }] }), {
    skill: "qa-guide",
    prompt: "/qa-guide PY-1",
  });
  // An orphan pull request row has no ticket key to implement.
  assert.equal(promptForTicket({ key: null, prs: [] }), null);
});

test("held work keeps the skill its problem calls for", () => {
  const pr = { number: 7209, repo: "PerformYard/PerformYard", headRefName: "nav", baseRefName: "master", baseIsDefault: true, title: "PY-1 nav", openThreads: 2, botThreads: 0, ci: "success", mergeable: "MERGEABLE", isDraft: false, reviewDecision: "APPROVED", pendingReviewers: [], ageDays: 3 };
  const items = buildItems(
    [
      {
        key: "PY-1",
        fields: {
          summary: "(HOLD MERGE) Remove the legacy navigation",
          status: { name: "READY TO MERGE", statusCategory: { key: "indeterminate" } },
          issuetype: { subtask: false },
          updated: "2026-09-01T00:00:00Z",
        },
      },
    ],
    [{ ...pr, ...categorizePr(pr), action: promptForPr(pr) }],
  );
  const held = items.find((item) => item.key === "PY-1");
  // The hold keeps it out of your move, not out of reach.
  assert.equal(held.section, "held");
  assert.equal(held.prs[0].action.skill, "address-review");
});

test("copying a prompt is the only thing the button does", () => {
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  // No fetch, no endpoint, no agent — the reader decides whether to run it.
  assert.ok(ui.includes("navigator.clipboard.writeText"));
  assert.equal(/data-copy[\s\S]{0,400}fetch\(/.test(ui), false);
  for (const forbidden of ["/api/launch", "startSession", "data-agent"]) {
    assert.equal(ui.includes(forbidden), false, `${forbidden} should not have returned`);
  }
});

test("a truncated GraphQL body is named and retried, not parroted", async () => {
  const integrations = readFileSync(new URL("./lib/integrations.js", import.meta.url), "utf8");
  // Scoped to the GraphQL path: the Jira fetcher reads small bodies where
  // res.json() is right.
  const graphqlFn = integrations.slice(
    integrations.indexOf("const graphql = async"),
    integrations.indexOf("const CORE_FIELDS"),
  );
  // res.json() on a cut-off body throws "Unexpected end of JSON input", which
  // names the symptom, hides the cause, and hides that it is transient.
  assert.equal(graphqlFn.includes("await res.json()"), false);
  assert.ok(graphqlFn.includes("JSON.parse(body)"));
  assert.ok(graphqlFn.includes("truncated response"));
  // It retries on the same budget as a gateway blip rather than banner-ing.
  assert.match(integrations, /catch \{\s*if \(attempt <= CONFIG\.upstreamRetries\)/);
});

test("the cache window stays well under the refresh interval", () => {
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  const refreshMs = Number(ui.match(/const REFRESH_MS = ([\d_]+);/)[1].replace(/_/g, ""));
  // Equal clocks drift out of phase: a poll landing just inside the cache
  // window gets data already a full interval old and then holds it for another
  // interval, so the worst displayed age is TTL + interval rather than the
  // interval the board advertises. Keeping the cache to a fraction of the
  // interval bounds that at the interval itself.
  assert.ok(
    CONFIG.upstreamTtlMs <= refreshMs / 2,
    `cache ${CONFIG.upstreamTtlMs}ms must be at most half of the ${refreshMs}ms refresh`,
  );
  // Worst-case staleness a reader can ever see, stated as the board's promise.
  assert.ok(CONFIG.upstreamTtlMs + refreshMs <= 360_000);
});

test("a stack only folds away where the rows are nobody's move", () => {
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  // A blocked change carrying its own defect is still your move — you can push
  // to a stacked branch — so folding it away left "Needs you" rendering an
  // item count above an empty section.
  assert.match(ui, /sectionRows\(items, "hide", section\.id === "waiting"\)/);
  assert.match(ui, /const sectionRows = \(items, action, collapseStacks = false\)/);
  assert.match(ui, /const root = collapseStacks \? blockedRootOf\(item\) : null;/);
});

test("work I lead but nobody owns is its own lane, never mixed into my queue", () => {
  const issue = (key, status, category) => ({
    key,
    changelog: { histories: [] },
    fields: {
      summary: key,
      status: { name: status, statusCategory: { key: category } },
      issuetype: { subtask: false },
      updated: "2026-09-14T00:00:00Z",
    },
  });
  const items = buildItems(
    [issue("PY-MINE-DOING", "In Progress", "indeterminate"), issue("PY-MINE-TODO", "TO DO", "new")],
    [],
    [],
    [issue("PY-LEAD", "TO DO", "new")],
  );
  const section = (key) => items.find((item) => item.key === key).section;
  // Started and not-started are different questions and get different lanes.
  assert.equal(section("PY-MINE-DOING"), "in_progress");
  assert.equal(section("PY-MINE-TODO"), "to_do");
  // A ticket I only lead never lands in either, however its status reads.
  assert.equal(section("PY-LEAD"), "lead");
  assert.equal(items.find((item) => item.key === "PY-LEAD").leadUnassigned, true);
  assert.equal(items.find((item) => item.key === "PY-MINE-TODO").leadUnassigned, false);
  // Unowned work is not mine to implement. As its lead, my move is to groom it
  // or, for a bug, to find the cause; once groomed, only staffing is left.
  assert.deepEqual(promptForTicket({ key: "PY-1", prs: [], leadUnassigned: true, issueType: "Story", groomed: false }), {
    skill: "jira-ticket-groomer",
    prompt: "/jira-ticket-groomer PY-1",
  });
  assert.deepEqual(promptForTicket({ key: "PY-1", prs: [], leadUnassigned: true, issueType: "Bug", groomed: false }), {
    skill: "diagnose-bug",
    prompt: "/diagnose-bug PY-1",
  });
  // Already groomed: grooming again brings the notes up to date.
  assert.equal(promptForTicket({ key: "PY-1", prs: [], leadUnassigned: true, issueType: "Story", groomed: true }).skill, "jira-ticket-groomer");
  assert.equal(promptForTicket({ key: "PY-1", prs: [], leadUnassigned: false }).skill, "implement-ticket");
});

test("the lead query never claims work someone else is already assigned", () => {
  // The whole point of the narrower query: "I lead it and nobody has it" is a
  // staffing question of mine; "I lead it and Paul has it" is Paul's work.
  assert.match(CONFIG.jiraLeadUnassignedJql, /assignee IS EMPTY/);
  assert.equal(/assignee\s*!=\s*currentUser/.test(CONFIG.jiraLeadUnassignedJql), false);
  // Unbounded this is a junk drawer of tickets named years ago, so it is windowed.
  assert.match(CONFIG.jiraLeadUnassignedJql, /updated >= -%DAYS%d/);
  assert.ok(CONFIG.leadUnassignedLookbackDays > 0);
});

// Stands in for the network: each call takes the next scripted answer.
const withFetch = async (answers, run) => {
  const original = globalThis.fetch;
  const calls = [];
  const env = { email: process.env.JIRA_EMAIL, token: process.env.JIRA_API_TOKEN };
  process.env.JIRA_EMAIL ??= "me@example.com";
  process.env.JIRA_API_TOKEN ??= "token";
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    const answer = answers.shift();
    if (answer instanceof Error) throw answer;
    return { ok: true, status: 200, json: async () => answer, text: async () => JSON.stringify(answer) };
  };
  try {
    return await run(calls);
  } finally {
    globalThis.fetch = original;
    if (env.email === undefined) delete process.env.JIRA_EMAIL;
    if (env.token === undefined) delete process.env.JIRA_API_TOKEN;
  }
};

test("a dropped connection is retried, and every call carries a deadline", async () => {
  await withFetch([new TypeError("fetch failed"), { issues: [{ key: "PY-1" }] }], async (calls) => {
    const issues = await fetchJiraIssues("project = PY");
    assert.deepEqual(issues.map((issue) => issue.key), ["PY-1"]);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((call) => call.init.signal instanceof AbortSignal));
  });
  // Past the retry budget it reaches the banner named, not as a bare TypeError.
  const dropped = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } });
  await withFetch([dropped, dropped], async () => {
    await assert.rejects(fetchJiraIssues("project = PY"), /Jira: ECONNRESET/);
  });
});

test("status history is fetched only for tickets whose QA wait shows it", async () => {
  const issue = (id, key, status) => ({ id, key, fields: { status: { name: status } } });
  await withFetch(
    [
      { issues: [issue("1", "PY-1", "In Progress"), issue("2", "PY-2", "In Testing")] },
      {
        issueChangeLogs: [
          { issueId: "2", changeHistories: [{ created: 1790104838736, items: [{ field: "status" }] }] },
        ],
      },
    ],
    async (calls) => {
      const issues = await fetchJira();
      // The search no longer drags every ticket's whole history along with it.
      assert.equal(new URL(calls[0].url).searchParams.has("expand"), false);
      // Only the ticket in QA is asked about, and only its status changes.
      assert.match(calls[1].url, /changelog\/bulkfetch$/);
      assert.deepEqual(JSON.parse(calls[1].init.body).issueIdsOrKeys, ["PY-2"]);
      assert.deepEqual(JSON.parse(calls[1].init.body).fieldIds, ["status"]);
      // Epoch milliseconds come back as the ISO the rest of the board reads.
      assert.equal(statusSince(issues[1].changelog), "2026-09-22T19:20:38.736Z");
      assert.equal(issues[0].changelog, undefined);
    },
  );
  // With nobody in QA there is nothing to ask.
  await withFetch([{ issues: [issue("1", "PY-1", "In Progress")] }], async (calls) => {
    await fetchJira();
    assert.equal(calls.length, 1);
  });
});

test("unreleased merged work offers the release check, and nothing does when it is empty", () => {
  assert.deepEqual(promptForShipping({ items: [{ number: 1 }] }), {
    skill: "production-release",
    prompt: "/production-release check",
  });
  assert.equal(promptForShipping({ items: [] }), null);
  assert.equal(promptForShipping(null), null);
});

test("routines carry the pod so the prompt runs as pasted", () => {
  const routines = routinePrompts("Street Sharks");
  assert.deepEqual(routines.map((routine) => routine.skill), ["standup-prep", "weekly-pod-update", "sprint-retro-brainstorm"]);
  assert.equal(routines[1].prompt, '/weekly-pod-update "Street Sharks"');
  assert.equal(routines[2].prompt, '/sprint-retro-brainstorm --pod "Street Sharks"');
});

test("the lead lane carries what its prompt is decided on", () => {
  const issue = (key, extra) => ({
    key,
    fields: { summary: key, status: { name: "To Do", statusCategory: { key: "new" } }, issuetype: { name: "Bug", subtask: false }, updated: "2026-09-01T00:00:00Z", ...extra },
  });
  const [item] = buildItems([], [], [], [issue("PY-9", { customfield_10132: { type: "doc", content: [] } })]);
  assert.equal(item.issueType, "Bug");
  assert.equal(item.groomed, true);
  assert.equal(item.action.skill, "diagnose-bug");
});


test("a reviewer who commented and was never asked again is yours to re-request", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  const reviews = [
    { state: "COMMENTED", submittedAt: "2026-10-15T20:59:27Z", author: { login: "aroffe-py", __typename: "User" } },
    // Your own replies to their threads arrive as comment-only reviews too.
    { state: "COMMENTED", submittedAt: "2026-10-15T21:05:07Z", author: { login: "greg-py", __typename: "User" } },
    { state: "APPROVED", submittedAt: "2026-10-14T00:00:00Z", author: { login: "james", __typename: "User" } },
    { state: "COMMENTED", submittedAt: "2026-10-15T00:00:00Z", author: { login: "cursor", __typename: "Bot" } },
    { state: "CHANGES_REQUESTED", submittedAt: "2026-10-13T00:00:00Z", author: { login: "paul", __typename: "User" } },
  ];
  // Paul has been asked again, so he is pending rather than past.
  const past = pastReviewers(reviews, ["paul"], "greg-py", now);
  assert.deepEqual(past.map((reviewer) => [reviewer.login, reviewer.reviewedDays]), [["aroffe-py", 0]]);

  // PY-14600 as it stood: reviewed, answered, pushed, nobody re-requested.
  const pr = categorizePr({ ...basePr, pendingReviewers: [], pastReviewers: past });
  assert.ok(pr.reasons.includes("re-request @aroffe-py · 0d"));
  assert.equal(pr.bucket, "needs_you");
  assert.equal(pr.defect, false);
  // Anyone still requested is the one being waited on.
  assert.ok(categorizePr({ ...basePr, pastReviewers: past }).reasons.includes("awaiting @alice · 1d"));
  // A draft is still nobody's move.
  assert.equal(categorizePr({ ...basePr, isDraft: true, pendingReviewers: [], pastReviewers: past }).bucket, "waiting");
});

test("a stack can start on someone else's open pull request", () => {
  const outside = { number: 760, url: "https://github.com/org/app/pull/760", author: "JustinCoker991" };
  const [mine, above] = withStacks([
    stackPr(775, "release-cli", "release-tools-mcp", { baseOpenPr: outside }),
    stackPr(776, "release-cli-2", "release-cli"),
  ]);
  assert.equal(mine.stack.blockedBy, 760);
  assert.equal(above.stack.blockedBy, 760);
  assert.equal(above.stack.depth, 2);
  const blocked = categorizePr(mine);
  assert.equal(blocked.reasons[0], "blocked · behind @JustinCoker991 #760");
  // Approved and green, but it targets someone else's branch.
  assert.equal(blocked.reasons.some((reason) => reason.includes("ready to merge")), false);
  assert.equal(blocked.bucket, "waiting");
  // A change alone on someone else's pull request has no stack of yours to cascade.
  assert.equal(promptForPr({ ...mine, ci: "failure" }).prompt, "/fix-ci 775 --repo org/app");
  assert.equal(promptForPr({ ...above, ci: "failure" }).prompt, "/fix-ci 776 --stack --repo org/app");
  // A non-default base with no open pull request behind it is still unstacked.
  assert.equal(withStacks([stackPr(2, "b", "gone", { baseOpenPr: null })])[0].stack.blockedBy, null);
});

test("a stacked change that landed under its own number is judged by that number", () => {
  const merged = (number, head, base) => ({
    number, title: `PY-${number} x`, url: `u${number}`, repo: "o/app",
    mergedAt: "2026-10-15T16:26:00Z", headRefName: head, baseRefName: base, baseIsDefault: base === "master",
  });
  const release = (numbers) => new Map([["o/app", { tag: "v1", ahead: 1, truncated: false, numbers: new Set(numbers) }]]);
  // Merged bottom-up: the parent went out in the last release, the child landed
  // on master afterwards as its own squash commit.
  const stack = [merged(7574, "phase-1", "master"), merged(7575, "phase-2", "phase-1")];
  assert.deepEqual(buildShipping(stack, release([7575])).items.map((item) => item.number), [7575]);
  // With its parent outside the lookback window, its own number still settles it.
  assert.equal(buildShipping([merged(7575, "phase-2", "phase-1")], release([7575])).items.length, 1);
});

test("a repo that deploys every merge has nothing waiting on a release", () => {
  const logan = { number: 758, title: "PY-14306 x", url: "u", repo: "PerformYard/Logan", mergedAt: "2026-10-12T00:00:00Z", headRefName: "a", baseIsDefault: true };
  assert.ok(CONFIG.deployOnMergeRepos.includes("PerformYard/Logan"));
  const shipping = buildShipping([logan], new Map([["PerformYard/Logan", { none: true }]]));
  assert.deepEqual(shipping.items, []);
  assert.equal(shipping.note, null, "deploy-on-merge is not a repo the board cannot see");
  // The caveat reaches the reader even when there are no rows to hang it under.
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.ok(ui.includes("if (shippingNote && (visibleShipping.length > 0 || !data.shipping?.error))"));
});

test("stuck CI is timed from the pending check, not from when the commit was written", () => {
  const now = Date.parse("2026-10-16T12:00:00Z");
  const checks = [
    { name: "Unit Tests", status: "IN_PROGRESS", startedAt: "2026-10-16T11:30:00Z", checkSuite: { createdAt: "2026-10-16T11:29:00Z" } },
    { name: "Lint", conclusion: "SUCCESS", startedAt: "2026-10-16T11:29:30Z" },
    // Re-run on a review: the newest run is what counts, and the gate is noise.
    { name: "QA Code Review", status: "QUEUED", checkSuite: { createdAt: "2026-10-10T00:00:00Z" } },
  ];
  assert.equal(ciPendingSince(checks), "2026-10-16T11:30:00Z");
  // Written days ago, pushed half an hour ago: running, not stuck.
  const pr = { ci: "pending", ciPendingSince: ciPendingSince(checks), pushedAt: "2026-10-16T11:29:00Z" };
  assert.equal(ciStuckHours(pr, now), 0);
  assert.equal(ciStuckHours({ ...pr, ciPendingSince: "2026-10-16T08:00:00Z" }, now), 4);
  // A queued check with no start falls back to when its suite was created.
  assert.equal(ciPendingSince([{ name: "Build", status: "QUEUED", checkSuite: { createdAt: "2026-10-16T07:00:00Z" } }]), "2026-10-16T07:00:00Z");
  // With no check saying, the push is the clock.
  assert.equal(ciStuckHours({ ci: "pending", ciPendingSince: null, pushedAt: "2026-10-16T09:00:00Z" }, now), 3);
});

test("a bot finding on code that has since changed goes stale like anyone's", () => {
  const bot = { login: "cursor", isBot: true, body: "Possible null deref", createdAt: "2026-10-01T00:00:00Z" };
  assert.equal(threadState({ isResolved: false, isOutdated: true, firstComment: bot, lastComment: bot }, "greg-py"), "stale");
  assert.equal(threadState({ isResolved: false, isOutdated: false, firstComment: bot, lastComment: bot }, "greg-py"), "bot");
});

test("a review request is timed from when you were asked", () => {
  const events = [
    { createdAt: "2026-10-01T00:00:00Z", requestedReviewer: { __typename: "User", login: "greg-py" } },
    { createdAt: "2026-10-14T00:00:00Z", requestedReviewer: { __typename: "User", login: "greg-py" } },
    { createdAt: "2026-10-15T00:00:00Z", requestedReviewer: { __typename: "User", login: "someone" } },
  ];
  assert.equal(requestedOfViewerAt(events, "greg-py"), "2026-10-14T00:00:00Z");
  // Asked through a team: the team's request is the clock.
  const team = [{ createdAt: "2026-10-12T00:00:00Z", requestedReviewer: { __typename: "Team", name: "frontend" } }];
  assert.equal(requestedOfViewerAt(team, "greg-py"), "2026-10-12T00:00:00Z");
  assert.equal(requestedOfViewerAt([], "greg-py"), null);
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.ok(ui.includes("const waited = pr.askedDays ?? pr.ageDays;"));
});

test("the fetched pull request carries push time, readiness, past reviewers and an honest gate", () => {
  const now = Date.parse("2026-10-16T00:00:00Z");
  const node = (extra = {}) => ({
    number: 7785,
    title: "PY-14600 Meetings Responsiveness",
    url: "u",
    isDraft: false,
    author: { login: "greg-py" },
    baseRefName: "release-tools-mcp",
    repository: { nameWithOwner: "PerformYard/PerformYard", defaultBranchRef: { name: "master" } },
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
    latestReviews: { nodes: [{ state: "COMMENTED", submittedAt: "2026-10-15T20:59:27Z", author: { login: "aroffe-py", __typename: "User" } }] },
    reviewRequests: { nodes: [] },
    timelineItems: { nodes: [{ __typename: "ReadyForReviewEvent", createdAt: "2026-10-15T18:24:14Z" }] },
    baseRef: { associatedPullRequests: { nodes: [{ number: 760, url: "u760", author: { login: "JustinCoker991" } }] } },
    commits: { nodes: [{ commit: {
      // Written two weeks before it was pushed.
      committedDate: "2026-10-01T00:00:00Z",
      checkSuites: { nodes: [{ createdAt: "2026-10-15T21:05:30Z" }, { createdAt: "2026-10-15T21:05:20Z" }] },
      statusCheckRollup: { contexts: { nodes: [{ name: "QA Code Review", conclusion: "SUCCESS" }] } },
    } }] },
    ...extra,
  });
  const pr = mapReviewPr(node(), now, "greg-py");
  assert.equal(pr.pushedAt, "2026-10-15T21:05:20Z");
  assert.equal(pr.pushedDaysAgo, 0);
  assert.equal(pr.readyDays, 0);
  assert.equal(pr.ageDays, 15);
  assert.deepEqual(pr.pastReviewers.map((reviewer) => reviewer.login), ["aroffe-py"]);
  assert.deepEqual(pr.baseOpenPr, { number: 760, url: "u760", author: "JustinCoker991" });
  assert.equal(pr.qaGate, "passed");
  // The enforcer passes every draft unread, so a draft has no gate verdict.
  assert.equal(mapReviewPr(node({ isDraft: true }), now).qaGate, null);
});

test("the config names only statuses and markers this workflow actually uses", () => {
  for (const status of [...CONFIG.waitingStatuses, ...CONFIG.statusOrder]) {
    assert.notEqual(status, "blocked", "PY has no Blocked status");
  }
  assert.equal("holdLabels" in CONFIG, false);
  assert.ok(CONFIG.waitingStatuses.includes("in design review"));
});

test("a hidden row comes back when its state changes", () => {
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  // Hidden rows remember the state they were hidden in, and a bare list stored
  // before that adopts whatever state it is next seen in.
  assert.ok(ui.includes("const hidden = new Map();"));
  assert.ok(ui.includes("if (was === state) return true;"));
  assert.ok(ui.includes("hidden.delete(id);"));
  assert.ok(ui.includes('data-state="${esc(itemState(item))}"'));
  assert.ok(ui.includes("Array.isArray(stored) ? stored.map((id) => [id, null])"));
});

test("a clean pull request's skill follows where its ticket stands", () => {
  const approved = { ...basePr, reviewDecision: "APPROVED" };
  const actionAt = (status, pr = approved) => {
    const [item] = buildItems(
      [jiraIssue("PY-13548", { status: { name: status, statusCategory: { key: "indeterminate" } } })],
      [prFixture(pr)],
    );
    return item.prs[0].action;
  };
  // Queued for QA, being tested, or approved and ready to send: the test guide.
  for (const status of ["Ready To Test", "In Testing", "In Code Review"]) {
    assert.deepEqual(actionAt(status), { skill: "qa-guide", prompt: "/qa-guide PY-13548" }, status);
  }
  // Still waiting on its first review: a review of your own.
  assert.equal(actionAt("In Code Review", basePr).skill, "deep-review");
  assert.equal(actionAt("READY TO MERGE").skill, "deep-review");
  // A problem outranks the ticket's stage.
  assert.equal(actionAt("In Testing", { ...approved, ci: "failure" }).skill, "fix-ci");
  // An orphan pull request has no ticket to write a guide for.
  const [orphan] = buildItems([], [prFixture({ title: "No ticket", headRefName: "x", isDraft: true })]);
  assert.equal(orphan.prs[0].action.skill, "deep-review");
});
