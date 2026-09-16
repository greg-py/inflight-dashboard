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
  // Where a ticket with no pull request yet would be implemented. Copied
  // prompts always state a repo, because the skills default it to whatever
  // repo the shell is sitting in and a prompt is pasted where the reader is,
  // not where the work is.
  primaryRepo: "PerformYard/PerformYard",

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
  // Work deliberately frozen. A hold is stated in the summary here — "(HOLD
  // MERGE) Remove the legacy navigation" — and it outranks every green signal
  // on the row, because the one thing the top of the board must never do is
  // point at work someone has already decided not to ship.
  holdPattern: /\(\s*HOLD\b[^)]*\)/i,
  holdLabels: ["hold", "on-hold", "blocked"],

  // Only genuinely urgent priorities jump the queue. Sorting the whole board by
  // priority would scatter "closest to shipping first", which is the ordering
  // that makes a section readable; P1 is rare enough to be worth the exception.
  urgentPriorities: ["p0", "p1"],

  // Gateway failures upstream are nearly always momentary; retry that many
  // times before showing the reader a banner.
  upstreamRetries: 1,

  // Browser refreshes within this window reuse the same upstream response.
  //
  // This has to stay well under the browser's refresh interval. Set equal to
  // it, the two clocks drift out of phase and a scheduled poll can land just
  // inside the window, receive data already nearly a full interval old, and
  // then sit on it for another whole interval — the row reads "updated 9m ago"
  // on a board that believes it refreshes every five minutes.
  //
  // Its actual job is only to collapse bursts: several tabs, a manual reload,
  // or the refresh that fires when a hidden tab is focused again. A minute
  // covers all of those and still guarantees every scheduled poll misses the
  // cache and fetches fresh.
  upstreamTtlMs: 60_000,

  // AI capacity probes.
  anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com",
  claudeKeychainService: "Claude Code-credentials",
  probeTimeoutMs: 10_000,
};
