// inflight dashboard server: serves the UI, exposes the data/actions API, and
// runs the deterministic policy engine on a timer. See lib/ for the pieces.
import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { ROOT, CONFIG } from "./lib/config.js";
import { buildItems, tierFor, routeFor } from "./lib/model.js";
import { getUpstream, transitionJiraIssue } from "./lib/integrations.js";
import { scheduleDiagnoses, attachDiagnoses } from "./lib/diagnosis.js";
import {
  state,
  loadState,
  saveState,
  pruneState,
  appendJournal,
  readJournal,
} from "./lib/state.js";
import {
  startSession,
  answerSession,
  cancelSession,
  cleanSessionWorktree,
  activeSessionForItem,
  approveSession,
  dismissSession,
  takeoverCommand,
  reconcileSessions,
  worktreeStatusOf,
} from "./lib/sessions.js";
import { runPolicyPass, setAutopilot, lastPass } from "./lib/policy.js";

loadState();
reconcileSessions();
pruneState();

// Defaults each CLI would use on its own, re-read per refresh so the UI's
// selectors show reality.
const readAgentDefaults = () => {
  const defaults = { claude: { model: null, effort: null }, codex: { model: null, effort: null } };
  try {
    const settings = JSON.parse(readFileSync(join(homedir(), ".claude/settings.json"), "utf8"));
    defaults.claude = { model: settings.model ?? null, effort: settings.effort ?? null };
  } catch {}
  try {
    const toml = readFileSync(join(homedir(), ".codex/config.toml"), "utf8");
    const value = (key) => toml.match(new RegExp(`^${key}\\s*=\\s*"([^"]+)"`, "m"))?.[1] ?? null;
    defaults.codex = { model: value("model"), effort: value("model_reasoning_effort") };
  } catch {}
  return defaults;
};

const publicSession = (session) => ({
  id: session.id,
  itemId: session.itemId,
  prNumber: session.prNumber,
  kind: session.kind,
  label: session.label,
  prompt: session.prompt,
  agent: session.agent,
  model: session.model,
  effort: session.effort,
  tier: session.tier,
  actor: session.actor,
  state: session.state,
  detail: session.detail ?? "",
  startedAt: session.startedAt,
  endedAt: session.endedAt ?? null,
  costUsd: session.costUsd ?? null,
  approval: session.approval ?? null,
  hasWorktree: Boolean(session.worktree),
  worktreeStatus: session.worktree ? worktreeStatusOf(session.worktree).state : null,
  takeover: takeoverCommand(session),
});

let lastSnapshot = null;

const buildSnapshot = async () => {
  const upstream = await getUpstream();
  const decorate = (entry) => {
    const active = activeSessionForItem(entry.id);
    return {
      ...entry,
      hidden: state.hidden.has(entry.id),
      session: active ? publicSession(active) : null,
    };
  };
  const items = buildItems(upstream.jiraIssues, upstream.github.mine, upstream.github.merged).map(
    decorate,
  );
  attachDiagnoses(items);
  scheduleDiagnoses(items);
  const reviewRequests = upstream.github.reviewRequests.map(decorate);
  return (lastSnapshot = {
    fetchedAt: upstream.fetchedAt,
    sources: upstream.sources,
    items,
    reviewRequests,
  });
};

const payload = async () => {
  const snapshot = await buildSnapshot();
  const sessions = [...state.sessions.values()]
    .sort((a, b) => b.startedAt - a.startedAt)
    .map(publicSession);
  return {
    ...snapshot,
    sessions,
    transitions: [...state.pendingTransitions.values()],
    journal: readJournal(30),
    autopilot: CONFIG.autopilot,
    lastPass: { at: lastPass.at, acted: lastPass.acted },
    agentOptions: Object.fromEntries(
      Object.entries(CONFIG.agents).map(([name, agent]) => {
        const defaults = readAgentDefaults()[name] ?? {};
        return [
          name,
          {
            models: agent.models,
            efforts: agent.efforts,
            defaultModel: defaults.model ?? null,
            defaultEffort: defaults.effort ?? null,
          },
        ];
      }),
    ),
  };
};

