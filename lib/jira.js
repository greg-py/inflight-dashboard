import { CONFIG } from "./config.js";

const F = CONFIG.fields;
const FIELDS = ["summary", "status", "issuetype", "parent", "subtasks", "assignee", "created", F.sprint, F.points, F.qaLead, F.engineeringNotes].join(",");

const jira = async (path, init = {}) => {
  const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) throw new Error("set JIRA_EMAIL and JIRA_API_TOKEN in .env");
  const res = await fetch(CONFIG.jiraBaseUrl + path, {
    ...init,
    headers: {
      Authorization: "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64"),
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    signal: AbortSignal.timeout(CONFIG.timeoutMs),
  });
  if (!res.ok) throw new Error(`${res.status} ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

const search = async (jql) => {
  const issues = [];
  let nextPageToken;
  do {
    const params = new URLSearchParams({ jql, fields: FIELDS, maxResults: "100" });
    if (nextPageToken) params.set("nextPageToken", nextPageToken);
    const page = await jira(`/rest/api/3/search/jql?${params}`);
    issues.push(...page.issues);
    nextPageToken = page.isLast === false ? page.nextPageToken : undefined;
  } while (nextPageToken);
  return issues;
};

// Jira's own status date only moves between status categories, so when a
// ticket entered its current status comes from the changelog.
const statusSince = async (issues) => {
  const since = new Map();
  if (issues.length === 0) return since;
  const keyOf = new Map(issues.map((i) => [i.id, i.key]));
  let nextPageToken;
  do {
    const page = await jira("/rest/api/3/changelog/bulkfetch", {
      method: "POST",
      body: JSON.stringify({ issueIdsOrKeys: [...keyOf.keys()], fieldIds: ["status"], maxResults: 1000, nextPageToken }),
    });
    for (const log of page.issueChangeLogs ?? []) {
      const key = keyOf.get(log.issueId);
      for (const h of log.changeHistories ?? []) {
        const at = new Date(Number(h.created) || h.created).toISOString();
        if (!since.has(key) || at > since.get(key)) since.set(key, at);
      }
    }
    nextPageToken = page.nextPageToken;
  } while (nextPageToken);
  return since;
};

const normalize = (issue, me, since) => {
  const f = issue.fields;
  return {
    key: issue.key,
    url: `${CONFIG.jiraBaseUrl}/browse/${issue.key}`,
    summary: f.summary,
    type: f.issuetype.name,
    isSubtask: Boolean(f.issuetype.subtask),
    status: f.status.name,
    category: f.status.statusCategory.key,
    created: f.created,
    statusSince: since.get(issue.key) ?? f.created,
    assignee: f.assignee?.displayName ?? null,
    mine: f.assignee?.accountId === me,
    parent: f.parent?.key ?? null,
    subtasks: (f.subtasks ?? []).map((s) => s.key),
    inSprint: (f[F.sprint] ?? []).some((s) => s.state === "active"),
    points: f[F.points] ?? 0,
    qaLead: f[F.qaLead]?.displayName ?? null,
    groomed: Boolean(f[F.engineeringNotes]),
  };
};

export const fetchJira = async () => {
  const p = `project = ${CONFIG.project}`;
  const [{ accountId: me }, mine, pod, lead, sprints] = await Promise.all([
    jira("/rest/api/3/myself"),
    search(`${p} AND assignee = currentUser() AND statusCategory != Done`),
    search(`${p} AND "Assigned Team" = "${CONFIG.team}" AND sprint in openSprints()`),
    search(`${p} AND "Engineering Lead" = currentUser() AND statusCategory = "To Do" AND updated >= -${CONFIG.groomLookbackDays}d`),
    jira(`/rest/agile/1.0/board/${CONFIG.board}/sprint?state=active`),
  ]);
  const live = new Map([...mine, ...pod.filter((i) => i.fields.status.statusCategory.key !== "done")].map((i) => [i.key, i]));
  const since = await statusSince([...live.values()]);
  const toTicket = (i) => normalize(i, me, since);

  const podTickets = pod.map(toTicket);
  const points = (keep) => podTickets.filter(keep).reduce((n, t) => n + t.points, 0);
  const sprint = sprints.values?.[0];
  return {
    tickets: mine.map(toTicket),
    podTickets: podTickets.filter((t) => t.category !== "done"),
    ungroomed: lead.map(toTicket).filter((t) => !t.groomed),
    sprint: sprint && {
      name: sprint.name.replace(/\s+Ending.*$/, ""),
      done: points((t) => t.category === "done"),
      total: points(() => true),
    },
  };
};
