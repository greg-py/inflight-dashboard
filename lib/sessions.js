// Headless session runner: agent sessions are child processes owned by the
// server — spawned in fresh worktrees, logs captured per session, lifecycle
// tracked exactly (no OS windows, no heuristic ownership).
import { spawn, execFile, execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
  readdirSync,
  statSync,
  rmSync,
} from "node:fs";
import { basename, join } from "node:path";
import { CONFIG, repoPathFor } from "./config.js";
import { slugFor } from "./model.js";
import { state, saveState, appendJournal } from "./state.js";

export const notify = (title, message) => {
  execFile("osascript", [
    "-e",
    `display notification ${JSON.stringify(String(message).slice(0, 120))} with title ${JSON.stringify(String(title).slice(0, 60))}`,
  ]);
};

// --- worktree + session status inspection -----------------------------------

const IGNORED_DIRT = () => [CONFIG.statusFileName, CONFIG.approvalScriptName];

export const worktreeStatusOf = (worktreePath) => {
  if (!worktreePath || !existsSync(worktreePath)) return { state: "gone" };
  try {
    const git = (args) => execSync(`git ${args}`, { cwd: worktreePath, encoding: "utf8" }).trim();
    const dirty = git("status --porcelain")
      .split("\n")
      .filter((line) => line.trim() !== "" && !IGNORED_DIRT().some((f) => line.endsWith(f)));
    if (dirty.length > 0) return { state: "dirty" };
    const unpushed = Number(git("rev-list --count HEAD --not --remotes"));
    return unpushed > 0 ? { state: "unpushed", unpushed } : { state: "clean" };
  } catch {
    return { state: "unknown" };
  }
};

const SESSION_STATE_ALIASES = { complete: "done", completed: "done", finished: "done" };

export const sessionStatusOf = (worktreePath) => {
  try {
    const raw = JSON.parse(readFileSync(join(worktreePath, CONFIG.statusFileName), "utf8"));
    let st = String(raw.state ?? "working").toLowerCase();
    st = SESSION_STATE_ALIASES[st] ?? st;
    if (!["working", "awaiting-approval", "blocked", "done"].includes(st)) st = "working";
    const approval =
      raw.approval && typeof raw.approval === "object"
        ? {
            label: String(raw.approval.label ?? "approve").slice(0, 60),
            detail: String(raw.approval.detail ?? "").slice(0, 200),
          }
        : null;
    return { state: st, detail: String(raw.detail ?? "").slice(0, 200), ...(approval && { approval }) };
  } catch {
    return null;
  }
};

// --- spawning ----------------------------------------------------------------

export const buildAgentArgs = (agentKey, { model, effort }, prompt) => {
  const agent = CONFIG.agents[agentKey];
  const args = [...agent.headlessArgs];
  if (model && agent.modelFlag) args.push(agent.modelFlag, model);
  if (effort) {
    if (agent.effortFlag) args.push(agent.effortFlag, effort);
    else if (agent.effortConfig) args.push("-c", `${agent.effortConfig}="${effort}"`);
  }
  args.push(prompt);
  return args;
};

// Renders claude's stream-json events into a human-readable log line (or null
// to skip). Non-JSON lines (codex output) pass through untouched.
export const renderLogLine = (line, session) => {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    // codex prints its resumable session id in the run header.
    const codexId = line.match(/^session id:\s*([0-9a-f-]{36})/i);
    if (codexId) session.resumeId = codexId[1];
    return line;
  }
  if (event.type === "system" && event.subtype === "init") {
    session.resumeId = event.session_id ?? null;
    return `— session ${event.session_id ?? "?"} (${event.model ?? ""})`;
  }
  if (event.type === "assistant") {
    const parts = [];
    for (const block of event.message?.content ?? []) {
      if (block.type === "text" && block.text?.trim()) parts.push(block.text.trim());
      if (block.type === "tool_use") {
        const hint =
          typeof block.input?.command === "string"
            ? block.input.command.slice(0, 90)
            : (block.input?.file_path ?? block.input?.prompt ?? "").toString().slice(0, 90);
        parts.push(`▸ ${block.name}${hint ? `: ${hint}` : ""}`);
      }
    }
    return parts.length ? parts.join("\n") : null;
  }
  if (event.type === "result") {
    session.costUsd = event.total_cost_usd ?? null;
    session.turns = event.num_turns ?? null;
    return `— result (${event.subtype ?? "?"}, ${event.num_turns ?? "?"} turns): ${String(
      event.result ?? "",
    ).slice(0, 400)}`;
  }
  return null;
};

