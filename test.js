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
} from "./lib/model.js";
import { mapReviewPr } from "./lib/integrations.js";

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
    { isDraft: true },
    { openThreads: 2 },
    { botThreads: 1 },
  ]) {
    assert.equal(categorizePr({ ...basePr, ...overrides }).bucket, "needs_you", JSON.stringify(overrides));
  }
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
  assert.ok(categorizePr(basePr).reasons.includes("awaiting review · 2d"));
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
  const ordered = [
    "Draft PR",
    "Open PR",
    "TO DO",
    "READY",
    "In Progress",
    "In Code Review",
    "Ready To Test",
    "In Testing",
    "READY TO MERGE",
  ];
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(statusRank(ordered[index - 1]) < statusRank(ordered[index]));
  }
  assert.ok(statusRank("Some New Status") > statusRank("READY TO MERGE"));
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
        { isResolved: false, comments: { nodes: [{ author: { login: "marcus", __typename: "User" } }] } },
        { isResolved: false, comments: { nodes: [{ author: { login: "greg-py", __typename: "User" } }] } },
        { isResolved: true, comments: { nodes: [{ author: { login: "greg-py", __typename: "User" } }] } },
        { isResolved: false, comments: { nodes: [{ author: { login: "chatgpt-codex-connector", __typename: "Bot" } }] } },
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
  assert.equal(pr.openThreads, 1, "only human reviewer-last unresolved threads count");
  assert.equal(pr.botThreads, 1, "bot threads counted separately");
  assert.equal(pr.qaGate, "blocked");
  assert.equal(pr.ageDays, 6);
  assert.equal("launch" in pr, false);
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
  for (const queue of ["needs_you", "waiting", "reviews", "no_pr"]) {
    assert.equal(ui.includes(`id="card-${queue}"`), true, `${queue} queue should remain visible`);
  }
});