const findLaunchTarget = (id, prNumber) => {
  const entries = [...(lastSnapshot?.items ?? []), ...(lastSnapshot?.reviewRequests ?? [])];
  const entry = entries.find((candidate) => candidate.id === id);
  if (!entry) return null;
  if (prNumber != null) {
    const pr = (entry.prs ?? []).find((p) => p.number === Number(prNumber));
    return pr?.launch ? { entry, pr, launch: pr.launch } : null;
  }
  return entry.launch ? { entry, pr: entry.prs ? null : entry, launch: entry.launch } : null;
};

const stagedSessionFor = (itemId) => {
  const session = activeSessionForItem(itemId);
  return session && session.state === "staged" ? session : null;
};

const tailFile = (path, bytes = 16_384) => {
  if (!path || !existsSync(path)) return "";
  const size = statSync(path).size;
  const start = Math.max(0, size - bytes);
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } finally {
    closeSync(fd);
  }
};

const readBody = (req) =>
  new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => resolve(data));
  });

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

// One policy pass: refresh the snapshot and let the engine act on it. Runs on
// a timer so the system works with no browser open; /api/data reuses the same
// upstream cache so tabs add no load.
const enginePass = async () => {
  try {
    const snapshot = await buildSnapshot();
    await runPolicyPass(snapshot);
    pruneState();
  } catch (err) {
    appendJournal({ actor: "engine", action: "pass FAILED", detail: String(err.message).slice(0, 200) });
  }
};