export const activeSessionForItem = (itemId) =>
  [...state.sessions.values()].find(
    (s) => s.itemId === itemId && ["queued", "running", "staged", "blocked"].includes(s.state),
  ) ?? null;

const finalizeSession = (session, exitCode) => {
  session.exitCode = exitCode;
  session.endedAt = Date.now();
  session.pid = null;
  const status = sessionStatusOf(session.worktree);
  if (session.state === "canceled") {
    // keep canceled
  } else if (status?.state === "awaiting-approval") {
    session.state = "staged";
    session.detail = status.detail;
    session.approval = status.approval ?? null;
    notify(`In-flight: ${session.itemId}`, `approval staged: ${status.approval?.label ?? status.detail}`);
  } else if (status?.state === "blocked") {
    session.state = "blocked";
    session.detail = status.detail;
    notify(`In-flight: ${session.itemId}`, `session blocked: ${status.detail}`);
  } else if (status?.state === "done" || exitCode === 0) {
    session.state = "done";
    session.detail = status?.detail ?? session.detail ?? "finished";
  } else {
    session.state = "failed";
    session.detail = `exit ${exitCode}${session.lastError ? ` — ${session.lastError}` : ""}`;
    notify(`In-flight: ${session.itemId}`, `session failed (exit ${exitCode})`);
  }
  appendJournal({
    actor: "session",
    action: `session ${session.state}`,
    id: session.itemId,
    detail: `${session.kind} · ${session.agent} · ${session.detail ?? ""}`.slice(0, 280),
  });
  saveState();
};

