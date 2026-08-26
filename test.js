import test from "node:test";
import assert from "node:assert/strict";
import {
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
  buildTerminalCommand,
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
    prompt: "/address-review #7364",
    repo: "PerformYard/PerformYard",
  });
  assert.equal(
    launchForPr(launchPr({ reviewDecision: "CHANGES_REQUESTED", mergeable: "CONFLICTING" })).label,
    "address review",
  );
  assert.equal(launchForPr(launchPr({ mergeable: "CONFLICTING", ci: "failure" })).label, "resolve conflicts");
  assert.equal(
    launchForPr(launchPr({ ci: "failure" })).prompt,
    "Investigate and fix the failing CI checks on PR #7364.",
  );
});

test("launchForPr returns null when no agent action applies", () => {
  assert.equal(launchForPr(launchPr()), null);
  assert.equal(launchForPr(launchPr({ reviewDecision: "APPROVED" })), null);
  assert.equal(launchForPr(launchPr({ number: "7364; rm -rf /" })), null);
});

test("launchForReview and launchForTicket build their prompts", () => {
  assert.equal(launchForReview(launchPr()).prompt, "/deep-review #7364");
  assert.deepEqual(launchForTicket({ key: "PY-13548", prs: [] }), {
    label: "implement",
    prompt: "/implement-ticket PY-13548",
    repo: null,
  });
  assert.equal(launchForTicket({ key: "PY-13548", prs: [{ number: 1 }] }), null);
  assert.equal(launchForTicket({ key: null, prs: [] }), null);
  assert.equal(launchForTicket({ key: "PY-1 && evil", prs: [] }), null);
});

test("buildTerminalCommand single-quotes cwd and prompt, escaping embedded quotes", () => {
  assert.equal(
    buildTerminalCommand("/Users/gking/Projects/PerformYard", "claude", "/address-review #7364"),
    "cd '/Users/gking/Projects/PerformYard' && claude '/address-review #7364'",
  );
  assert.equal(
    buildTerminalCommand("/tmp", "codex", "it's here"),
    "cd '/tmp' && codex 'it'\\''s here'",
  );
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
  assert.equal(pr.ageDays, 6);
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
