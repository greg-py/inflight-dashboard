import test from "node:test";
import assert from "node:assert/strict";
import {
  CONFIG,
  extractTicketKeys,
  effectiveCi,
  categorizePr,
  sectionFor,
  buildItems,
  statusRank,
  mapReviewPr,
  launchForPr,
  launchForReview,
  launchForTicket,
  buildLaunchCommand,
  buildAgentInvocation,
  slugFor,
  changesAddressed,
  repoPathFor,
  qaGateState,
  worktreeStatusOf,
  sessionStatusOf,
  parseDiagnosis,
  diagnosisKeyFor,
} from "./server.js";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

test("effectiveCi ignores noisy checks", () => {
  assert.equal(
    effectiveCi([
      { name: "QA Code Review", conclusion: "FAILURE" },
      { name: "Unit Tests (1/8)", conclusion: "SUCCESS" },
    ]),
    "success",
  );
});

test("effectiveCi lets any passing rerun of a check name win", () => {
  assert.equal(
    effectiveCi([
      { name: "Integration Tests (2/3)", conclusion: "FAILURE" },
      { name: "Integration Tests (2/3)", conclusion: "SUCCESS" },
    ]),
    "success",
  );
});

test("effectiveCi reports real failures and pending runs", () => {
  assert.equal(
    effectiveCi([
      { name: "Type Check", conclusion: "FAILURE" },
      { name: "Prettier", conclusion: "SUCCESS" },
    ]),
    "failure",
  );
  assert.equal(
    effectiveCi([
      { name: "Type Check", conclusion: null, status: "IN_PROGRESS" },
      { name: "Prettier", conclusion: "SUCCESS" },
    ]),
    "pending",
  );
  assert.equal(effectiveCi([{ name: "QA Code Review", conclusion: "FAILURE" }]), "none");
  assert.equal(effectiveCi([]), "none");
});

test("effectiveCi handles commit statuses (StatusContext)", () => {
  assert.equal(effectiveCi([{ context: "deploy/staging", state: "SUCCESS" }]), "success");
  assert.equal(effectiveCi([{ context: "deploy/staging", state: "FAILURE" }]), "failure");
});

const basePr = {
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: "REVIEW_REQUIRED",
  ci: "success",
  ageDays: 2,
  openThreads: 0,
  qaGate: null,
};

