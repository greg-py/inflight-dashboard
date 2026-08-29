# inflight-dashboard

A local dashboard + autonomous engine for in-flight work: all assigned Jira tickets
(including subtasks boards hide) joined to your open GitHub PRs, sorted by who's blocked —
with a deterministic policy engine that launches headless coding-agent sessions to address
what it safely can, and queues the rest as one-click approvals.

## How it works

One Node server (zero dependencies) does everything:

- **Fetches** Jira + GitHub through a TTL cache (one upstream fetch per 2 minutes no
  matter how many tabs or engine passes; failures serve last-good data marked stale).
- **Categorizes** every item: *Needs you* (real defects, merge-ready work), *Waiting on
  others* (reviews out, QA holds), *In development* (no PR of its own; parent-branch
  subtasks annotated).
- **Diagnoses** red signals with one-shot, read-only headless `claude` runs: failing CI is
  classified "likely flake — rerun-safe" vs a real cause (the `QA Code Review` human gate
  is never blamed); changes-requested reviews get a one-line "wants" digest.
- **Acts** on a timer via the policy engine — deterministic, unit-tested code, not an LLM
  reading rules: rerun flake-diagnosed CI, launch `/resolve-conflicts` on conflicts,
  `/address-review` on reviewer feedback, `/deep-review` drafts on new review requests,
  `/implement-ticket` on newly assigned tickets (pre-existing backlog never auto-launches).
  Difficulty is routed deterministically (tier → agent/model/effort table in
  `lib/config.js`), capped at 2 launches per pass and 6 per provider per 5 hours.
- **Runs sessions headlessly** as server-owned child processes in fresh worktrees under
  `~/.cache/inflight-worktrees/` — no Terminal windows. Each session has a live log, exact
  lifecycle (queued → running → staged/blocked/done/failed), a cancel button, and a
  "take over" command (`claude --resume <id>`) when you want to steer one interactively.
- **Stops at the human line**: sessions stage outward-facing actions (submitting reviews,
  posting replies) as one-click approvals; merging, Jira writes, and un-drafting PRs are
  never automated. Every action by anyone lands in the journal.

## Setup

1. Node 18+, an authenticated `gh` CLI, macOS (uses `caffeinate`/`osascript`).
2. Create a Jira API token at <https://id.atlassian.com/manage-profile/security/api-tokens>;
   copy `.env.example` to `.env` and fill in `JIRA_EMAIL` and `JIRA_API_TOKEN`.
3. `npm run setup` symlinks the bundled skills (implement-ticket, address-review,
   resolve-conflicts, deep-review, verify-review) into `~/.claude/skills` and
   `~/.codex/skills` — sessions invoke these.
4. Clone the repos you work on under `~/Projects` (or set `REPOS_DIR`).

## Run

```bash
npm run up      # server (caffeinate-wrapped: machine stays awake) + browser
npm run down    # stop everything, release the wake lock
npm run status  # server / engine / active-session health
```

The engine runs inside the server — no separate supervisor process, no browser tab
required for autonomy. The **autopilot** pill in the UI (or `AUTOPILOT=off`) switches the
engine to observe-only; manual launches always work. Launch buttons: **auto** routes by
difficulty tier; **claude**/**codex** force an agent (with optional model/effort overrides
in the Launch overrides panel); **copy** copies the prompt.

Headless sessions run with permission bypasses (see `agents.*.headlessArgs` in
`lib/config.js`) inside isolated worktrees — that is the deliberate autonomy trade. Set
`AUTONOMOUS=off` to build fully-gated interactive prompts instead.

## Layout

- `server.js` — HTTP API + engine timer (thin wiring)
- `lib/config.js` — every tunable: queries, routing table, budgets, agent invocations
- `lib/model.js` — pure domain logic (categorization, actions, tiers) — unit-tested
- `lib/policy.js` — the decision table as code: pure `decide()` + effects executor
- `lib/sessions.js` — headless session runner, worktrees, approvals, log rendering
- `lib/integrations.js` — Jira/GitHub fetchers + TTL cache
- `lib/diagnosis.js` — cached one-shot diagnosis runs
- `lib/state.js` — one persistent state file + append-only journal
- `skills/` — the agent skills sessions invoke (single source shared with teammates)

## Scope rules

- Read-only against Jira; GitHub writes are limited to what sessions do on your own
  branches, flake reruns, and the approvals you click.
- No config UI — constants live in `lib/config.js`.
- No history, charts, or analytics; current state only.
- A feature only gets added if it deletes a daily manual lookup.
