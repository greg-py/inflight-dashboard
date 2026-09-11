// AI capacity probes: how much of each coding agent's rate-limit window is
// spent. Probes are independent and fail soft — a provider that is not
// installed, not authenticated, or temporarily unreachable reports an error
// instead of breaking the board. Normalizers are pure and unit-tested.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { CONFIG } from "./config.js";

const execFileAsync = promisify(execFile);

// One rate-limit window: the share that is spent and when it rolls over.
const gauge = (label, usedPercent, resetsAt) => ({
  label,
  usedPercent: Math.max(0, Math.min(100, Math.round(usedPercent))),
  resetsAt: resetsAt ?? null,
});

// Window length as an operator reads it: 10080 minutes is "7d", 300 is "5h".
export const windowLabel = (minutes) => {
  if (!Number.isFinite(minutes) || minutes <= 0) return "window";
  if (minutes % 1440 === 0) return `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
};

// ---------------------------------------------------------------- Claude ---
// The /usage payload carries a `limits` array (kind + percent + reset) and a
// set of legacy top-level windows. Prefer the array; fall back to the legacy
// keys so an upstream shape change degrades instead of blanking the gauge.
const CLAUDE_KIND_LABELS = { session: "5h", weekly_all: "7d", weekly_scoped: "7d" };
const CLAUDE_LEGACY_WINDOWS = [
  ["five_hour", "5h"],
  ["seven_day", "7d"],
  ["seven_day_opus", "7d opus"],
  ["seven_day_sonnet", "7d sonnet"],
];
// Windows worth a row even while empty; everything else earns its place by
// having been used at all.
const CLAUDE_ALWAYS_SHOWN = new Set(["session", "weekly_all"]);

export const normalizeClaudeUsage = (payload) => {
  if (Array.isArray(payload?.limits)) {
    return payload.limits
      .filter(
        (limit) =>
          Number.isFinite(limit?.percent) &&
          (CLAUDE_ALWAYS_SHOWN.has(limit.kind) || limit.percent > 0),
      )
      .map((limit) => {
        const base = CLAUDE_KIND_LABELS[limit.kind] ?? limit.kind;
        const model = limit.scope?.model?.display_name;
        return gauge(model ? `${base} ${model}` : base, limit.percent, limit.resets_at);
      });
  }
  return CLAUDE_LEGACY_WINDOWS.filter(([key]) => Number.isFinite(payload?.[key]?.utilization)).map(
    ([key, label]) => gauge(label, payload[key].utilization, payload[key].resets_at),
  );
};

// Claude Code keeps its OAuth credential in the login keychain, the same place
// its own /usage command reads. The token is used for this one request and is
// never persisted or logged.
const claudeToken = async () => {
  const { stdout } = await execFileAsync(
    "security",
    ["find-generic-password", "-s", CONFIG.claudeKeychainService, "-w"],
    { encoding: "utf8", timeout: CONFIG.probeTimeoutMs },
  );
  const token = JSON.parse(stdout)?.claudeAiOauth?.accessToken;
  if (!token) throw new Error("no OAuth token in keychain entry");
  return token;
};

export const fetchClaudeUsage = async () => {
  const token = await claudeToken().catch((err) => {
    throw new Error(`keychain unavailable (${err.message.split("\n")[0]})`);
  });
  const res = await fetch(`${CONFIG.anthropicBaseUrl}/api/oauth/usage`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    signal: AbortSignal.timeout(CONFIG.probeTimeoutMs),
  });
  if (!res.ok) throw new Error(`usage API ${res.status}`);
  return { gauges: normalizeClaudeUsage(await res.json()), note: null };
};

// ----------------------------------------------------------------- Codex ---
// Codex reports its rate limits live over the app-server protocol. Reading them
// there rather than from local session logs is what makes the number true: one
// limit is shared by the CLI, the IDE extension and the desktop app, and only
// the server has seen all three. Local rollouts record the CLI's own traffic
// alone, so they go stale the moment you work anywhere else.
const CLIENT_INFO = { name: "inflight-dashboard", version: "1.0.0" };

const appServerCall = (method, params) =>
  new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
    let buffer = "";
    let settled = false;
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new Error("app-server timed out")),
      CONFIG.probeTimeoutMs,
    );
    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
    child.on("error", (err) => finish(new Error(`Codex CLI unavailable (${err.code ?? err.message})`)));
    child.on("exit", () => finish(new Error("app-server exited before responding")));
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue; // Progress chatter the protocol is free to interleave.
        }
        // The call is only valid once the handshake has been answered.
        if (message.id === 1) {
          send({ jsonrpc: "2.0", method: "initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method, params });
        } else if (message.id === 2) {
          if (message.error) finish(new Error(message.error.message ?? "app-server error"));
          else finish(null, message.result);
        }
      }
    });
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: CLIENT_INFO } });
  });

export const normalizeCodexRateLimits = (snapshot, now) =>
  [snapshot?.primary, snapshot?.secondary]
    .filter((window) => Number.isFinite(window?.usedPercent))
    .map((window) =>
      gauge(windowLabel(window.windowDurationMins), window.usedPercent, resetIso(window.resetsAt)),
    )
    // A window that already rolled over says nothing about what is left.
    .filter((entry) => !entry.resetsAt || Date.parse(entry.resetsAt) > now);

const resetIso = (epochSeconds) =>
  Number.isFinite(epochSeconds) ? new Date(epochSeconds * 1000).toISOString() : null;

// A spent limit has more than one cause, and "100%" alone does not say which:
// a used-up window and a depleted credit balance clear at different times.
export const codexReachedNote = (snapshot) =>
  snapshot?.rateLimitReachedType
    ? String(snapshot.rateLimitReachedType).replace(/_/g, " ")
    : null;

export const fetchCodexUsage = async (now = Date.now()) => {
  const result = await appServerCall("account/rateLimits/read", {});
  const snapshot = result?.rateLimitsByLimitId?.codex ?? result?.rateLimits;
  if (!snapshot) throw new Error("no rate-limit snapshot returned");
  return {
    gauges: normalizeCodexRateLimits(snapshot, now),
    note: codexReachedNote(snapshot),
  };
};

// ---------------------------------------------------------------- probes ---
const PROVIDERS = [
  { id: "claude", name: "Claude", probe: fetchClaudeUsage },
  { id: "codex", name: "Codex", probe: fetchCodexUsage },
];

export const fetchAiUsage = async () => {
  const results = await Promise.allSettled(PROVIDERS.map((provider) => provider.probe()));
  return PROVIDERS.map((provider, index) => {
    const result = results[index];
    return result.status === "fulfilled"
      ? { id: provider.id, name: provider.name, ok: true, ...result.value }
      : { id: provider.id, name: provider.name, ok: false, error: result.reason.message, gauges: [] };
  });
};