test("qaGateState: passed only when every gate run is green", () => {
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

test("categorizePr: unresolved review threads need you and launch address-review", () => {
  const withThreads = categorizePr({ ...basePr, openThreads: 3 });
  assert.equal(withThreads.bucket, "needs_you");
  assert.equal(withThreads.defect, true);
  assert.ok(withThreads.reasons.includes("3 open threads"));
  assert.ok(categorizePr({ ...basePr, openThreads: 1 }).reasons.includes("1 open thread"));
  assert.equal(
    launchForPr({ ...launchPr(), openThreads: 2 }).prompt,
    "/address-review #7364 --autonomous",
  );
});

test("open threads defer to pushed changes: ball is in the reviewer's court", () => {
  const addressed = {
    ...basePr,
    reviewDecision: "CHANGES_REQUESTED",
    openThreads: 2,
    changesRequestedAt: "2026-08-28T17:52:07Z",
    lastCommitAt: "2026-08-28T18:40:44Z",
  };
  const result = categorizePr(addressed);
  assert.equal(result.bucket, "waiting");
  assert.ok(result.reasons.includes("changes pushed · awaiting re-review"));
  assert.ok(!result.reasons.some((r) => r.includes("open thread")));
  assert.equal(launchForPr({ ...launchPr(), ...addressed }), null);
});

test("categorizePr + sectionFor: a passed QA gate beats the QA hold", () => {
  const passed = categorizePr({ ...basePr, reviewDecision: "APPROVED", qaGate: "passed" });
  assert.ok(passed.reasons.includes("QA passed · ready to merge"));
  assert.equal(passed.bucket, "needs_you");
  assert.equal(
    sectionFor({ status: "In Testing", prs: [{ bucket: "needs_you", defect: false, qaGate: "passed" }] }),
    "needs_you",
  );
  assert.equal(
    sectionFor({ status: "In Testing", prs: [{ bucket: "needs_you", defect: false, qaGate: "blocked" }] }),
    "waiting",
  );
});

test("buildItems annotates PR-less tickets whose PR merged recently", () => {
  const merged = [
    {
      number: 7350,
      url: "https://github.com/PerformYard/PerformYard/pull/7350",
      title: "PY-13695 gate visibility",
      headRefName: "PY-13695-gate",
      repo: "PerformYard/PerformYard",
    },
  ];
  const items = buildItems(
    [jiraIssue("PY-13695", { status: { name: "In Testing", statusCategory: { key: "indeterminate" } } })],
    [],
    merged,
  );
  assert.deepEqual(items[0].mergedPrs, [
    { number: 7350, url: "https://github.com/PerformYard/PerformYard/pull/7350", repo: "PerformYard/PerformYard" },
  ]);
  assert.equal(items[0].section, "waiting");
  assert.equal(buildItems([jiraIssue("PY-99999")], [], merged)[0].mergedPrs, undefined);
});

test("categorizePr: changes requested, CI failure, conflicts, and draft all need you", () => {
  for (const overrides of [
    { reviewDecision: "CHANGES_REQUESTED" },
    { ci: "failure" },
    { mergeable: "CONFLICTING" },
    { isDraft: true },
  ]) {
    assert.equal(categorizePr({ ...basePr, ...overrides }).bucket, "needs_you");
  }
});

test("categorizePr: approved with settled CI is ready to merge (needs you)", () => {
  const result = categorizePr({ ...basePr, reviewDecision: "APPROVED" });
  assert.equal(result.bucket, "needs_you");
  assert.ok(result.reasons.includes("approved · ready to merge"));
});

test("categorizePr: approved but CI still running waits", () => {
  const result = categorizePr({ ...basePr, reviewDecision: "APPROVED", ci: "pending" });
  assert.equal(result.bucket, "waiting");
  assert.ok(result.reasons.includes("approved"));
});

test("categorizePr: clean PR awaiting review waits, with age", () => {
  const result = categorizePr(basePr);
  assert.equal(result.bucket, "waiting");
  assert.ok(result.reasons.includes("awaiting review · 2d"));
  assert.ok(result.reasons.includes("CI green"));
});

test("sectionFor: PR buckets win; ticket-only falls back to status", () => {
  assert.equal(
    sectionFor({ status: "In Progress", prs: [{ bucket: "needs_you", defect: true }, { bucket: "waiting" }] }),
    "needs_you",
  );
  assert.equal(sectionFor({ status: "In Progress", prs: [{ bucket: "waiting" }] }), "waiting");
  assert.equal(sectionFor({ prs: [], status: "In Testing" }), "waiting");
  assert.equal(sectionFor({ prs: [], status: "Ready To Test" }), "waiting");
  assert.equal(sectionFor({ prs: [], status: "TO DO" }), "no_pr");
  assert.equal(sectionFor({ prs: [], status: "READY" }), "no_pr");
});

test("sectionFor: QA-held tickets treat approved-ready-to-merge as waiting, defects as yours", () => {
  const merge = { bucket: "needs_you", defect: false };
  const defect = { bucket: "needs_you", defect: true };
  assert.equal(sectionFor({ status: "In Testing", prs: [merge] }), "waiting");
  assert.equal(sectionFor({ status: "Ready To Test", prs: [merge] }), "waiting");
  assert.equal(sectionFor({ status: "In Testing", prs: [defect] }), "needs_you");
  assert.equal(sectionFor({ status: "READY TO MERGE", prs: [merge] }), "needs_you");
  assert.equal(sectionFor({ status: "In Code Review", prs: [merge] }), "needs_you");
});

test("categorizePr marks defect only for real problems, not merge-readiness", () => {
  assert.equal(categorizePr({ ...basePr, reviewDecision: "APPROVED" }).defect, false);
  assert.equal(categorizePr({ ...basePr, ci: "failure" }).defect, true);
});

const crPr = (lastCommitAt, changesRequestedAt) => ({
  ...basePr,
  number: 7364,
  repo: "PerformYard/PerformYard",
  reviewDecision: "CHANGES_REQUESTED",
  lastCommitAt,
  changesRequestedAt,
});

test("changesAddressed: pushed after the changes-requested review flips the court", () => {
  assert.equal(changesAddressed(crPr("2026-08-25T12:00:00Z", "2026-08-24T12:00:00Z")), true);
  assert.equal(changesAddressed(crPr("2026-08-23T12:00:00Z", "2026-08-24T12:00:00Z")), false);
  assert.equal(changesAddressed(crPr(null, "2026-08-24T12:00:00Z")), false);
  assert.equal(changesAddressed(crPr("2026-08-25T12:00:00Z", null)), false);
});

test("categorizePr: changes requested with fixes pushed waits on re-review", () => {
  const addressed = categorizePr(crPr("2026-08-25T12:00:00Z", "2026-08-24T12:00:00Z"));
  assert.equal(addressed.bucket, "waiting");
  assert.equal(addressed.defect, false);
  assert.ok(addressed.reasons.includes("changes pushed · awaiting re-review"));
  const reReviewed = categorizePr(crPr("2026-08-24T12:00:00Z", "2026-08-25T12:00:00Z"));
  assert.equal(reReviewed.bucket, "needs_you");
  assert.ok(reReviewed.reasons.includes("changes requested"));
});

test("launchForPr: no address-review once fixes are pushed; conflicts still launch", () => {
  assert.equal(launchForPr(crPr("2026-08-25T12:00:00Z", "2026-08-24T12:00:00Z")), null);
  assert.equal(
    launchForPr({ ...crPr("2026-08-25T12:00:00Z", "2026-08-24T12:00:00Z"), mergeable: "CONFLICTING" })
      .label,
    "resolve conflicts",
  );
  assert.equal(launchForPr(crPr("2026-08-23T12:00:00Z", "2026-08-24T12:00:00Z")).label, "address review");
});

test("launchForReview: prior review of yours makes it a verify-review re-review", () => {
  assert.deepEqual(launchForReview({ ...launchPr(), viewerReviewState: "CHANGES_REQUESTED" }), {
    label: "re-review",
    prompt: "/verify-review #7364 --autonomous",
    repo: "PerformYard/PerformYard",
  });
  assert.equal(launchForReview({ ...launchPr(), viewerReviewState: null }).prompt, "/deep-review #7364 --autonomous");
});

test("buildItems relabels merge-readiness as move-to-QA on pre-QA tickets", () => {
  const pr = {
    number: 7392,
    title: "PY-13583 registry",
    headRefName: "PY-13583-tool-registry",
    repo: "PerformYard/PerformYard",
    updatedAt: "2026-08-25T12:00:00Z",
    bucket: "needs_you",
    defect: false,
    reasons: ["approved · ready to merge", "CI green"],
  };
  const items = buildItems(
    [jiraIssue("PY-13583", { status: { name: "In Code Review", statusCategory: { key: "indeterminate" } } })],
    [pr],
  );
  assert.equal(items[0].section, "needs_you");
  assert.deepEqual(items[0].prs[0].reasons, ["approved · move to QA", "CI green"]);
});

test("buildItems relabels merge-readiness as awaiting QA on QA-held tickets", () => {
  const pr = {
    number: 7351,
    title: "PY-13940 punchlist",
    headRefName: "PY-13940-punchlist",
    repo: "PerformYard/PerformYard",
    updatedAt: "2026-08-25T12:00:00Z",
    bucket: "needs_you",
    defect: false,
    reasons: ["approved · ready to merge", "CI green"],
  };
  const items = buildItems(
    [jiraIssue("PY-13940", { status: { name: "In Testing", statusCategory: { key: "indeterminate" } } })],
    [pr],
  );
  assert.equal(items[0].section, "waiting");
  assert.deepEqual(items[0].prs[0].reasons, ["approved · awaiting QA", "CI green"]);
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

test("buildItems joins PRs to tickets by extracted key", () => {
  const pr = {
    number: 7364,
    title: "PY-13548: calendar integration",
    headRefName: "PY-13548-calendar",
    updatedAt: "2026-08-25T12:00:00Z",
    bucket: "waiting",
    reasons: ["awaiting review · 1d"],
  };
  const items = buildItems([jiraIssue("PY-13548")], [pr]);
  assert.equal(items.length, 1);
  assert.equal(items[0].prs.length, 1);
  assert.equal(items[0].section, "waiting");
});

test("buildItems surfaces orphan PRs as their own items", () => {
  const pr = {
    number: 703,
    title: "Koala machine API",
    headRefName: "koala/machine-api",
    isDraft: true,
    updatedAt: "2026-08-25T12:00:00Z",
    bucket: "needs_you",
  };
  const items = buildItems([], [pr]);
  assert.equal(items.length, 1);
  assert.equal(items[0].key, null);
  assert.equal(items[0].section, "needs_you");
  assert.equal(items[0].status, "Draft PR");
});

test("buildItems assigns stable ids: ticket key, or repo#number for orphan PRs", () => {
  const orphan = {
    number: 703,
    repo: "PerformYard/Logan",
    title: "Koala machine API",
    headRefName: "koala/machine-api",
    isDraft: true,
    updatedAt: "2026-08-25T12:00:00Z",
    bucket: "needs_you",
  };
  const items = buildItems([jiraIssue("PY-13548")], [orphan]);
  assert.deepEqual(items.map((item) => item.id).sort(), ["PY-13548", "PerformYard/Logan#703"].sort());
});

test("statusRank follows the pipeline order, case-insensitively, unknowns last", () => {
  const ordered = ["Draft PR", "Open PR", "TO DO", "READY", "In Progress", "In Code Review", "Ready To Test", "In Testing", "READY TO MERGE"];
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(statusRank(ordered[i - 1]) < statusRank(ordered[i]), `${ordered[i - 1]} < ${ordered[i]}`);
  }
  assert.ok(statusRank("Some New Status") > statusRank("READY TO MERGE"));
});

test("buildItems sorts by status progression, then newest updated", () => {
  const status = (name) => ({ name, statusCategory: { key: "indeterminate" } });
  const items = buildItems(
    [
      jiraIssue("PY-3", { status: status("In Testing"), updated: "2026-08-25T10:00:00.000+0000" }),
      jiraIssue("PY-1", { status: status("In Code Review"), updated: "2026-08-20T10:00:00.000+0000" }),
      jiraIssue("PY-2", { status: status("In Code Review"), updated: "2026-08-24T10:00:00.000+0000" }),
      jiraIssue("PY-4", { status: status("Ready To Test"), updated: "2026-08-26T10:00:00.000+0000" }),
    ],
    [],
  );
  assert.deepEqual(
    items.map((item) => item.key),
    ["PY-2", "PY-1", "PY-4", "PY-3"],
  );
});

const launchPr = (overrides = {}) => ({
  number: 7364,
  repo: "PerformYard/PerformYard",
  reviewDecision: "REVIEW_REQUIRED",
  mergeable: "MERGEABLE",
  ci: "success",
  ...overrides,
});

test("launchForPr maps PR state to the right skill prompt, in priority order", () => {
  assert.deepEqual(launchForPr(launchPr({ reviewDecision: "CHANGES_REQUESTED" })), {
    label: "address review",
    prompt: "/address-review #7364 --autonomous",
    repo: "PerformYard/PerformYard",
  });
  assert.equal(
    launchForPr(launchPr({ reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" })).label,
    "address review",
  );
  assert.equal(launchForPr(launchPr({ mergeable: "CONFLICTING", ci: "failure" })).label, "resolve conflicts");
  assert.ok(
    launchForPr(launchPr({ ci: "failure" })).prompt.startsWith(
      "Investigate and fix the failing CI checks on PR #7364.",
    ),
  );
  assert.ok(launchForPr(launchPr({ ci: "failure" })).prompt.includes("Work autonomously"));
});

test("autonomous flag is omitted when autonomousLaunches is off", () => {
  CONFIG.autonomousLaunches = false;
  try {
    assert.equal(
      launchForPr(launchPr({ reviewDecision: "CHANGES_REQUESTED" })).prompt,
      "/address-review #7364",
    );
    assert.equal(
      launchForPr(launchPr({ ci: "failure" })).prompt,
      "Investigate and fix the failing CI checks on PR #7364.",
    );
  } finally {
    CONFIG.autonomousLaunches = true;
  }
});

test("sessionStatusOf passes a staged approval through, sanitized", () => {
  const dir = mkdtempSync(join(tmpdir(), "inflight-ap-"));
  try {
    writeFileSync(
      join(dir, ".agent-status.json"),
      JSON.stringify({
        state: "awaiting-approval",
        detail: "review staged",
        approval: { label: "submit review (2 findings)", detail: "posts the verified review" },
      }),
    );
    assert.deepEqual(sessionStatusOf(dir), {
      state: "awaiting-approval",
      detail: "review staged",
      approval: { label: "submit review (2 findings)", detail: "posts the verified review" },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("launchForPr returns null when no agent action applies", () => {
  assert.equal(launchForPr(launchPr()), null);
  assert.equal(launchForPr(launchPr({ reviewDecision: "APPROVED" })), null);
  assert.equal(launchForPr(launchPr({ number: "7364; rm -rf /" })), null);
});

test("launchForReview and launchForTicket build their prompts", () => {
  assert.equal(launchForReview(launchPr()).prompt, "/deep-review #7364 --autonomous");
  assert.deepEqual(launchForTicket({ key: "PY-13548", prs: [] }), {
    label: "implement",
    prompt: "/implement-ticket PY-13548 --autonomous",
    repo: null,
  });
  assert.equal(launchForTicket({ key: "PY-13548", prs: [{ number: 1 }] }), null);
  assert.equal(launchForTicket({ key: null, prs: [] }), null);
  assert.equal(launchForTicket({ key: "PY-1 && evil", prs: [] }), null);
});

test("buildLaunchCommand fetches, adds a detached worktree, and starts the agent there", () => {
  assert.equal(
    buildLaunchCommand({
      repoPath: "/Users/gking/Projects/PerformYard",
      worktreePath: "/Users/gking/.cache/inflight-worktrees/PerformYard/resolve-conflicts-7287-x1",
      branch: "master",
      invocation: "claude '/resolve-conflicts #7287'",
    }),
    "cd '/Users/gking/Projects/PerformYard' && git fetch origin && " +
      "git worktree add --detach '/Users/gking/.cache/inflight-worktrees/PerformYard/resolve-conflicts-7287-x1' 'origin/master' && " +
      "cd '/Users/gking/.cache/inflight-worktrees/PerformYard/resolve-conflicts-7287-x1' && " +
      "claude '/resolve-conflicts #7287'",
  );
});

test("buildAgentInvocation applies model and effort overrides per CLI, quoting prompts", () => {
  assert.equal(buildAgentInvocation("claude", {}, "/deep-review #7388"), "claude '/deep-review #7388'");
  assert.equal(
    buildAgentInvocation("claude", { model: "opus[1m]", effort: "high" }, "/address-review #7364"),
    "claude --model 'opus[1m]' --effort 'high' '/address-review #7364'",
  );
  assert.equal(
    buildAgentInvocation("codex", { model: "gpt-5.6-sol", effort: "xhigh" }, "it's here"),
    `codex -m 'gpt-5.6-sol' -c 'model_reasoning_effort="xhigh"' 'it'\\''s here'`,
  );
  assert.equal(buildAgentInvocation("codex", { effort: "low" }, "/deep-review #7388"),
    `codex -c 'model_reasoning_effort="low"' '/deep-review #7388'`,
  );
});

test("repoPathFor maps known repos under reposDir and falls back to the default repo", () => {
  assert.ok(repoPathFor("PerformYard/Logan").endsWith("/Logan"));
  assert.ok(repoPathFor("PerformYard/QA").endsWith("/QA"));
  assert.ok(repoPathFor(null).endsWith("/PerformYard"));
  assert.ok(repoPathFor("evil/other").endsWith("/PerformYard"));
});

test("slugFor sanitizes prompts to shell-safe worktree names", () => {
  assert.equal(slugFor("/resolve-conflicts #7287"), "resolve-conflicts-7287");
  assert.equal(slugFor("/implement-ticket PY-13548"), "implement-ticket-py-13548");
  assert.equal(slugFor("Investigate and fix the failing CI checks on PR #7411."), "investigate-and-fix-the-failing-ci-checks-on-pr-7411");
});

test("worktreeStatusOf: gone, dirty, unpushed, clean — and ignores the status file", () => {
  assert.deepEqual(worktreeStatusOf("/nonexistent/inflight-test-path"), { state: "gone" });
  const dir = mkdtempSync(join(tmpdir(), "inflight-wt-"));
  try {
    const git = (args) => execSync(`git ${args}`, { cwd: dir, encoding: "utf8" });
    git("init -q");
    git('-c user.email=t@t -c user.name=t commit --allow-empty -m init -q');
    assert.deepEqual(worktreeStatusOf(dir), { state: "unpushed", unpushed: 1 });
    writeFileSync(join(dir, "scratch.txt"), "x");
    assert.deepEqual(worktreeStatusOf(dir), { state: "dirty" });
    rmSync(join(dir, "scratch.txt"));
    git("remote add origin .");
    git("fetch -q origin");
    assert.deepEqual(worktreeStatusOf(dir), { state: "clean" });
    writeFileSync(join(dir, ".agent-status.json"), '{"state":"working","detail":"x"}');
    assert.deepEqual(worktreeStatusOf(dir), { state: "clean" }, "status file never counts as dirt");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionStatusOf reads and sanitizes the session status file", () => {
  const dir = mkdtempSync(join(tmpdir(), "inflight-ss-"));
  try {
    assert.equal(sessionStatusOf(dir), null);
    writeFileSync(
      join(dir, ".agent-status.json"),
      '{"state":"awaiting-approval","detail":"plan ready for PY-1"}',
    );
    assert.deepEqual(sessionStatusOf(dir), {
      state: "awaiting-approval",
      detail: "plan ready for PY-1",
    });
    writeFileSync(join(dir, ".agent-status.json"), '{"state":"exploded","detail":"?"}');
    assert.equal(sessionStatusOf(dir).state, "working", "unknown states fall back to working");
    writeFileSync(join(dir, ".agent-status.json"), '{"state":"complete","detail":"pushed"}');
    assert.equal(sessionStatusOf(dir).state, "done", "complete aliases to done");
    writeFileSync(join(dir, ".agent-status.json"), '{"state":"working","detail":"x"}');
    const old = new Date(Date.now() - 3 * 60 * 60 * 1000);
    utimesSync(join(dir, ".agent-status.json"), old, old);
    assert.equal(sessionStatusOf(dir).stale, true, "old working sessions read stale");
    writeFileSync(join(dir, ".agent-status.json"), "not json");
    assert.equal(sessionStatusOf(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseDiagnosis accepts only the contract line, from the end of output", () => {
  assert.deepEqual(parseDiagnosis("thinking...\nFLAKE: timezone shards near UTC boundary"), {
    kind: "flake",
    detail: "timezone shards near UTC boundary",
  });
  assert.deepEqual(parseDiagnosis("REAL: type error in updateSeries"), {
    kind: "real",
    detail: "type error in updateSeries",
  });
  assert.deepEqual(parseDiagnosis("WANTS: rename the flag and add a test"), {
    kind: "digest",
    detail: "rename the flag and add a test",
  });
  assert.equal(parseDiagnosis("I could not determine the cause."), null);
  assert.equal(parseDiagnosis(""), null);
});

test("diagnosisKeyFor keys on commit for CI, review timestamp for feedback, else null", () => {
  const pr = {
    repo: "PerformYard/PerformYard",
    number: 7372,
    ci: "failure",
    lastCommitAt: "2026-08-20T10:00:00Z",
    reviewDecision: "REVIEW_REQUIRED",
    changesRequestedAt: null,
  };
  assert.equal(diagnosisKeyFor(pr), "ci:PerformYard/PerformYard#7372:2026-08-20T10:00:00Z");
  assert.equal(
    diagnosisKeyFor({
      ...pr,
      ci: "success",
      reviewDecision: "CHANGES_REQUESTED",
      changesRequestedAt: "2026-08-21T10:00:00Z",
    }),
    "review:PerformYard/PerformYard#7372:2026-08-21T10:00:00Z",
  );
  assert.equal(
    diagnosisKeyFor({
      ...pr,
      ci: "success",
      reviewDecision: "CHANGES_REQUESTED",
      changesRequestedAt: "2026-08-21T10:00:00Z",
      lastCommitAt: "2026-08-22T10:00:00Z",
    }),
    null,
    "addressed feedback needs no digest",
  );
  assert.equal(diagnosisKeyFor({ ...pr, ci: "success" }), null);
});

test("mapReviewPr builds a review item with id, author, ci, and age", () => {
  const node = {
    number: 7400,
    title: "PY-14000 Some feature",
    url: "https://github.com/PerformYard/PerformYard/pull/7400",
    isDraft: false,
    author: { login: "marcus-withers" },
    repository: { nameWithOwner: "PerformYard/PerformYard" },
    createdAt: "2026-08-20T00:00:00Z",
    updatedAt: "2026-08-25T00:00:00Z",
    reviewThreads: {
      nodes: [
        { isResolved: false, comments: { nodes: [{ author: { login: "greg-py" } }] } },
        { isResolved: false, comments: { nodes: [{ author: { login: "marcus-withers" } }] } },
        { isResolved: true, comments: { nodes: [{ author: { login: "greg-py" } }] } },
      ],
    },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: {
              contexts: {
                nodes: [
                  { name: "QA Code Review", conclusion: "FAILURE" },
                  { name: "Unit Tests (1/8)", conclusion: "SUCCESS" },
                ],
              },
            },
          },
        },
      ],
    },
  };
  const pr = mapReviewPr(node, Date.parse("2026-08-26T00:00:00Z"));
  assert.equal(pr.id, "PerformYard/PerformYard#7400");
  assert.equal(pr.author, "marcus-withers");
  assert.equal(pr.ci, "success");
  assert.equal(pr.qaGate, "blocked");
  assert.equal(pr.ageDays, 6);
  assert.equal(pr.ticketKey, "PY-14000");
  assert.equal(pr.ticketUrl, "https://performyard.atlassian.net/browse/PY-14000");
  assert.equal(pr.openThreads, 1, "counts only unresolved threads where the author isn't last");
  assert.equal(
    mapReviewPr({ ...node, reviewDecision: "APPROVED" }, Date.parse("2026-08-26T00:00:00Z"))
      .openThreads,
    0,
    "approval supersedes stale threads",
  );
});

test("mapReviewPr falls back to unknown when the author is missing", () => {
  const node = {
    number: 1,
    title: "t",
    url: "u",
    isDraft: false,
    author: null,
    repository: { nameWithOwner: "PerformYard/Logan" },
    createdAt: "2026-08-26T00:00:00Z",
    updatedAt: "2026-08-26T00:00:00Z",
    commits: { nodes: [] },
  };
  assert.equal(mapReviewPr(node, Date.parse("2026-08-26T00:00:00Z")).author, "unknown");
});

test("buildItems references parent PRs on riding subtasks without attaching them", () => {
  const parentPr = {
    number: 7364,
    url: "https://github.com/PerformYard/PerformYard/pull/7364",
    title: "PY-13548: calendar integration",
    headRefName: "PY-13548-calendar",
    repo: "PerformYard/PerformYard",
    updatedAt: "2026-08-25T12:00:00Z",
    bucket: "waiting",
    defect: false,
    reasons: ["awaiting review · 1d"],
  };
  const subtask = jiraIssue("PY-14156", {
    issuetype: { subtask: true },
    parent: { key: "PY-13548" },
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
  });
  const items = buildItems([jiraIssue("PY-13548"), subtask], [parentPr]);
  const sub = items.find((item) => item.key === "PY-14156");
  assert.equal(sub.prs.length, 0);
  assert.deepEqual(sub.parentPrs, [
    { number: 7364, url: "https://github.com/PerformYard/PerformYard/pull/7364", repo: "PerformYard/PerformYard" },
  ]);
  assert.equal(sub.section, "no_pr");
  assert.equal(sub.launch.prompt, "/implement-ticket PY-14156 --autonomous");
  assert.equal(sub.launch.repo, "PerformYard/PerformYard");
  const parent = items.find((item) => item.key === "PY-13548");
  assert.equal(parent.prs.length, 1);
  assert.equal(parent.parentPrs, undefined);
});

test("buildItems: no parent-PR reference when the subtask has its own PR or parent has none", () => {
  const ownPr = {
    number: 7500,
    url: "u",
    title: "PY-14156 own PR",
    headRefName: "PY-14156-own",
    repo: "PerformYard/PerformYard",
    updatedAt: "2026-08-25T12:00:00Z",
    bucket: "waiting",
    defect: false,
    reasons: ["awaiting review · 0d"],
  };
  const subtask = () =>
    jiraIssue("PY-14156", { issuetype: { subtask: true }, parent: { key: "PY-13548" } });
  assert.equal(buildItems([subtask()], [ownPr])[0].parentPrs, undefined);
  assert.equal(buildItems([subtask()], [])[0].parentPrs, undefined);
});

test("buildItems keeps subtask parent annotation", () => {
  const items = buildItems(
    [
      jiraIssue("PY-14157", {
        issuetype: { subtask: true },
        parent: { key: "PY-13548" },
        status: { name: "TO DO", statusCategory: { key: "new" } },
      }),
    ],
    [],
  );
  assert.equal(items[0].isSubtask, true);
  assert.equal(items[0].parentKey, "PY-13548");
  assert.equal(items[0].section, "no_pr");
});
