import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
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

  reposDir: process.env.REPOS_DIR || join(homedir(), "Projects"),
  knownRepos: ["PerformYard/PerformYard", "PerformYard/Logan", "PerformYard/QA", "PerformYard/koala"],
  defaultRepo: "PerformYard/PerformYard",

  // How often the server refreshes upstream data and runs a policy pass.
  // The upstream cache also serves any number of browser tabs in between.
  engineIntervalMs: Number(process.env.ENGINE_INTERVAL_MS || 150_000),
  upstreamTtlMs: 120_000,

  // The policy engine (autopilot) acts on safe signals automatically. Off →
  // the dashboard only observes and everything is launched manually.
  autopilot: process.env.AUTOPILOT !== "off",

  // Agents and how their headless sessions are spawned. The prompt is passed
  // as the final argument. Keep permission bypasses here, visible and edited
  // deliberately: sessions run unattended in isolated worktrees by design.
  agents: {
    claude: {
      cmd: "claude",
      headlessArgs: [
        "-p",
        "--permission-mode",
        "bypassPermissions",
        "--output-format",
        "stream-json",
        "--verbose",
      ],
      models: ["fable", "opus", "opus[1m]", "sonnet", "haiku"],
      efforts: ["low", "medium", "high", "xhigh", "max"],
      modelFlag: "--model",
      effortFlag: "--effort",
    },
    codex: {
      cmd: "codex",
      headlessArgs: ["exec", "--dangerously-bypass-approvals-and-sandbox"],
      models: [],
      efforts: ["minimal", "low", "medium", "high", "xhigh"],
      modelFlag: "-m",
      effortConfig: "model_reasoning_effort",
    },
  },

  // Deterministic difficulty routing: tier → agent/model/effort. Strong models
  // everywhere, effort as the dial; fable is reserved for manual launches.
  routing: {
    light: { agent: "codex", model: null, effort: "medium" },
    standard: { agent: "codex", model: null, effort: "xhigh" },
    heavy: { agent: "claude", model: "opus", effort: "xhigh" },
  },
  tierThresholds: { reviewLightMax: 150, reviewHeavyMin: 800, addressHeavyMin: 800 },

  // Per-provider launch budget: a runaway backstop, not a scarcity measure.
  budget: { perProvider: 6, windowMs: 5 * 60 * 60 * 1000 },

  // Session bookkeeping.
  worktreeRoot: join(homedir(), ".cache/inflight-worktrees"),
  worktreeMaxAgeMs: 72 * 60 * 60 * 1000,
  sessionLogDir: join(homedir(), ".cache/inflight-dashboard/sessions"),
  keptSessionHistory: 40,
  statusFileName: ".agent-status.json",
  approvalScriptName: ".approval.sh",
  approvalTimeoutMs: 180_000,

  // Prompts carry --autonomous: skills run to their safe terminus and stage
  // outward-facing actions as one-click approvals. AUTONOMOUS=off restores
  // fully-gated interactive prompts (for terminal use).
  autonomousLaunches: process.env.AUTONOMOUS !== "off",

  // One-shot, read-only headless diagnosis of red signals.
  diagnosis: {
    enabled: process.env.DIAGNOSE !== "off",
    model: "sonnet",
    maxTurns: 15,
    timeoutMs: 240_000,
    maxConcurrent: 1,
    errorRetryMs: 30 * 60 * 1000,
    allowedTools: [
      "Bash(gh pr checks:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr diff:*)",
      "Bash(gh run view:*)",
      "Bash(gh api:*)",
    ],
    knownFlakes: [
      "React Timezone Tests failing near a UTC hour boundary",
      "cohortQuery integration tests (clock skew or hook timeout)",
      "meeting form 15-minute clock flake across unit shards",
      "post-teardown window-undefined cancellations (red with 0 failures)",
      "checkout/setup steps failing on git RPC or network timeouts (infra)",
    ],
  },
};

export const repoPathFor = (repo) => {
  const known = CONFIG.knownRepos.includes(repo) ? repo : CONFIG.defaultRepo;
  return join(CONFIG.reposDir, known.split("/")[1]);
};
