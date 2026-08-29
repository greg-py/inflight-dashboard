// The policy engine: the entire supervision decision table as deterministic,
// unit-tested code. One pass = decide (pure) + execute (effects). The only LLM
// involvement upstream of a launch is the cached diagnosis verdict.
import { execFile } from "node:child_process";
import { CONFIG } from "./config.js";
import { tierFor, routeFor } from "./model.js";
import {
  state,
  saveState,
  appendJournal,
  budgetAvailable,
  recordLaunch,
} from "./state.js";
import {
  startSession,
  cleanSessionWorktree,
  pruneStaleWorktrees,
  notify,
} from "./sessions.js";

export const MAX_LAUNCHES_PER_PASS = 2;

// Pure decision function. `snapshot` items/reviewRequests carry `hidden` and
// `session` (the active session record or null). `ctx` carries dedup state.
export const decide = (snapshot, ctx) => {
  const actions = [];
  let launches = 0;

  // Housekeeping: finished sessions release their worktrees.
  for (const session of ctx.sessions) {
    if (["done", "canceled"].includes(session.state) && session.worktree) {
      actions.push({ type: "clean-session", sessionId: session.id });
    }
  }

  if (!ctx.seeded) {
    // First pass ever: learn the board, act on nothing new-ticket-shaped.
    actions.push({ type: "seed" });
  }

  const tryLaunch = (entry, pr, launch, tier) => {
    if (launches >= MAX_LAUNCHES_PER_PASS) {
      actions.push({ type: "defer", reason: "launch cap", itemId: entry.id });
      return;
    }
    const route = routeFor(tier);
    if (!ctx.budgets[route.agent]) {
      actions.push({
        type: "defer",
        reason: `budget: ${route.agent} window spent`,
        itemId: entry.id,
        fingerprint: launch.fingerprint,
        journal: true,
      });
      return;
    }
    launches += 1;
    actions.push({
      type: "start-session",
      itemId: entry.id,
      prNumber: pr?.number ?? null,
      launch,
      tier,
      route,
    });
  };

  for (const item of snapshot.items) {
    if (item.hidden || item.session) continue;

    for (const pr of item.prs ?? []) {
      if (pr.isDraft && !item.key) continue; // parked prototypes
      const launch = pr.launch;
      if (!launch || ctx.actedOn.has(launch.fingerprint)) continue;

      if (launch.kind === "fix-ci") {
        const verdict = pr.diagnosis?.kind ?? null;
        if (verdict === "flake") {
          actions.push({
            type: "rerun-flake",
            itemId: item.id,
            pr: { repo: pr.repo, number: pr.number },
            fingerprint: `flake:${pr.repo}#${pr.number}:${pr.lastCommitAt}`,
          });
        } else if (verdict === "real") {
          tryLaunch(item, pr, launch, tierFor(launch, { pr, item }));
        }
        // no verdict yet → wait silently for diagnosis
        continue;
      }
      tryLaunch(item, pr, launch, tierFor(launch, { pr, item }));
    }

    // Newly assigned tickets → implement. Pre-existing backlog never
    // auto-launches (knownItems seeding).
    if (
      item.launch &&
      item.section === "no_pr" &&
      !item.mergedPrs &&
      ctx.seeded &&
      !ctx.knownItems.has(item.id) &&
      !ctx.actedOn.has(item.launch.fingerprint)
    ) {
      tryLaunch(item, null, item.launch, tierFor(item.launch, { item }));
    }
  }

  for (const review of snapshot.reviewRequests) {
    if (review.hidden || review.session || review.isDraft) continue;
    const launch = review.launch;
    if (!launch || ctx.actedOn.has(launch.fingerprint)) continue;
    tryLaunch(review, review, launch, tierFor(launch, { pr: review }));
  }

  return actions;
};

