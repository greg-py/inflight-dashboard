import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG, repoPathFor } from "./lib/config.js";
import {
  extractTicketKeys,
  effectiveCi,
  qaGateState,
  changesAddressed,
  categorizePr,
  sectionFor,
  statusRank,
  buildItems,
  launchForPr,
  launchForReview,
  launchForTicket,
  tierFor,
  routeFor,
  slugFor,
  diagnosisKeyFor,
  parseDiagnosis,
  statusDriftFor,
} from "./lib/model.js";
import { mapReviewPr } from "./lib/integrations.js";
import {
  worktreeStatusOf,
  sessionStatusOf,
  buildAgentArgs,
  renderLogLine,
} from "./lib/sessions.js";
import { decide, MAX_LAUNCHES_PER_PASS } from "./lib/policy.js";

// --- model: keys, CI, QA gate ------------------------------------------------

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

test("effectiveCi: noise filtered, rerun-any-success wins, failures and pendings surface", () => {
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

// --- model: categorization -----------------------------------------------------

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

test("categorizePr: defects need you; approved+settled promotes; QA gate beats hold", () => {
  for (const overrides of [
    { reviewDecision: "CHANGES_REQUESTED" },
    { ci: "failure" },
    { mergeable: "CONFLICTING" },
    { isDraft: true },
    { openThreads: 2 },
  ]) {
    assert.equal(categorizePr({ ...basePr, ...overrides }).bucket, "needs_you", JSON.stringify(overrides));
  }
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
  assert.ok(categorizePr(basePr).reasons.includes("awaiting review · 2d"));
});

test("codex bot threads need you, survive approval, and trigger address-review", () => {
  const withBot = categorizePr({ ...basePr, botThreads: 2 });
  assert.equal(withBot.bucket, "needs_you");
  assert.ok(withBot.reasons.includes("2 codex threads"));
  const approvedWithBot = categorizePr({ ...basePr, reviewDecision: "APPROVED", botThreads: 1 });
  assert.equal(approvedWithBot.bucket, "needs_you");
  assert.ok(approvedWithBot.reasons.includes("1 codex thread"));
  assert.equal(launchForPr({ ...basePr, botThreads: 1 }).kind, "address-review");
  const addressedHumanButBot = launchForPr({
    ...basePr,
    reviewDecision: "CHANGES_REQUESTED",
    changesRequestedAt: "2026-08-28T17:00:00Z",
    lastCommitAt: "2026-08-28T18:00:00Z",
    botThreads: 1,
  });
  assert.equal(addressedHumanButBot.kind, "address-review", "bot threads outrank changes-pushed");
});

test("changes pushed after review: ball in reviewer's court, threads deferred", () => {
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
  assert.ok(!result.reasons.some((r) => r.includes("open thread")));
  assert.equal(launchForPr(addressed), null);
});

test("sectionFor: PR buckets win, QA hold releases only for defects or passed gate", () => {
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

test("statusRank follows the pipeline order, unknowns last", () => {
  const ordered = ["Draft PR", "Open PR", "TO DO", "READY", "In Progress", "In Code Review", "Ready To Test", "In Testing", "READY TO MERGE"];
  for (let i = 1; i < ordered.length; i++) {
    assert.ok(statusRank(ordered[i - 1]) < statusRank(ordered[i]));
  }
  assert.ok(statusRank("Some New Status") > statusRank("READY TO MERGE"));
});

// --- model: launch derivation -------------------------------------------------

test("launchForPr maps state to kind/prompt/fingerprint in priority order", () => {
  const review = launchForPr({ ...basePr, reviewDecision: "CHANGES_REQUESTED" });
  assert.equal(review.kind, "address-review");
  assert.equal(review.prompt, "/address-review #7364 --autonomous");
  assert.equal(review.fingerprint, "review:PerformYard/PerformYard#7364:none:2026-08-20T10:00:00Z:0h0b");
  assert.equal(
    launchForPr({ ...basePr, reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" }).kind,
    "address-review",
  );
  const conflicts = launchForPr({ ...basePr, mergeable: "CONFLICTING", ci: "failure" });
  assert.equal(conflicts.kind, "resolve-conflicts");
  const fixci = launchForPr({ ...basePr, ci: "failure" });
  assert.equal(fixci.kind, "fix-ci");
  assert.ok(fixci.prompt.includes("Work autonomously"));
  assert.equal(launchForPr(basePr), null);
  assert.equal(launchForPr({ ...basePr, reviewDecision: "APPROVED" }), null);
  assert.equal(launchForPr({ ...basePr, number: "7364; rm -rf /" }), null);
});

test("autonomous flag omitted when autonomousLaunches is off", () => {
  CONFIG.autonomousLaunches = false;
  try {
    assert.equal(
      launchForPr({ ...basePr, reviewDecision: "CHANGES_REQUESTED" }).prompt,
      "/address-review #7364",
    );
  } finally {
    CONFIG.autonomousLaunches = true;
  }
});

test("launchForReview: verify-review on re-requests, deep-review otherwise", () => {
  assert.equal(launchForReview({ ...basePr, viewerReviewState: "CHANGES_REQUESTED" }).prompt, "/verify-review #7364 --autonomous");
  const fresh = launchForReview({ ...basePr, viewerReviewState: null });
  assert.equal(fresh.prompt, "/deep-review #7364 --autonomous");
  assert.equal(fresh.fingerprint, "prereview:PerformYard/PerformYard#7364:2026-08-20T10:00:00Z");
});

test("launchForTicket: implement for keyed no-PR tickets only", () => {
  const launch = launchForTicket({ key: "PY-13548", prs: [] });
  assert.equal(launch.prompt, "/implement-ticket PY-13548 --autonomous");
  assert.equal(launch.fingerprint, "implement:PY-13548");
  assert.equal(launchForTicket({ key: "PY-13548", prs: [{ number: 1 }] }), null);
  assert.equal(launchForTicket({ key: null, prs: [] }), null);
  assert.equal(launchForTicket({ key: "PY-1 && evil", prs: [] }), null);
});

// --- model: buildItems ---------------------------------------------------------

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
  launch: null,
  ...overrides,
});

test("buildItems: join by key, orphan PRs become rows, stable ids", () => {
  const items = buildItems([jiraIssue("PY-13548")], [prFixture()]);
  assert.equal(items.length, 1);
  assert.equal(items[0].prs.length, 1);
  const orphanItems = buildItems([], [prFixture({ title: "Koala API", headRefName: "koala/api", number: 703, isDraft: true })]);
  assert.equal(orphanItems[0].id, "PerformYard/PerformYard#703");
  assert.equal(orphanItems[0].key, null);
  assert.equal(orphanItems[0].status, "Draft PR");
});

test("buildItems: riding subtasks reference parent PRs without attaching them", () => {
  const subtask = jiraIssue("PY-14156", {
    issuetype: { subtask: true },
    parent: { key: "PY-13548" },
  });
  const items = buildItems([jiraIssue("PY-13548"), subtask], [prFixture()]);
  const sub = items.find((item) => item.key === "PY-14156");
  assert.equal(sub.prs.length, 0);
  assert.equal(sub.parentPrs.length, 1);
  assert.equal(sub.launch.prompt, "/implement-ticket PY-14156 --autonomous");
  assert.equal(sub.launch.repo, "PerformYard/PerformYard");
});

test("buildItems: merged annotation for PR-less tickets; QA-hold relabels", () => {
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
});

// --- routing -------------------------------------------------------------------

test("tierFor: deterministic difficulty from kind + signals", () => {
  assert.equal(tierFor({ kind: "implement" }, { item: { isSubtask: true } }), "standard");
  assert.equal(tierFor({ kind: "implement" }, { item: { isSubtask: false } }), "heavy");
  assert.equal(tierFor({ kind: "deep-review" }, { pr: { additions: 50, deletions: 20 } }), "light");
  assert.equal(tierFor({ kind: "deep-review" }, { pr: { additions: 500, deletions: 100 } }), "standard");
  assert.equal(tierFor({ kind: "deep-review" }, { pr: { additions: 900, deletions: 0 } }), "heavy");
  assert.equal(tierFor({ kind: "address-review" }, { pr: { additions: 100, deletions: 10 } }), "standard");
  assert.equal(tierFor({ kind: "resolve-conflicts" }, {}), "standard");
});

test("routeFor maps tiers to agent/model/effort", () => {
  assert.deepEqual(routeFor("light"), { agent: "codex", model: null, effort: "medium" });
  assert.deepEqual(routeFor("heavy"), { agent: "claude", model: "opus", effort: "xhigh" });
  assert.deepEqual(routeFor("unknown"), routeFor("standard"));
});

// --- diagnosis parsing -----------------------------------------------------------

test("parseDiagnosis and diagnosisKeyFor", () => {
  assert.deepEqual(parseDiagnosis("thinking...\nFLAKE: timezone shards"), { kind: "flake", detail: "timezone shards" });
  assert.deepEqual(parseDiagnosis("WANTS: rename the flag"), { kind: "digest", detail: "rename the flag" });
  assert.equal(parseDiagnosis("no idea"), null);
  assert.equal(diagnosisKeyFor({ ...basePr, ci: "failure" }), "ci:PerformYard/PerformYard#7364:2026-08-20T10:00:00Z");
  assert.equal(
    diagnosisKeyFor({ ...basePr, reviewDecision: "CHANGES_REQUESTED", changesRequestedAt: "2026-08-21T10:00:00Z" }),
    "review:PerformYard/PerformYard#7364:2026-08-21T10:00:00Z:2026-08-20T10:00:00Z:0h0b",
  );
  assert.equal(
    diagnosisKeyFor({ ...basePr, botThreads: 2 }),
    "review:PerformYard/PerformYard#7364:none:2026-08-20T10:00:00Z:0h2b",
    "bot threads alone earn a digest",
  );
  assert.equal(diagnosisKeyFor(basePr), null);
});

test("stuck CI: pending with an old head commit needs you", () => {
  const stuck = categorizePr({ ...basePr, ci: "pending", ciStuckHours: 5 });
  assert.equal(stuck.bucket, "needs_you");
  assert.equal(stuck.defect, true);
  assert.ok(stuck.reasons.includes("CI stuck 5h"));
  const running = categorizePr({ ...basePr, ci: "pending", ciStuckHours: 0 });
  assert.equal(running.bucket, "waiting");
  assert.ok(running.reasons.includes("CI running"));
});

test("statusDriftFor: names the transition PR reality is owed", () => {
  const openPr = { ...basePr, isDraft: false };
  assert.deepEqual(statusDriftFor({ key: "PY-1", status: "In Progress", prs: [openPr] }), {
    target: "In Code Review",
    why: "PR #7364 open",
  });
  assert.equal(statusDriftFor({ key: "PY-1", status: "In Code Review", prs: [openPr] }), null);
  assert.deepEqual(
    statusDriftFor({
      key: "PY-1",
      status: "In Code Review",
      prs: [{ ...openPr, reviewDecision: "APPROVED", ci: "success" }],
    }),
    { target: "Ready To Test", why: "PR approved · CI green" },
  );
  assert.deepEqual(
    statusDriftFor({
      key: "PY-1",
      status: "In Testing",
      prs: [{ ...openPr, reviewDecision: "APPROVED", ci: "success", qaGate: "passed" }],
    }),
    { target: "READY TO MERGE", why: "QA gate passed" },
  );
  assert.deepEqual(
    statusDriftFor({ key: "PY-1", status: "In Testing", prs: [], mergedPrs: [{ number: 7350 }] }),
    { target: "Done", why: "PR #7350 merged" },
  );
  assert.equal(statusDriftFor({ key: "PY-1", status: "To Do", prs: [{ ...openPr, isDraft: true }] }), null);
  assert.equal(statusDriftFor({ key: null, status: "To Do", prs: [openPr] }), null);
  assert.equal(
    statusDriftFor({ key: "PY-1", status: "To Do", prs: [], parentPrs: [{ number: 1 }] }),
    null,
    "riding subtasks are exempt",
  );
});

test("decide: stages transitions once per state, unstages when drift resolves", () => {
  const drifting = itemFixture({
    id: "PY-1",
    key: "PY-1",
    status: "In Progress",
    prs: [{ ...basePr, isDraft: false, launch: null }],
  });
  const ctx = ctxFixture({});
  const actions = decide({ items: [drifting], reviewRequests: [] }, ctx);
  const stage = actions.find((a) => a.type === "stage-transition");
  assert.ok(stage);
  assert.equal(stage.target, "In Code Review");
  const staged = ctxFixture({ pendingTransitions: new Map([["PY-1", { key: stage.key }]]) });
  assert.ok(!decide({ items: [drifting], reviewRequests: [] }, staged).some((a) => a.type === "stage-transition"));
  const dismissed = ctxFixture({ actedOn: new Map([[stage.key, 1]]) });
  assert.ok(!decide({ items: [drifting], reviewRequests: [] }, dismissed).some((a) => a.type === "stage-transition"));
  const resolved = itemFixture({ id: "PY-1", key: "PY-1", status: "In Code Review", prs: [{ ...basePr, launch: null }] });
  const unstage = decide(
    { items: [resolved], reviewRequests: [] },
    ctxFixture({ pendingTransitions: new Map([["PY-1", { key: stage.key }]]) }),
  );
  assert.ok(unstage.some((a) => a.type === "unstage-transition" && a.itemId === "PY-1"));
});

// --- sessions: statuses, args, log rendering -------------------------------------

test("worktreeStatusOf: gone, dirty, unpushed, clean — status/approval files ignored", () => {
  assert.deepEqual(worktreeStatusOf("/nonexistent/inflight-test-path"), { state: "gone" });
  const dir = mkdtempSync(join(tmpdir(), "inflight-wt-"));
  try {
    const git = (args) => execSync(`git ${args}`, { cwd: dir, encoding: "utf8" });
    git("init -q");
    git('-c user.email=t@t -c user.name=t commit --allow-empty -m init -q');
    assert.deepEqual(worktreeStatusOf(dir), { state: "unpushed", unpushed: 1 });
    git("remote add origin .");
    git("fetch -q origin");
    assert.deepEqual(worktreeStatusOf(dir), { state: "clean" });
    writeFileSync(join(dir, ".agent-status.json"), "{}");
    writeFileSync(join(dir, ".approval.sh"), "echo hi");
    assert.deepEqual(worktreeStatusOf(dir), { state: "clean" });
    writeFileSync(join(dir, "scratch.txt"), "x");
    assert.deepEqual(worktreeStatusOf(dir), { state: "dirty" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sessionStatusOf: sanitizes, aliases synonyms, passes approvals through", () => {
  const dir = mkdtempSync(join(tmpdir(), "inflight-ss-"));
  try {
    assert.equal(sessionStatusOf(dir), null);
    writeFileSync(
      join(dir, ".agent-status.json"),
      JSON.stringify({ state: "complete", detail: "pushed" }),
    );
    assert.equal(sessionStatusOf(dir).state, "done");
    writeFileSync(
      join(dir, ".agent-status.json"),
      JSON.stringify({
        state: "awaiting-approval",
        detail: "review staged",
        approval: { label: "submit review", detail: "posts it" },
      }),
    );
    assert.deepEqual(sessionStatusOf(dir).approval, { label: "submit review", detail: "posts it" });
    writeFileSync(join(dir, ".agent-status.json"), "not json");
    assert.equal(sessionStatusOf(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildAgentArgs: claude flags vs codex config overrides, prompt last", () => {
  const claudeArgs = buildAgentArgs("claude", { model: "opus", effort: "xhigh" }, "/deep-review #1");
  assert.equal(claudeArgs.at(-1), "/deep-review #1");
  assert.ok(claudeArgs.join(" ").includes("--model opus"));
  assert.ok(claudeArgs.join(" ").includes("--effort xhigh"));
  assert.ok(claudeArgs.join(" ").includes("bypassPermissions"));
  const codexArgs = buildAgentArgs("codex", { model: null, effort: "medium" }, "hi");
  assert.equal(codexArgs.at(-1), "hi");
  assert.ok(codexArgs.join(" ").includes('model_reasoning_effort="medium"'));
  assert.ok(!codexArgs.join(" ").includes("-m "));
});

test("renderLogLine: init captures resumeId; assistant/tool/result render; plain passes through", () => {
  const session = {};
  const init = renderLogLine('{"type":"system","subtype":"init","session_id":"abc-123","model":"opus"}', session);
  assert.equal(session.resumeId, "abc-123");
  assert.ok(init.includes("abc-123"));
  const asst = renderLogLine(
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hello" }, { type: "tool_use", name: "Bash", input: { command: "git status" } }] } }),
    session,
  );
  assert.ok(asst.includes("hello"));
  assert.ok(asst.includes("▸ Bash: git status"));
  const result = renderLogLine('{"type":"result","subtype":"success","num_turns":4,"total_cost_usd":1.25,"result":"done"}', session);
  assert.equal(session.costUsd, 1.25);
  assert.ok(result.includes("done"));
  assert.equal(renderLogLine("plain codex output", session), "plain codex output");
});

// --- policy engine ----------------------------------------------------------------

const ctxFixture = (overrides = {}) => ({
  sessions: [],
  actedOn: new Map(),
  knownItems: new Set(),
  seeded: true,
  pendingTransitions: new Map(),
  budgets: { claude: true, codex: true },
  ...overrides,
});

const itemFixture = (overrides = {}) => ({
  id: "PY-1",
  key: "PY-1",
  status: "In Code Review",
  hidden: false,
  session: null,
  section: "needs_you",
  isSubtask: false,
  prs: [],
  launch: null,
  ...overrides,
});

const actionable = (kind, overrides = {}) => ({
  ...basePr,
  launch: {
    kind,
    label: kind,
    prompt: `x`,
    repo: "PerformYard/PerformYard",
    fingerprint: `${kind}:PerformYard/PerformYard#7364:t1`,
  },
  ...overrides,
});

test("decide: unseeded pass seeds and launches nothing", () => {
  const actions = decide(
    { items: [itemFixture({ section: "no_pr", launch: { kind: "implement", fingerprint: "implement:PY-1" } })], reviewRequests: [] },
    ctxFixture({ seeded: false }),
  );
  assert.deepEqual(actions.map((a) => a.type), ["seed"]);
});

test("decide: launches sessions for actionable PRs, skips owned/hidden/acted/parked", () => {
  const items = [
    itemFixture({ id: "PY-1", prs: [actionable("address-review")] }),
    itemFixture({ id: "PY-2", prs: [actionable("resolve-conflicts", { launch: { kind: "resolve-conflicts", fingerprint: "c:2", repo: "r", label: "x", prompt: "x" } })], session: { state: "running" } }),
    itemFixture({ id: "PY-3", hidden: true, prs: [actionable("address-review", { launch: { kind: "address-review", fingerprint: "r:3", repo: "r", label: "x", prompt: "x" } })] }),
    itemFixture({ id: "PY-4", key: null, prs: [actionable("fix-ci", { isDraft: true, launch: { kind: "fix-ci", fingerprint: "f:4", repo: "r", label: "x", prompt: "x" } })] }),
  ];
  const actions = decide({ items, reviewRequests: [] }, ctxFixture());
  const starts = actions.filter((a) => a.type === "start-session");
  assert.equal(starts.length, 1);
  assert.equal(starts[0].itemId, "PY-1");
  assert.equal(starts[0].tier, "standard");
});

test("decide: fix-ci waits for diagnosis, reruns flakes, launches on real causes", () => {
  const mk = (diagnosis) =>
    itemFixture({ prs: [actionable("fix-ci", { ci: "failure", diagnosis, launch: { kind: "fix-ci", label: "fix CI", prompt: "x", repo: "PerformYard/PerformYard", fingerprint: "fixci:x" } })] });
  assert.equal(decide({ items: [mk(null)], reviewRequests: [] }, ctxFixture()).length, 0);
  const flake = decide({ items: [mk({ kind: "flake" })], reviewRequests: [] }, ctxFixture());
  assert.equal(flake[0].type, "rerun-flake");
  const real = decide({ items: [mk({ kind: "real" })], reviewRequests: [] }, ctxFixture());
  assert.equal(real[0].type, "start-session");
});

test("decide: new tickets implement once; known/merged/acted don't", () => {
  const fresh = itemFixture({ id: "PY-9", section: "no_pr", launch: { kind: "implement", label: "implement", prompt: "x", repo: null, fingerprint: "implement:PY-9" } });
  const ctx = ctxFixture();
  const actions = decide({ items: [fresh], reviewRequests: [] }, ctx);
  assert.equal(actions.filter((a) => a.type === "start-session").length, 1);
  assert.equal(actions[0].tier, "heavy");
  const known = decide({ items: [fresh], reviewRequests: [] }, ctxFixture({ knownItems: new Set(["PY-9"]) }));
  assert.equal(known.length, 0);
  const acted = decide({ items: [fresh], reviewRequests: [] }, ctxFixture({ actedOn: new Map([["implement:PY-9", 1]]) }));
  assert.equal(acted.length, 0);
  const merged = decide({ items: [{ ...fresh, mergedPrs: [{ number: 1 }] }], reviewRequests: [] }, ctxFixture());
  assert.equal(merged.filter((a) => a.type === "start-session").length, 0, "merged tickets never implement");
  assert.ok(merged.some((a) => a.type === "stage-transition" && a.target === "Done"), "merged tickets stage Done");
});

test("decide: review requests pre-launch unless draft/owned; launch cap and budgets hold", () => {
  const review = (id, overrides = {}) => ({
    id,
    hidden: false,
    session: null,
    isDraft: false,
    additions: 40,
    deletions: 5,
    launch: { kind: "deep-review", label: "review", prompt: "x", repo: "r", fingerprint: `prereview:${id}` },
    ...overrides,
  });
  const capped = decide(
    { items: [], reviewRequests: [review("a"), review("b"), review("c")] },
    ctxFixture(),
  );
  assert.equal(capped.filter((a) => a.type === "start-session").length, MAX_LAUNCHES_PER_PASS);
  assert.equal(capped.filter((a) => a.type === "defer" && a.reason === "launch cap").length, 1);
  const draft = decide({ items: [], reviewRequests: [review("a", { isDraft: true })] }, ctxFixture());
  assert.equal(draft.length, 0);
  const noBudget = decide(
    { items: [], reviewRequests: [review("a")] },
    ctxFixture({ budgets: { claude: true, codex: false } }),
  );
  assert.equal(noBudget[0].type, "defer");
  assert.ok(noBudget[0].reason.includes("budget"));
});

test("decide: riding subtasks defer while a sibling or parent session is active", () => {
  const sibling = itemFixture({
    id: "PY-2",
    key: "PY-2",
    parentKey: "PY-100",
    session: { state: "running" },
  });
  const fresh = itemFixture({
    id: "PY-3",
    key: "PY-3",
    parentKey: "PY-100",
    isSubtask: true,
    section: "no_pr",
    launch: { kind: "implement", label: "implement", prompt: "x", repo: null, fingerprint: "implement:PY-3" },
  });
  const ctx = ctxFixture({ sessions: [{ id: "s1", itemId: "PY-2", state: "running" }] });
  const actions = decide({ items: [sibling, fresh], reviewRequests: [] }, ctx);
  assert.equal(actions.filter((a) => a.type === "start-session").length, 0);
  assert.ok(actions.some((a) => a.type === "defer" && a.reason.includes("parent branch busy")));
  const freeCtx = ctxFixture({ sessions: [] });
  const freed = decide({ items: [{ ...sibling, session: null }, fresh], reviewRequests: [] }, freeCtx);
  assert.equal(freed.filter((a) => a.type === "start-session").length, 1);
});

test("decide: finished sessions with worktrees get housekeeping", () => {
  const actions = decide(
    { items: [], reviewRequests: [] },
    ctxFixture({ sessions: [{ id: "s1", state: "done", worktree: "/tmp/x" }, { id: "s2", state: "running", worktree: "/tmp/y" }] }),
  );
  assert.deepEqual(actions, [{ type: "clean-session", sessionId: "s1" }]);
});

// --- misc ---------------------------------------------------------------------

test("slugFor and repoPathFor", () => {
  assert.equal(slugFor("/resolve-conflicts #7287 --autonomous"), "resolve-conflicts-7287-autonomous");
  assert.ok(repoPathFor("PerformYard/Logan").endsWith("/Logan"));
  assert.ok(repoPathFor("Unknown/Repo").endsWith("/PerformYard"));
});

test("mapReviewPr: id, ticket link, thread policy, qa gate", () => {
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
        { isResolved: false, comments: { nodes: [{ author: { login: "marcus", __typename: "User" } }] } },
        { isResolved: false, comments: { nodes: [{ author: { login: "greg-py", __typename: "User" } }] } },
        { isResolved: true, comments: { nodes: [{ author: { login: "greg-py", __typename: "User" } }] } },
        { isResolved: false, comments: { nodes: [{ author: { login: "chatgpt-codex-connector", __typename: "Bot" } }] } },
      ],
    },
    commits: { nodes: [{ commit: { committedDate: "2026-08-24T00:00:00Z", statusCheckRollup: { contexts: { nodes: [{ name: "QA Code Review", conclusion: "FAILURE" }] } } } }] },
  };
  const pr = mapReviewPr(node, Date.parse("2026-08-26T00:00:00Z"));
  assert.equal(pr.id, "PerformYard/PerformYard#7400");
  assert.equal(pr.ticketKey, "PY-14000");
  assert.equal(pr.openThreads, 1, "only human reviewer-last unresolved threads count");
  assert.equal(pr.botThreads, 1, "bot threads counted separately");
  assert.equal(pr.qaGate, "blocked");
  assert.equal(pr.ageDays, 6);
});