const defaultBranchCache = new Map();
const defaultBranchOf = (repoPath) => {
  if (defaultBranchCache.has(repoPath)) return defaultBranchCache.get(repoPath);
  let branch = "master";
  try {
    branch = execSync("git symbolic-ref --short refs/remotes/origin/HEAD", {
      cwd: repoPath,
      encoding: "utf8",
    })
      .trim()
      .replace(/^origin\//, "");
  } catch {
    try {
      execSync("git rev-parse --verify --quiet origin/main", { cwd: repoPath, encoding: "utf8" });
      branch = "main";
    } catch {}
  }
  defaultBranchCache.set(repoPath, branch);
  return branch;
};

// Start a headless session for a derived action. Throws on precondition
// failures (caller maps to HTTP errors / journal entries).
export const startSession = async ({ itemId, prNumber = null, action, model, effort, actor, tier }) => {
  const existing = activeSessionForItem(itemId);
  if (existing) {
    const err = new Error(`already has an active session (${existing.agent}, ${existing.state})`);
    err.code = "ACTIVE_SESSION";
    throw err;
  }
  const agent = CONFIG.agents[action.agent ?? "claude"] ? (action.agent ?? "claude") : "claude";
  const repoPath = repoPathFor(action.repo);
  if (!existsSync(repoPath)) {
    const err = new Error(`repo not found at ${repoPath} — clone it there or set REPOS_DIR in .env`);
    err.code = "NO_REPO";
    throw err;
  }
  const id = `${slugFor(action.prompt)}-${Date.now().toString(36)}`;
  const worktree = join(CONFIG.worktreeRoot, basename(repoPath), id);
  const session = {
    id,
    itemId,
    prNumber,
    kind: action.kind,
    label: action.label,
    prompt: action.prompt,
    agent,
    model: model ?? null,
    effort: effort ?? null,
    tier: tier ?? null,
    actor,
    repo: action.repo ?? CONFIG.defaultRepo,
    repoPath,
    worktree,
    logFile: join(CONFIG.sessionLogDir, `${id}.log`),
    state: "queued",
    detail: "creating worktree",
    startedAt: Date.now(),
    resumeId: null,
    pid: null,
  };
  state.sessions.set(id, session);
  saveState();

  mkdirSync(CONFIG.sessionLogDir, { recursive: true });
  const log = createWriteStream(session.logFile, { flags: "a" });
  const logLine = (text) => log.write(`${text}\n`);
  logLine(`# ${session.kind} · ${session.itemId} · ${agent}${model ? ` ${model}` : ""}${effort ? ` ${effort}` : ""}`);
  logLine(`# prompt: ${session.prompt}`);

  try {
    const branch = defaultBranchOf(repoPath);
    await new Promise((resolve, reject) => {
      execFile("git", ["fetch", "origin"], { cwd: repoPath }, (err) => (err ? reject(err) : resolve()));
    });
    await new Promise((resolve, reject) => {
      execFile(
        "git",
        ["worktree", "add", "--detach", worktree, `origin/${branch}`],
        { cwd: repoPath },
        (err) => (err ? reject(err) : resolve()),
      );
    });
  } catch (err) {
    session.state = "failed";
    session.detail = `worktree setup failed: ${String(err.message).split("\n")[0].slice(0, 160)}`;
    session.endedAt = Date.now();
    logLine(`! ${session.detail}`);
    log.end();
    saveState();
    throw Object.assign(new Error(session.detail), { code: "WORKTREE" });
  }

  runAgentProcess(session, buildAgentArgs(agent, { model, effort }, session.prompt), log, logLine);
  appendJournal({
    actor,
    action: `launch ${agent}`,
    id: itemId,
    detail: `${session.prompt} · tier ${tier ?? "-"} · ${model ?? "default"}/${effort ?? "default"}`,
  });
  return session;
};

// Spawns the agent, streams its output into the session log, and finalizes the
// record on exit. Shared by fresh launches and answered continuations.
const runAgentProcess = (session, args, log, logLine) => {
  const child = spawn(CONFIG.agents[session.agent].cmd, args, {
    cwd: session.worktree,
    stdio: ["ignore", "pipe", "pipe"],
  });
  session.pid = child.pid ?? null;
  session.state = "running";
  session.detail = "running";
  saveState();

  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const rendered = renderLogLine(line, session);
      if (rendered != null) logLine(rendered);
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) {
      session.lastError = text.split("\n")[0].slice(0, 160);
      logLine(`! ${text}`);
    }
  });
  child.on("error", (err) => {
    session.lastError = String(err.message).slice(0, 160);
    logLine(`! spawn error: ${err.message}`);
  });
  child.on("close", (code) => {
    if (buffer.trim()) {
      const rendered = renderLogLine(buffer, session);
      if (rendered != null) logLine(rendered);
    }
    log.end();
    finalizeSession(session, code ?? -1);
  });
};

// Resume args when the agent recorded a resumable id; otherwise a fresh run in
// the same worktree (the work in progress is already on disk there).
export const buildContinueArgs = (session, prompt) => {
  const agent = CONFIG.agents[session.agent];
  if (!session.resumeId) return buildAgentArgs(session.agent, session, prompt);
  if (session.agent === "claude") {
    const args = [...agent.headlessArgs, "--resume", session.resumeId];
    if (session.model && agent.modelFlag) args.push(agent.modelFlag, session.model);
    if (session.effort && agent.effortFlag) args.push(agent.effortFlag, session.effort);
    args.push(prompt);
    return args;
  }
  const args = ["exec", "resume", session.resumeId, ...agent.headlessArgs.slice(1)];
  if (session.effort && agent.effortConfig) {
    args.push("-c", `${agent.effortConfig}="${session.effort}"`);
  }
  args.push(prompt);
  return args;
};

