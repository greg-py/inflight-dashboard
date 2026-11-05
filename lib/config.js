import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

export const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const path = join(ROOT, ".env");
if (existsSync(path)) {
  for (const line of readFileSync(path, "utf8").split("\n")) {
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
    team: "customfield_10055",
    engineeringLead: "customfield_10060",
    qaLead: "customfield_10061",
    engineeringNotes: "customfield_10132",
  },
  // Tickets you lead that nobody has groomed. Older than this is backlog sediment.
  groomLookbackDays: 60,

  org: "PerformYard",
  repo: "PerformYard/PerformYard",
  engineeringTeam: "engineering",
  qaTeam: "qa-koalas",
  // Any review or comment carrying one of these is a QA verdict, whoever wrote it.
  qaPhrase: /QA:\s*(OK|APPROVED)|:koala:|🐨/i,
  // Checks that are process gates or always green; never a broken build.
  ignoredChecks: ["QA Code Review", "Check removed test IDs against QA", "Evaluate QA Approval"],
  ticketKey: /\bPY[-\s](\d+)\b/i,
  hold: /\((ON\s+)?HOLD\b[^)]*\)/i,

  // No review this many business days after the request: nudge.
  nudgeBusinessDays: 2,
  // A draft nobody has pushed to in this long, with no live ticket: close it.
  staleDraftDays: 14,

  releasesDir: join(homedir(), ".claude", "releases"),
  // Slack, meetings and calendar have no local credentials; a Claude routine
  // writes them here and the board reads whatever is present.
  contextFile: join(homedir(), ".claude", "inflight", "context.json"),
};
