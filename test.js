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
} from "./lib/model.js";
import { mapReviewPr, failureReason } from "./lib/integrations.js";
import { CONFIG } from "./lib/config.js";
import {
  windowLabel,
  normalizeClaudeUsage,
  normalizeCodexRateLimits,
  codexReachedNote,
} from "./lib/ai-usage.js";

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

test("qaGateState passes only when every gate run is green", () => {
  assert.equal(qaGateState([{ name: "QA Code Review", conclusion: "SUCCESS" }]), "passed");
  assert.equal(
    qaGateState([
      { name: "QA Code Review", conclusion: "FAILURE" },
      { name: "QA Code Review", conclusion: "SUCCESS" },
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
  lastCommitAt: "2026-08-20T10:00:00Z",
  changesRequestedAt: null,
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
  // basePr has nobody requested, which is its own signal.
  assert.ok(categorizePr(basePr).reasons.includes("no reviewer requested · 2d"));
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
    lastCommitAt: "2026-09-10T20:00:00Z",
    lastCommitDaysAgo: 1,
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
    lastCommitDaysAgo: 1,
    // alice was requested 6 days ago, but the fix landed 1 day ago — the wait
    // that matters started with the push.
    pendingReviewers: [{ login: "alice", waitingDays: 6 }, { login: "bob", waitingDays: 2 }],
  };
  assert.equal(reReviewReason(pr), "re-review @alice +1 · 1d");
  assert.equal(
    reReviewReason({ lastCommitDaysAgo: 3, pendingReviewers: [] }),
    "changes pushed · awaiting re-review · 3d",
  );
  assert.equal(
    reReviewReason({ lastCommitDaysAgo: null, pendingReviewers: [] }),
    "changes pushed · awaiting re-review",
  );
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
    lastCommitAt: "2026-08-28T18:40:44Z",
  };
  assert.equal(changesAddressed(addressed), true);
  const result = categorizePr(addressed);
  assert.equal(result.bucket, "waiting");
  assert.ok(result.reasons.includes("changes pushed · awaiting re-review"));
  assert.ok(!result.reasons.some((reason) => reason.includes("open thread")));
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
  assert.equal(
    sectionFor({ status: "In Progress", prs: [{ bucket: "needs_you", defect: true }] }),
    "needs_you",
  );
  const merge = { bucket: "needs_you", defect: false };
  assert.equal(sectionFor({ status: "In Testing", prs: [merge] }), "waiting");
  assert.equal(sectionFor({ status: "In Testing", prs: [{ ...merge, qaGate: "passed" }] }), "needs_you");
  assert.equal(sectionFor({ status: "READY TO MERGE", prs: [merge] }), "needs_you");
  assert.equal(sectionFor({ prs: [], status: "In Testing" }), "waiting");
  assert.equal(sectionFor({ prs: [], status: "TO DO" }), "no_pr");
});

test("statusRank follows the delivery pipeline", () => {
  // Closest to shipping first, so the work that is one action from done sits
  // at the top of its section.
  const ordered = [
    "READY TO MERGE",
    "Blocked",
    "In Testing",
    "Ready To Test",
    "In Code Review",
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
  bucket: "waiting",
  defect: false,
  reasons: ["awaiting review · 2d"],
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
    [prFixture({ bucket: "needs_you", reasons: ["approved · ready to merge", "CI green"] })],
  );
  assert.equal(held[0].section, "waiting");
  assert.deepEqual(held[0].prs[0].reasons, ["approved · awaiting QA", "CI green"]);

  // Once QA has actually started, the work is not still queued for it.
  const inQa = buildItems(
    [jiraIssue("PY-13549", { status: { name: "In Testing", statusCategory: { key: "indeterminate" } } })],
    [prFixture({ headRefName: "PY-13549-x", bucket: "needs_you", reasons: ["approved · ready to merge", "CI green"] })],
  );
  assert.deepEqual(inQa[0].prs[0].reasons, ["approved · in QA", "CI green"]);
});

test("work whose every PR is still a draft sits in development, not needs-you", () => {
  const draftOnly = buildItems(
    [],
    [prFixture({ number: 700, title: "Prototype", headRefName: "proto", isDraft: true, ...categorizePr({ ...basePr, isDraft: true, ci: "failure", mergeable: "CONFLICTING" }) })],
  );
  assert.equal(draftOnly[0].section, "no_pr");
  // Even a draft carrying real problems: it is unfinished, not anyone's move.
  assert.ok(draftOnly[0].prs[0].reasons.includes("CI failing"));

  // A ready PR alongside a draft still decides the section.
  const mixed = buildItems(
    [jiraIssue("PY-14000")],
    [
      prFixture({ number: 1, headRefName: "PY-14000-a", isDraft: true, bucket: "waiting", defect: false }),
      prFixture({ number: 2, headRefName: "PY-14000-b", bucket: "needs_you", defect: true }),
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
  const aiUsage = readFileSync(new URL("./lib/ai-usage.js", import.meta.url), "utf8");
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
    assert.equal(aiUsage.includes(forbidden), false, `${forbidden} should not be probed`);
  }
  // The capacity probe shells out exactly once, to read a credential the user
  // already holds. Anything else would make this more than a read-only board.
  assert.deepEqual(aiUsage.match(/execFileAsync\(\s*"([a-z]+)"/g), ['execFileAsync(\n    "security"']);
  assert.equal(server.includes('req.method === "POST"'), false, "server should expose GET routes only");
  assert.equal(ui.includes('method: "POST"'), false, "UI should not call write endpoints");
  assert.deepEqual(Object.keys(packageJson.scripts), ["start", "test"]);
});

test("dashboard keeps work queues primary instead of rendering summary metrics", () => {
  const ui = readFileSync(new URL("./index.html", import.meta.url), "utf8");
  assert.equal(ui.includes('id="overview"'), false);
  assert.equal(ui.includes('class="metric'), false);
  for (const queue of ["needs_you", "waiting", "reviews", "no_pr", "shipping", "held"]) {
    assert.equal(ui.includes(`id="card-${queue}"`), true, `${queue} queue should remain visible`);
  }
  // Capacity is a strip above the board, never a panel that displaces it.
  assert.ok(ui.indexOf('class="instruments"') < ui.indexOf('class="board"'));
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
  // The wait clock is read off any of the three waiting label shapes.
  assert.ok(ui.includes("/^(awaiting|re-review|changes pushed)/"));
  assert.ok(ui.includes("/· (\\d+)d$/"));
  // A pull request with nobody assigned is flagged at any age.
  assert.ok(ui.includes("/^no reviewer requested/"));
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
  ]);
  assert.deepEqual([...numbers].sort((a, b) => a - b), [7502, 7508]);
});

test("buildShipping lists merged work absent from the last release", () => {
  const merged = [
    { number: 7502, title: "PY-14338 Fix reads", url: "u1", repo: "o/PerformYard", mergedAt: "2026-09-10T20:00:00Z", headRefName: "PY-14338-fix" },
    { number: 7400, title: "Already out", url: "u2", repo: "o/PerformYard", mergedAt: "2026-09-09T20:00:00Z", headRefName: "x" },
    { number: 12, title: "Logan work", url: "u3", repo: "o/Logan", mergedAt: "2026-09-11T20:00:00Z", headRefName: "y" },
  ];
  const releases = new Map([
    ["o/PerformYard", { tag: "v29.37.0", ahead: 1, truncated: false, numbers: new Set([7502]) }],
    ["o/Logan", { error: "GitHub latest 404" }],
  ]);
  const shipping = buildShipping(merged, releases);
  assert.deepEqual(shipping.items.map((item) => item.number), [7502]);
  assert.equal(shipping.items[0].tag, "v29.37.0");
  assert.equal(shipping.items[0].ticketKey, "PY-14338");
  // A repo with no release is named, never silently counted as fully shipped.
  assert.equal(shipping.note, "Logan: no release to compare");
  assert.equal(buildShipping([], new Map()).note, null);
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

test("windowLabel reads rate-limit windows the way an operator states them", () => {
  assert.equal(windowLabel(10080), "7d");
  assert.equal(windowLabel(300), "5h");
  assert.equal(windowLabel(45), "45m");
  assert.equal(windowLabel(undefined), "window");
});

test("normalizeClaudeUsage prefers the limits array and hides unused scoped windows", () => {
  const gauges = normalizeClaudeUsage({
    limits: [
      { kind: "session", percent: 31, resets_at: "2026-09-11T17:00:00Z", scope: null },
      { kind: "weekly_all", percent: 0, resets_at: "2026-09-18T08:00:00Z", scope: null },
      { kind: "weekly_scoped", percent: 0, resets_at: "2026-09-18T08:00:00Z", scope: { model: { display_name: "Fable" } } },
      { kind: "weekly_scoped", percent: 12, resets_at: "2026-09-18T08:00:00Z", scope: { model: { display_name: "Opus" } } },
    ],
  });
  assert.deepEqual(gauges.map((gauge) => gauge.label), ["5h", "7d", "7d Opus"]);
  assert.equal(gauges[0].usedPercent, 31);
});

test("normalizeClaudeUsage falls back to the legacy top-level windows", () => {
  const gauges = normalizeClaudeUsage({
    five_hour: { utilization: 31.4, resets_at: "2026-09-11T17:00:00Z" },
    seven_day: { utilization: 4, resets_at: "2026-09-18T08:00:00Z" },
    seven_day_opus: null,
  });
  assert.deepEqual(gauges, [
    { label: "5h", usedPercent: 31, resetsAt: "2026-09-11T17:00:00Z" },
    { label: "7d", usedPercent: 4, resetsAt: "2026-09-18T08:00:00Z" },
  ]);
});

test("normalizeCodexRateLimits reads the live app-server snapshot", () => {
  const now = Date.parse("2026-09-11T00:00:00Z");
  const gauges = normalizeCodexRateLimits(
    {
      primary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 1_789_444_180 },
      secondary: { usedPercent: 40, windowDurationMins: 300, resetsAt: 1_789_444_180 },
    },
    now,
  );
  assert.deepEqual(
    gauges.map((entry) => [entry.label, entry.usedPercent]),
    [["7d", 100], ["5h", 40]],
  );
});

test("normalizeCodexRateLimits drops windows that have already rolled over", () => {
  const now = Date.parse("2026-09-11T00:00:00Z");
  const gauges = normalizeCodexRateLimits(
    {
      primary: { usedPercent: 82, windowDurationMins: 10080, resetsAt: 1_789_444_180 },
      // Rolled over in 2001: whatever it says is spent no longer applies.
      secondary: { usedPercent: 99, windowDurationMins: 300, resetsAt: 1_000_000_000 },
    },
    now,
  );
  assert.deepEqual(gauges.map((entry) => entry.label), ["7d"]);
  assert.equal(normalizeCodexRateLimits({ primary: null, secondary: null }, now).length, 0);
  assert.deepEqual(normalizeCodexRateLimits(null, now), []);
});

test("codexReachedNote explains a spent limit rather than leaving 100% bare", () => {
  assert.equal(
    codexReachedNote({ rateLimitReachedType: "workspace_member_credits_depleted" }),
    "workspace member credits depleted",
  );
  assert.equal(codexReachedNote({ rateLimitReachedType: null }), null);
  assert.equal(codexReachedNote(null), null);
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
    [...stacks].map(([number, stack]) => [number, stack.depth, stack.root, stack.behind]),
    [[1, 0, 1, 2], [2, 1, 1, 0], [3, 2, 1, 0], [9, 0, 9, 0]],
  );
  // The root names what is riding on it; the links name what they wait for.
  assert.equal(stacks.get(1).blockedBy, null);
  assert.equal(stacks.get(3).blockedBy, 1);
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
  assert.equal(stacks.get(2).blockedBy, null);
  assert.equal(stacks.get(2).depth, 0);
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
  assert.ok(held.prs[0].reasons.includes("approved · ready to merge"));
  assert.equal(isHeld({ summary: "(HOLD) SCIM failing" }), true);
  assert.equal(isHeld({ summary: "Normal work", labels: ["on-hold"] }), true);
  assert.equal(isHeld({ summary: "Withholding a value", labels: ["ai"] }), false);
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
  // A clean, approved pull request has no next action of yours to offer.
  assert.equal(promptForPr(pr({ reviewDecision: "APPROVED" })), null);
  assert.equal(promptForPr({ number: null, repo: "x" }), null);
  // A draft carries its problems as signals and never becomes anyone's move,
  // so a parked prototype drifting into conflict is not offered as work.
  assert.equal(promptForPr(pr({ isDraft: true, mergeable: "CONFLICTING", ci: "failure" })), null);
  // A review someone asked for is still a review, draft or not.
  assert.equal(promptForReview({ number: 704, repo: "PerformYard/QA", isDraft: true }).skill, "deep-review");
});

test("feedback already answered by a push is not re-offered as work", () => {
  const answered = {
    number: 7486,
    repo: "PerformYard/PerformYard",
    reviewDecision: "CHANGES_REQUESTED",
    changesRequestedAt: "2026-09-10T00:00:00Z",
    lastCommitAt: "2026-09-12T00:00:00Z",
    openThreads: 0,
    botThreads: 0,
    ci: "success",
    mergeable: "MERGEABLE",
  };
  assert.equal(changesAddressed(answered), true);
  assert.equal(promptForPr(answered), null);
});

test("a failing build has no skill, so the prompt carries what one would", () => {
  const action = promptForPr({ number: 7486, repo: "PerformYard/PerformYard", openThreads: 0, botThreads: 0, ci: "failure", mergeable: "MERGEABLE" });
  assert.equal(action.skill, "fix CI");
  assert.match(action.prompt, /PR 7486 in PerformYard\/PerformYard/);
  assert.match(action.prompt, /gh run view --log-failed/);
  // The gate that waits on a person is named so it is not chased as a defect.
  assert.match(action.prompt, /QA Code Review/);
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
  // Work already underway, or merged and waiting on a release, is not waiting
  // to be implemented.
  assert.equal(promptForTicket({ key: "PY-1", prs: [{ number: 1 }] }), null);
  assert.equal(promptForTicket({ key: "PY-1", prs: [], mergedPrs: [{ number: 1 }] }), null);
  // An orphan pull request row has no ticket key to implement.
  assert.equal(promptForTicket({ key: null, prs: [] }), null);
});

test("held work offers no action, however actionable it looks", () => {
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
  assert.equal(held.section, "held");
  assert.equal(held.action, null);
  // The pull request would otherwise route to address-review on its open threads.
  assert.equal(promptForPr(pr).skill, "address-review");
  assert.equal(held.prs[0].action, null);
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