// Answer a blocked session's question: continues the same session in the same
// worktree so its context and work in progress carry forward.
export const answerSession = (id, text) => {
  const previous = state.sessions.get(id);
  if (!previous) throw Object.assign(new Error("unknown session"), { code: "NO_SESSION" });
  if (previous.state !== "blocked") {
    throw Object.assign(new Error(`session is ${previous.state}, not blocked`), { code: "NOT_BLOCKED" });
  }
  if (!previous.worktree || !existsSync(previous.worktree)) {
    throw Object.assign(new Error("the session's worktree is gone — relaunch instead"), {
      code: "NO_WORKTREE",
    });
  }
  const answer = String(text ?? "").trim();
  if (!answer) throw Object.assign(new Error("an answer is required"), { code: "EMPTY" });

  const prompt = [
    `You asked: ${previous.detail || "(see your last message)"}`,
    "",
    `The user's answer: ${answer}`,
    "",
    "Continue the task from where you stopped in this worktree, following the same skill and autonomy rules. Update the session status file as you go.",
  ].join("\n");

  previous.state = "answered";
  previous.detail = `answered: ${answer.slice(0, 120)}`;
  previous.endedAt = previous.endedAt ?? Date.now();

  const id2 = `${previous.id}-a${Date.now().toString(36).slice(-4)}`;
  const session = {
    ...previous,
    id: id2,
    state: "queued",
    detail: "resuming with your answer",
    startedAt: Date.now(),
    endedAt: null,
    pid: null,
    logFile: join(CONFIG.sessionLogDir, `${id2}.log`),
    answeredFrom: previous.id,
  };
  state.sessions.set(id2, session);
  saveState();

  mkdirSync(CONFIG.sessionLogDir, { recursive: true });
  const log = createWriteStream(session.logFile, { flags: "a" });
  const logLine = (line) => log.write(`${line}\n`);
  logLine(`# ${session.kind} · ${session.itemId} · ${session.agent} (answered continuation)`);
  logLine(`# answer: ${answer}`);
  runAgentProcess(session, buildContinueArgs(session, prompt), log, logLine);
  appendJournal({
    actor: "you",
    action: "answered blocked session",
    id: session.itemId,
    detail: answer.slice(0, 200),
  });
  return session;
};

export const cancelSession = (id) => {
  const session = state.sessions.get(id);
  if (!session || !["queued", "running"].includes(session.state) || !session.pid) return false;
  session.state = "canceled";
  session.detail = "canceled by you";
  try {
    process.kill(session.pid, "SIGTERM");
  } catch {}
  appendJournal({ actor: "you", action: "canceled session", id: session.itemId, detail: session.kind });
  saveState();
  return true;
};

// Remove a finished session's worktree (guarded force when the only dirt is
// untracked staging leftovers and nothing is unpushed), then drop nothing —
// the record stays as history with worktree cleared.
export const cleanSessionWorktree = (session) => {
  if (!session.worktree || !existsSync(session.worktree)) {
    session.worktree = null;
    return { ok: true };
  }
  try {
    rmSync(join(session.worktree, CONFIG.statusFileName), { force: true });
    rmSync(join(session.worktree, CONFIG.approvalScriptName), { force: true });
    const git = (args) =>
      execSync(`git ${args}`, { cwd: session.worktree, encoding: "utf8", stdio: "pipe" });
    try {
      execSync(`git worktree remove ${JSON.stringify(session.worktree)}`, {
        cwd: session.repoPath,
        encoding: "utf8",
        stdio: "pipe",
        shell: "/bin/bash",
      });
    } catch (removeErr) {
      const unpushed = Number(git("rev-list --count HEAD --not --remotes").trim());
      const onlyUntracked = git("status --porcelain")
        .split("\n")
        .filter(Boolean)
        .every((line) => line.startsWith("??"));
      if (unpushed === 0 && onlyUntracked) {
        execSync(`git worktree remove --force ${JSON.stringify(session.worktree)}`, {
          cwd: session.repoPath,
          encoding: "utf8",
          stdio: "pipe",
          shell: "/bin/bash",
        });
      } else {
        throw removeErr;
      }
    }
    session.worktree = null;
    saveState();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.stderr ?? err.message).split("\n")[0].slice(0, 160) };
  }
};

