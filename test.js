import test from "node:test";
import assert from "node:assert/strict";
import {
  extractTicketKeys,
  effectiveCi,
  categorizePr,
  sectionFor,
  buildItems,
} from "./server.js";

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
};

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
  assert.equal(sectionFor({ prs: [{ bucket: "needs_you" }, { bucket: "waiting" }] }), "needs_you");
  assert.equal(sectionFor({ prs: [{ bucket: "waiting" }] }), "waiting");
  assert.equal(sectionFor({ prs: [], status: "In Testing" }), "waiting");
  assert.equal(sectionFor({ prs: [], status: "Ready To Test" }), "waiting");
  assert.equal(sectionFor({ prs: [], status: "TO DO" }), "no_pr");
  assert.equal(sectionFor({ prs: [], status: "READY" }), "no_pr");
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