const startServer = () => {
  createServer(async (req, res) => {
    try {
      if (req.url.startsWith("/api/data")) {
        json(res, 200, await payload());
      } else if (req.url.startsWith("/api/health")) {
        json(res, 200, {
          ok: true,
          autopilot: CONFIG.autopilot,
          lastPassAt: lastPass.at,
          activeSessions: [...state.sessions.values()].filter((s) =>
            ["queued", "running", "staged", "blocked"].includes(s.state),
          ).length,
        });
      } else if (req.url.startsWith("/api/session-log")) {
        const id = new URL(req.url, "http://x").searchParams.get("id");
        const session = state.sessions.get(id);
        if (!session) return json(res, 404, { error: "unknown session" });
        json(res, 200, { log: tailFile(session.logFile) });
      } else if (req.method === "POST" && req.url === "/api/launch") {
        const { id, prNumber, agent, model, effort } = JSON.parse((await readBody(req)) || "{}");
        const target = typeof id === "string" ? findLaunchTarget(id, prNumber) : null;
        if (!target) return json(res, 400, { error: "no action derivable for that item/PR" });
        const agentKey = CONFIG.agents[agent] ? agent : null;
        const agentDef = agentKey ? CONFIG.agents[agentKey] : null;
        if (agent && !agentDef) return json(res, 400, { error: "unknown agent" });
        if (model && agentDef && !agentDef.models.includes(model) && model !== readAgentDefaults()[agentKey]?.model) {
          return json(res, 400, { error: "unknown model for that agent" });
        }
        if (effort && agentDef && !agentDef.efforts.includes(effort)) {
          return json(res, 400, { error: "unknown effort for that agent" });
        }
        const tier = tierFor(target.launch, { pr: target.pr, item: target.entry });
        const route = routeFor(tier);
        try {
          const session = await startSession({
            itemId: id,
            prNumber: prNumber ?? null,
            action: { ...target.launch, agent: agentKey ?? route.agent },
            model: model ?? (agentKey ? null : route.model),
            effort: effort ?? (agentKey ? null : route.effort),
            actor: "you",
            tier,
          });
          json(res, 200, { ok: true, session: publicSession(session) });
        } catch (err) {
          json(res, err.code === "ACTIVE_SESSION" ? 409 : 400, { error: err.message });
        }
      } else if (req.method === "POST" && (req.url === "/api/approve" || req.url === "/api/dismiss")) {
        const { id } = JSON.parse((await readBody(req)) || "{}");
        const session = typeof id === "string" ? stagedSessionFor(id) : null;
        if (!session?.approval) return json(res, 400, { error: "no staged approval for that item" });
        if (req.url === "/api/dismiss") {
          dismissSession(session);
          return json(res, 200, { ok: true });
        }
        const result = await approveSession(session);
        json(res, result.ok ? 200 : 500, result.ok ? { ok: true, output: result.output } : { error: result.error });
      } else if (req.method === "POST" && req.url === "/api/session-answer") {
        const { id, text } = JSON.parse((await readBody(req)) || "{}");
        try {
          const session = answerSession(id, text);
          json(res, 200, { ok: true, sessionId: session.id });
        } catch (err) {
          json(res, err.code === "NO_SESSION" ? 404 : 400, { error: err.message });
        }
      } else if (req.method === "POST" && req.url === "/api/session-cancel") {
        const { id } = JSON.parse((await readBody(req)) || "{}");
        json(res, 200, { ok: cancelSession(id) });
      } else if (req.method === "POST" && req.url === "/api/session-clear") {
        const { id } = JSON.parse((await readBody(req)) || "{}");
        const session = state.sessions.get(id);
        if (!session) return json(res, 404, { error: "unknown session" });
        if (["queued", "running"].includes(session.state)) {
          return json(res, 400, { error: "cancel it first" });
        }
        const result = cleanSessionWorktree(session);
        if (!result.ok) return json(res, 409, { error: result.error });
        if (["staged", "blocked"].includes(session.state)) {
          session.state = "done";
          session.detail = "cleared by you";
        }
        saveState();
        appendJournal({ actor: "you", action: "cleared session", id: session.itemId, detail: session.kind });
        json(res, 200, { ok: true });
      } else if (req.method === "POST" && req.url === "/api/transition") {
        const { itemId, action } = JSON.parse((await readBody(req)) || "{}");
        const pending = typeof itemId === "string" ? state.pendingTransitions.get(itemId) : null;
        if (!pending || !["approve", "dismiss"].includes(action)) {
          return json(res, 400, { error: "no staged transition for that item" });
        }
        if (action === "approve") {
          try {
            await transitionJiraIssue(itemId, pending.target);
          } catch (err) {
            appendJournal({
              actor: "you",
              action: "transition FAILED",
              id: itemId,
              detail: String(err.message).slice(0, 200),
            });
            return json(res, 500, { error: err.message });
          }
        }
        state.actedOn.set(pending.key, Date.now());
        state.pendingTransitions.delete(itemId);
        appendJournal({
          actor: "you",
          action: action === "approve" ? "transitioned ticket" : "dismissed transition",
          id: itemId,
          detail: `${pending.status} → ${pending.target}`,
        });
        saveState();
        json(res, 200, { ok: true, target: pending.target });
      } else if (req.method === "POST" && (req.url === "/api/hide" || req.url === "/api/restore")) {
        const { id } = JSON.parse((await readBody(req)) || "{}");
        if (typeof id === "string" && id) {
          if (req.url === "/api/hide") state.hidden.add(id);
          else state.hidden.delete(id);
          saveState();
        }
        json(res, 200, { ok: true });
      } else if (req.method === "POST" && req.url === "/api/autopilot") {
        const { on } = JSON.parse((await readBody(req)) || "{}");
        setAutopilot(Boolean(on));
        json(res, 200, { ok: true, autopilot: CONFIG.autopilot });
      } else if (req.method === "GET" && req.url.startsWith("/api/journal")) {
        const limit = Number(new URL(req.url, "http://x").searchParams.get("limit")) || 30;
        json(res, 200, { events: readJournal(Math.min(limit, 200)) });
      } else if (req.method === "POST" && req.url === "/api/journal") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (typeof body.action !== "string" || !body.action) {
          return json(res, 400, { error: "action is required" });
        }
        json(res, 200, { ok: true, entry: appendJournal(body) });
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(readFileSync(join(ROOT, "index.html")));
      }
    } catch (err) {
      json(res, 500, { error: err.message });
    }
  }).listen(CONFIG.port, "127.0.0.1", () => {
    console.log(
      `inflight dashboard → http://localhost:${CONFIG.port} (autopilot ${CONFIG.autopilot ? "on" : "off"})`,
    );
  });

  setTimeout(enginePass, 3_000);
  setInterval(enginePass, CONFIG.engineIntervalMs);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}