// Always give a way in: resume the exact conversation when the agent recorded
// an id, otherwise open the agent in the session's worktree, where the work is.
export const takeoverCommand = (session) => {
  const cwd = session.worktree ?? session.repoPath;
  if (!cwd) return null;
  const cmd = CONFIG.agents[session.agent]?.cmd ?? "claude";
  if (session.resumeId) {
    const resume =
      session.agent === "claude" ? `claude --resume ${session.resumeId}` : `codex resume ${session.resumeId}`;
    return `cd ${cwd} && ${resume}`;
  }
  return `cd ${cwd} && ${cmd}`;
};

// Orphaned worktrees older than the cap (from crashes or pre-v2 launches) are
// removed when clean; dirty ones are never touched.
export const pruneStaleWorktrees = () => {
  const tracked = new Set([...state.sessions.values()].map((s) => s.worktree).filter(Boolean));
  for (const repo of CONFIG.knownRepos) {
    const dir = join(CONFIG.worktreeRoot, repo.split("/")[1]);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const worktreePath = join(dir, name);
      if (tracked.has(worktreePath)) continue;
      try {
        if (Date.now() - statSync(worktreePath).mtimeMs < CONFIG.worktreeMaxAgeMs) continue;
        execFile("git", ["-C", repoPathFor(repo), "worktree", "remove", worktreePath], () => {});
      } catch {}
    }
  }
};

// On server start, sessions that claim to be running but whose process is gone
// (server restart, crash) get resolved from their worktree status.
export const reconcileSessions = () => {
  for (const session of state.sessions.values()) {
    if (!["queued", "running"].includes(session.state)) continue;
    const alive =
      session.pid &&
      (() => {
        try {
          process.kill(session.pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
    if (alive) continue;
    finalizeSession(session, session.exitCode ?? -1);
  }
};

// Staged-approval execution --------------------------------------------------

export const approveSession = async (session) => {
  const script = join(session.worktree ?? "", CONFIG.approvalScriptName);
  if (!session.worktree || !existsSync(script)) {
    return { ok: false, error: `${CONFIG.approvalScriptName} missing from the worktree` };
  }
  const result = await new Promise((resolve) => {
    execFile(
      "bash",
      [script],
      { cwd: session.worktree, timeout: CONFIG.approvalTimeoutMs, encoding: "utf8" },
      (err, stdout, stderr) => resolve({ err, stdout, stderr }),
    );
  });
  if (result.err) {
    const detail = String(result.stderr || result.err.message).slice(-300);
    appendJournal({ actor: "you", action: `approval FAILED: ${session.approval?.label}`, id: session.itemId, detail });
    return { ok: false, error: `approval script failed: ${detail.slice(-160)}` };
  }
  writeFileSync(
    join(session.worktree, CONFIG.statusFileName),
    JSON.stringify({ state: "done", detail: `approved: ${session.approval?.label}` }),
  );
  session.state = "done";
  session.detail = `approved: ${session.approval?.label}`;
  appendJournal({
    actor: "you",
    action: `approved: ${session.approval?.label}`,
    id: session.itemId,
    detail: session.approval?.detail ?? "",
  });
  saveState();
  return { ok: true, output: String(result.stdout).slice(-400) };
};

export const dismissSession = (session) => {
  if (session.worktree) {
    try {
      writeFileSync(
        join(session.worktree, CONFIG.statusFileName),
        JSON.stringify({ state: "done", detail: `dismissed: ${session.approval?.label}` }),
      );
    } catch {}
  }
  session.state = "done";
  session.detail = `dismissed: ${session.approval?.label}`;
  appendJournal({
    actor: "you",
    action: `dismissed: ${session.approval?.label}`,
    id: session.itemId,
    detail: session.approval?.detail ?? "",
  });
  saveState();
};