const rerunFlakyRuns = (pr) => {
  execFile(
    "gh",
    ["pr", "checks", String(pr.number), "--repo", pr.repo, "--json", "name,state,link"],
    { encoding: "utf8" },
    (err, stdout) => {
      if (err) {
        appendJournal({
          actor: "engine",
          action: "flake rerun FAILED",
          id: `${pr.repo}#${pr.number}`,
          detail: String(err.message).slice(0, 160),
        });
        return;
      }
      let checks = [];
      try {
        checks = JSON.parse(stdout);
      } catch {}
      const gate = CONFIG.qaGateCheck.toLowerCase();
      const runIds = [
        ...new Set(
          checks
            .filter(
              (check) =>
                String(check.state).toUpperCase() === "FAILURE" &&
                !String(check.name).toLowerCase().includes(gate),
            )
            .map((check) => String(check.link).match(/\/actions\/runs\/(\d+)/)?.[1])
            .filter(Boolean),
        ),
      ];
      for (const runId of runIds) {
        execFile("gh", ["run", "rerun", runId, "--failed", "--repo", pr.repo], () => {});
      }
      appendJournal({
        actor: "engine",
        action: "reran flaky CI",
        id: `${pr.repo}#${pr.number}`,
        detail: `${runIds.length} run(s): ${runIds.join(", ")}`,
      });
    },
  );
};

export const lastPass = { at: 0, acted: 0, deferred: 0, autopilot: CONFIG.autopilot };

// Execute one pass over a fresh snapshot. Housekeeping always runs; signal
// actions only when autopilot is on.
export const runPolicyPass = async (snapshot) => {
  const ctx = {
    sessions: [...state.sessions.values()],
    actedOn: state.actedOn,
    knownItems: state.knownItems,
    seeded: state.seeded,
    budgets: Object.fromEntries(Object.keys(CONFIG.agents).map((a) => [a, budgetAvailable(a)])),
  };
  const actions = decide(snapshot, ctx);
  let acted = 0;
  let deferred = 0;

  for (const action of actions) {
    if (action.type === "clean-session") {
      const session = state.sessions.get(action.sessionId);
      if (!session) continue;
      const result = cleanSessionWorktree(session);
      if (!result.ok) {
        appendJournal({
          actor: "engine",
          action: "needs human",
          id: session.itemId,
          detail: `worktree not removable: ${result.error}`,
        });
      }
      continue;
    }
    if (action.type === "seed") {
      for (const item of snapshot.items) state.knownItems.add(item.id);
      state.seeded = true;
      saveState();
      appendJournal({
        actor: "engine",
        action: "seeded board",
        detail: `${snapshot.items.length} existing items recorded; only newly assigned work auto-implements`,
      });
      continue;
    }
    if (!CONFIG.autopilot) continue; // observe-only mode
    if (action.type === "defer") {
      deferred += 1;
      if (action.journal && action.fingerprint && !state.actedOn.has(`defer:${action.fingerprint}`)) {
        state.actedOn.set(`defer:${action.fingerprint}`, Date.now());
        appendJournal({ actor: "engine", action: "deferred", id: action.itemId, detail: action.reason });
      }
      continue;
    }
    if (action.type === "rerun-flake") {
      acted += 1;
      // Attempt-once per commit state: a new commit re-arms the fingerprint.
      state.actedOn.set(action.fingerprint, Date.now());
      rerunFlakyRuns(action.pr);
      continue;
    }
    if (action.type === "start-session") {
      try {
        await startSession({
          itemId: action.itemId,
          prNumber: action.prNumber,
          action: { ...action.launch, agent: action.route.agent },
          model: action.route.model,
          effort: action.route.effort,
          actor: "engine",
          tier: action.tier,
        });
        state.actedOn.set(action.launch.fingerprint, Date.now());
        recordLaunch(action.route.agent);
        acted += 1;
      } catch (err) {
        if (err.code === "ACTIVE_SESSION") {
          state.actedOn.set(action.launch.fingerprint, Date.now());
        } else {
          appendJournal({
            actor: "engine",
            action: "launch FAILED",
            id: action.itemId,
            detail: String(err.message).slice(0, 200),
          });
          notify("In-flight engine", `launch failed for ${action.itemId}`);
        }
      }
      saveState();
      continue;
    }
  }

  // Track every current item so later passes only treat genuinely new ids as
  // newly assigned work.
  for (const item of snapshot.items) state.knownItems.add(item.id);
  pruneStaleWorktrees();
  lastPass.at = Date.now();
  lastPass.acted = acted;
  lastPass.deferred = deferred;
  lastPass.autopilot = CONFIG.autopilot;
  saveState();
  return { acted, deferred, actions };
};

export const setAutopilot = (on) => {
  CONFIG.autopilot = Boolean(on);
  lastPass.autopilot = CONFIG.autopilot;
  appendJournal({ actor: "you", action: `autopilot ${on ? "on" : "off"}` });
};
