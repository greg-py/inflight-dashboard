// Single persistent state store + append-only journal. Everything the server
// remembers lives here; there is no second state file anywhere else.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, CONFIG } from "./config.js";

const STATE_PATH = join(ROOT, ".state.json");
const JOURNAL_PATH = join(ROOT, ".journal.jsonl");

export const state = {
  hidden: new Set(),
  sessions: new Map(), // sessionId -> session record
  diagnoses: new Map(), // diagnosis key -> verdict
  actedOn: new Map(), // action fingerprint -> epochMs (policy dedup)
  knownItems: new Set(), // item ids seen by the policy engine
  launchLog: [], // [{provider, at}] for budget windows
  seeded: false, // knownItems seeded? (first run never mass-launches)
  pendingTransitions: new Map(), // itemId -> staged Jira transition suggestion
};

export const loadState = () => {
  try {
    const raw = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    for (const id of raw.hidden ?? []) state.hidden.add(id);
    for (const [id, session] of Object.entries(raw.sessions ?? {})) state.sessions.set(id, session);
    for (const [key, diagnosis] of Object.entries(raw.diagnoses ?? {})) {
      state.diagnoses.set(key, diagnosis);
    }
    for (const [key, at] of Object.entries(raw.actedOn ?? {})) state.actedOn.set(key, at);
    for (const id of raw.knownItems ?? []) state.knownItems.add(id);
    state.launchLog = raw.launchLog ?? [];
    state.seeded = Boolean(raw.seeded);
    for (const [id, t] of Object.entries(raw.pendingTransitions ?? {})) {
      state.pendingTransitions.set(id, t);
    }
  } catch {}
};

export const saveState = () => {
  try {
    writeFileSync(
      STATE_PATH,
      JSON.stringify({
        hidden: [...state.hidden],
        sessions: Object.fromEntries(state.sessions),
        diagnoses: Object.fromEntries(state.diagnoses),
        actedOn: Object.fromEntries(state.actedOn),
        knownItems: [...state.knownItems],
        launchLog: state.launchLog,
        seeded: state.seeded,
        pendingTransitions: Object.fromEntries(state.pendingTransitions),
      }),
    );
  } catch {}
};

export const pruneState = (now = Date.now()) => {
  for (const [key, at] of state.actedOn) {
    if (now - at > 14 * 24 * 60 * 60 * 1000) state.actedOn.delete(key);
  }
  state.launchLog = state.launchLog.filter((row) => now - row.at < CONFIG.budget.windowMs);
  // Keep only the newest completed sessions; active ones are never pruned.
  const done = [...state.sessions.values()]
    .filter((s) => ["done", "failed", "canceled"].includes(s.state))
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  for (const stale of done.slice(CONFIG.keptSessionHistory)) state.sessions.delete(stale.id);
};

export const appendJournal = (event) => {
  const entry = {
    at: Date.now(),
    actor: String(event.actor ?? "you").slice(0, 24),
    action: String(event.action ?? "").slice(0, 60),
    id: event.id != null ? String(event.id).slice(0, 80) : null,
    detail: String(event.detail ?? "").slice(0, 300),
  };
  try {
    writeFileSync(JOURNAL_PATH, `${JSON.stringify(entry)}\n`, { flag: "a" });
  } catch {}
  return entry;
};

export const readJournal = (limit = 30) => {
  try {
    return readFileSync(JOURNAL_PATH, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .slice(-limit)
      .map((line) => JSON.parse(line))
      .reverse();
  } catch {
    return [];
  }
};

// Budget accounting ---------------------------------------------------------

const budgetSpent = (provider, now = Date.now()) =>
  state.launchLog.filter((row) => row.provider === provider && now - row.at < CONFIG.budget.windowMs)
    .length;

export const budgetAvailable = (provider, now = Date.now()) =>
  budgetSpent(provider, now) < CONFIG.budget.perProvider;

export const recordLaunch = (provider, now = Date.now()) => {
  state.launchLog.push({ provider, at: now });
};
