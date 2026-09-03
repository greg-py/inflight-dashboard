import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const loadDotEnv = () => {
  const path = join(ROOT, ".env");
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const match = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
};
loadDotEnv();

// All configuration lives here. No config UI — edit these constants.
export const CONFIG = {
  port: Number(process.env.PORT || 4477),
  jiraBaseUrl: process.env.JIRA_BASE_URL || "https://performyard.atlassian.net",
  jiraJql:
    "assignee = currentUser() AND project = PY AND statusCategory != Done ORDER BY updated DESC",
  githubSearch: "is:pr is:open author:@me archived:false org:PerformYard",
  githubReviewSearch: "is:pr is:open review-requested:@me archived:false org:PerformYard",
  ticketKeyPattern: /\bPY-\d+\b/gi,

  // Checks that are red until a human acts and say nothing about the build.
  noisyChecks: ["QA Code Review"],
  // The human QA approval gate: excluded from CI, but its all-green state is
  // the true merge-readiness signal.
  qaGateCheck: "QA Code Review",
  mergedLookbackDays: 14,

  waitingStatuses: ["in code review", "ready to test", "in testing", "ready to merge", "blocked"],
  // CI pending with no movement for this long reads as stuck, not running.
  ciStuckMs: 2 * 60 * 60 * 1000,
  qaHoldStatuses: ["ready to test", "in testing"],
  preQaStatuses: ["in progress", "in code review"],
  statusOrder: [
    "draft pr",
    "open pr",
    "to do",
    "ready",
    "in progress",
    "in code review",
    "ready to test",
    "in testing",
    "ready to merge",
  ],
  // Browser refreshes within this window reuse the same upstream response.
  upstreamTtlMs: 120_000,
};
