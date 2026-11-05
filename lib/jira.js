import { CONFIG } from "./config.js";

const F = CONFIG.fields;
const FIELDS = [
  "summary", "status", "issuetype", "parent", "subtasks", "assignee", "created", "updated",
  F.sprint, F.points, F.qaLead, F.team, F.engineeringNotes,
].join(",");

const auth = () => {
  const { JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_EMAIL || !JIRA_API_TOKEN) throw new Error("Jira: set JIRA_EMAIL and JIRA_API_TOKEN in .env");
  return "Basic " + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString("base64");
};

const jira = async (path, init = {}) => {
  const res = await fetch(CONFIG.jiraBaseUrl + path, {
    ...init,
    headers: { Authorization: auth(), Accept: "application/json", "Content-Type": "application/json" },
    signal: AbortSignal.timeout(CONFIG.timeoutMs),
  });
  if (!res.ok) throw new Error(`Jira ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
};

const search = async (jql, fields = FIELDS) => {
  const out = [];
  let token;
  do {
    const params = new URLSearchParams({ jql, fields, maxResults: "100" });
    if (token) params.set("nextPageToken", token);
    const page = await jira(`/rest/api/3/search/jql?${params}`);
    out.push(...page.issues);
    token = page.isLast === false ? page.nextPageToken : undefined;
  } while (token);
  return out;
};

// When each ticket entered its current status. Jira's own status date only
// moves between status categories, so the changelog is the only true source.
const statusSince = async (issues) => {
  const since = new Map();
  if (issues.length === 0) return since;
  const idToKey = new Map(issues.map((i) => [i.id, i.key]));
  let token;
  do {
    const page = await jira("/rest/api/3/changelog/bulkfetch", {
      method: "POST",
      body: JSON.stringify({ issueIdsOrKeys: issues.map((i) => i.id), fieldIds: ["status"], maxResults: 1000, nextPageToken: token }),
    });
    for (const log of page.issueChangeLogs ?? []) {
      const key = idToKey.get(log.issueId);
      for (const h of log.changeHistories ?? []) {
        if (!h.items.some((it) => it.fieldId === "status" || it.field === "status")) continue;
        const at = new Date(Number(h.created) || h.created).toISOString();
        if (!since.has(key) || at > since.get(key)) since.set(key, at);
      }
    }
    token = page.nextPageToken;
  } while (token);
  return since;
};

const normalize = (issue, me, since) => {
  const f = issue.fields;
  const sprints = f[F.sprint] ?? [];
  return {
    key: issue.key,
    url: `${CONFIG.jiraBaseUrl}/browse/${issue.key}`,
    summary: f.summary,
    type: f.issuetype.name,
    isSubtask: Boolean(f.issuetype.subtask),
    status: f.status.name,
    category: f.status.statusCategory.key,
    statusSince: since.get(issue.key) ?? f.created,
    created: f.created,
    assignee: f.assignee ? { id: f.assignee.accountId, name: f.assignee.displayName } : null,
    mine: f.assignee?.accountId === me,
    parent: f.parent?.key ?? null,
    subtasks: (f.subtasks ?? []).map((s) => ({ key: s.key })),
    inSprint: sprints.some((s) => s.state === "active"),
    points: f[F.points] ?? null,
    qaLead: f[F.qaLead]?.displayName ?? null,
    notesEmpty: !f[F.engineeringNotes],
  };
};

export const fetchJira = async () => {
  const me = (await jira("/rest/api/3/myself")).accountId;
  const team = `"Assigned Team" = "${CONFIG.team}"`;
  const [mine, pod, lead, sprints] = await Promise.all([
    search(`assignee = currentUser() AND project = ${CONFIG.project} AND statusCategory != Done`),
    search(`${team} AND sprint in openSprints() AND project = ${CONFIG.project}`),
    search(
      `project = ${CONFIG.project} AND "Engineering Lead" = currentUser() AND statusCategory = "To Do" ` +
        `AND (assignee IS EMPTY OR assignee != currentUser()) AND updated >= -${CONFIG.groomLookbackDays}d`,
    ),
    jira(`/rest/agile/1.0/board/${CONFIG.board}/sprint?state=active`),
  ]);
  const live = [...mine, ...pod.filter((i) => i.fields.status.statusCategory.key !== "done")];
  const since = await statusSince([...new Map(live.map((i) => [i.key, i])).values()]);

  const podAll = pod.map((i) => normalize(i, me, since));
  const sprint = sprints.values?.[0];
  const points = (filter) => podAll.filter(filter).reduce((n, t) => n + (t.points ?? 0), 0);
  return {
    me,
    tickets: mine.map((i) => normalize(i, me, since)),
    podTickets: podAll.filter((t) => t.category !== "done"),
    groom: lead.map((i) => normalize(i, me, since)).filter((t) => t.notesEmpty),
    sprint: sprint && {
      name: sprint.name.replace(/\s+Ending.*$/, ""),
      start: sprint.startDate,
      end: sprint.endDate,
      done: points((t) => t.category === "done"),
      todo: points((t) => t.category === "new"),
      total: points(() => true),
    },
  };
};
