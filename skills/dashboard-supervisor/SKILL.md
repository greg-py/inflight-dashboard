---
name: dashboard-supervisor
description: One supervision pass over the local inflight dashboard. Fetches the dashboard's data API, diffs it against the previous pass, and acts on safe signals — launches /resolve-conflicts on new merge conflicts, reruns known-flake CI, launches /address-review on new reviewer feedback and fix-CI sessions on real failures, pre-launches /deep-review drafts on new review requests — journaling every action to the dashboard and notifying on sessions that await approval. Never ships, merges, or writes to Jira. Pair with /loop for continuous supervision (e.g. "/loop 10m /dashboard-supervisor").
argument-hint: "[--dry-run] [--max-launches N]"
---

You are the supervisor for the user's local inflight dashboard (https://github.com/greg-py/inflight-dashboard). You run **one pass**: observe, decide, act within policy, report. Continuous supervision comes from invoking this skill on a loop, not from looping inside it.

## Hard Rules

1. **Never cross an approval gate.** No `--ship`, no merging PRs, no posting reviews or comments, no Jira writes, no pushing code yourself. You launch *interactive sessions* (which stop at their own gates) and rerun CI; nothing else touches shared systems.
2. **The only GitHub write you may perform is rerunning failed CI runs**, and only for failures the dashboard has diagnosed as `flake`.
3. **Every action you take must be journaled** to the dashboard (`POST /api/journal`) in the same pass.
4. **Act once per state.** Dedup via the state file below; a signal you already acted on (same PR, same commit / same review timestamp) is never acted on again, even across passes.
5. **When unsure, don't act** — journal the observation with action `needs human` instead.

## Pass Procedure

1. **Fetch** `curl -s http://localhost:4477/api/data`. If the dashboard isn't running, say so and stop — do not start it yourself.
2. **Load state** from `~/.cache/inflight-supervisor/state.json`: `{ actedOn: { "<action-key>": epochMs }, lastAwaiting: ["<id>", ...] }` (create the directory/file on first run).
3. **Build the decision table** from non-hidden `items` (skip every review-request row except policy #5, skip any PR with `isDraft: true`, skip any item whose `launched` record is present — a session already owns it):

| # | Signal (from the payload) | Action | Action key |
|---|---|---|---|
| 1 | A PR's `reasons` include `conflicts with base` | `POST /api/launch {id, prNumber, agent: "claude", actor: "supervisor"}` | `conflicts:<repo>#<number>:<lastCommitAt>` |
| 2 | `ci === "failure"` and `diagnosis.kind === "flake"` | Find the failing runs (`gh pr checks <n> --repo <r> --json name,state,link`), extract run ids from the links, `gh run rerun <run-id> --failed --repo <r>` | `flake:<repo>#<number>:<lastCommitAt>` |
| 3 | `ci === "failure"` and `diagnosis.kind === "real"` | Launch the fix-CI session: `POST /api/launch {id, prNumber, agent: "claude", actor: "supervisor"}` | `fixci:<repo>#<number>:<lastCommitAt>` |
| 4 | `reasons` include `changes requested` (not `changes pushed…`) | Launch address-review: `POST /api/launch {id, prNumber, agent: "claude", actor: "supervisor"}` | `review:<repo>#<number>:<changesRequestedAt>` |
| 5 | A `reviewRequests` entry with no `launched` record and `isDraft: false` | Pre-launch the review draft: `POST /api/launch {id, agent: "claude", actor: "supervisor"}` (deep-review/verify-review never post without approval) | `prereview:<repo>#<number>` |
| 6 | An entry's `launched.session.state` is `awaiting-approval` or `blocked` and its id was NOT in `lastAwaiting` | Notify: `osascript -e 'display notification "<detail>" with title "In-flight: <id> awaits you"'` | (tracked via `lastAwaiting`) |

Notes: `ci === "failure"` with **no** `diagnosis` yet means the dashboard is still diagnosing — leave it for a later pass. A `409` from `/api/launch` means a session already exists: record the action key as acted-on and move on.

4. **Apply guardrails before acting:** at most **2** `/api/launch` calls per pass (`--max-launches N` overrides; rerun-CI and notifications don't count); skip any action whose key is already in `actedOn`; with `--dry-run`, print the full decision table with what WOULD happen and change nothing (state file included).
5. **Act**, journaling each action as you go: `POST /api/journal {actor: "supervisor", action: "<short verb phrase>", id: "<item id>", detail: "<why — the signal that triggered it>"}`. Journal skipped-but-noteworthy signals (e.g. an undiagnosed CI failure, a signal deferred by the launch cap) with action `deferred`.
6. **Save state**: merge the new action keys into `actedOn` (prune entries older than 14 days), and set `lastAwaiting` to the current list of awaiting/blocked ids.
7. **Report** one short paragraph: what you acted on and why, what you deferred, which sessions await the user. No tables, no restating the whole payload.
