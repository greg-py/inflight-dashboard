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
  // "Check removed test IDs against QA" is QA's cue to update their own repo,
  // not a signal that this branch is broken.
  noisyChecks: ["QA Code Review", "Check removed test IDs against QA"],
  // The human QA approval gate: excluded from CI, but its all-green state is
  // the true merge-readiness signal.
  qaGateCheck: "QA Code Review",
  mergedLookbackDays: 14,

  // Conventional Comments labels that explicitly do not request a change.
  // Anything unrecognised counts as actionable — the safe way to be wrong.
  nonActionableLabels: ["praise", "thought", "note"],

  // Codex badges every finding with a priority, and the team triages P1 only.
  // The rest are real but not worth a row, so they are dropped rather than
  // counted. Other review bots (CodeQL, cursor, claude) do not badge priority
  // at all and are untouched by this — their findings still count.
  codexBots: ["chatgpt-codex-connector"],
  codexActionablePriorities: ["P1"],

  waitingStatuses: ["in code review", "ready to test", "in testing", "ready to merge", "blocked"],
  // CI pending with no movement for this long reads as stuck, not running.
  ciStuckMs: 2 * 60 * 60 * 1000,
  qaHoldStatuses: ["ready to test", "in testing"],
  // QA that has actually started, so approved work can say "in QA" rather than
  // claiming it is still queued for it.
  qaActiveStatuses: ["in testing"],
  preQaStatuses: ["in progress", "in code review"],
  // Sort order inside a section: closest to shipping first, so work that is one
  // action from done outranks work that has barely started. Blocked sits high
  // because it is the one state that will not clear on its own. An unrecognised
  // status sorts last rather than jumping the queue.
  statusOrder: [
    "ready to merge",
    "blocked",
    "in testing",
    "ready to test",
    "in code review",
    "in progress",
    "ready",
    "to do",
    "open pr",
    "draft pr",
  ],
  // Gateway failures upstream are nearly always momentary; retry that many
  // times before showing the reader a banner.
  upstreamRetries: 1,

  // Browser refreshes within this window reuse the same upstream response.
  upstreamTtlMs: 120_000,

  // GitHub inbox: notification reasons the board already renders in full, so
  // repeating them here would be noise rather than news.
  notificationReasonsHidden: ["author", "review_requested", "subscribed"],
  notificationLimit: 12,

  // AI capacity probes.
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  claudeKeychainService: "Claude Code-credentials",
  probeTimeoutMs: 10_000,
};
