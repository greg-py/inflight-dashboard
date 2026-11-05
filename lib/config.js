import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const envFile = join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

export const CONFIG = {
  port: Number(process.env.PORT || 4477),
  cacheMs: 60_000,
  timeoutMs: 45_000,

  jiraBaseUrl: process.env.JIRA_BASE_URL || "https://performyard.atlassian.net",
  project: "PY",
  board: 1,
  team: "Street Sharks",
  fields: {
    sprint: "customfield_10020",
    points: "customfield_10026",
    qaLead: "customfield_10061",
    engineeringNotes: "customfield_10132",
  },
  groomLookbackDays: 60,

  org: "PerformYard",
  repo: "PerformYard/PerformYard",
  releaseBranch: "master",
  engineeringTeam: "engineering",
  qaTeam: "qa-koalas",
  // A review carrying one of these is a QA verdict, whoever wrote it.
  qaPhrase: /QA:\s*(OK|APPROVED)|:koala:|🐨/i,
  // Process gates and always-green checks: never a broken build.
  ignoredChecks: ["QA Code Review", "Check removed test IDs against QA", "Evaluate QA Approval"],
  ticketKey: /\bPY[-\s](\d+)\b/i,
  hold: /\((ON\s+)?HOLD\b[^)]*\)/i,

  nudgeBusinessDays: 2,
  staleDraftDays: 14,
  mergedLookbackDays: 21,

  releasesDir: join(homedir(), ".claude", "releases"),
  contextFile: join(homedir(), ".claude", "inflight", "context.json"),
};
