# inflight-dashboard

A single-page local dashboard for tracking in-flight work at a glance: all assigned Jira
tickets (including subtasks, which board views hide) joined to open GitHub PRs, sorted by
who's blocked.

## Sections

- **Needs you** — a PR has changes requested (and you haven't pushed fixes yet), real CI
  failures, merge conflicts, is a draft, or is approved with settled CI and the next move
  is yours ("ready to merge", or "move to QA" for pre-QA statuses like `In Code Review`).
- **Waiting on others** — PRs awaiting review, changes-requested PRs where you've already
  pushed fixes ("changes pushed · awaiting re-review" — detected by the last commit being
  newer than the latest changes-requested review), tickets sitting in a QA/review status
  with no open PR, or QA-held tickets (`Ready To Test`, `In Testing`) whose PR is
  approved and green — QA holds the merge gate there, so the PR shows
  "approved · awaiting QA". PR defects always outrank the QA hold.
- **In development** — assigned tickets with no PR of their own: not started, in progress,
  or already merged. A subtask being worked on its parent ticket's branch (the standard
  subtask workflow) shows "on parent PY-XXXX · #NNNN" linking to the parent's PR — the
  reference is display-only, so the branch's CI/review signals appear once, on the
  parent's row.
- **Reviews requested of you** — other people's open PRs where your review is requested,
  oldest first. A request where you already have a review on record is marked
  "re-requested" and launches `/verify-review` instead of `/deep-review`.

PRs are linked to tickets automatically by extracting `PY-####` from the branch name and
PR title. PRs with no ticket key show up as their own rows so nothing goes missing.

Subtasks never roll up: a QA bug or design subtask assigned to you is its own row with
its own categorization, and its parent keeps the categorization derived from the parent's
own PRs and status. One piece of work, one row.

Hovering an actionable line also reveals **launch controls**: the derived agent action
(`implement` → `/implement-ticket`, `address review` → `/address-review`,
`resolve conflicts` → `/resolve-conflicts`, `fix CI`, `review` → `/deep-review`) with
`claude` / `codex` buttons that open a new Terminal window with the prompt pre-filled,
and a `copy` button that copies the prompt to the clipboard instead.

Every launch runs in a **fresh git worktree**, never the main checkout: the terminal
fetches origin, creates a worktree under `~/.cache/inflight-worktrees/<repo>/` detached
at the latest `origin/<default branch>` (detected per repo), and starts the agent there —
so agents always begin from up-to-date master/main and check out PR branches themselves.
Clean worktrees older than 72h are pruned on the next launch; dirty ones are never
touched.

Sessions launch with each CLI's own configured default model and reasoning effort. The
topbar shows a model and effort selector per agent with the config default pre-selected
(read from `~/.claude/settings.json` and `~/.codex/config.toml`); picking a different
value passes `--model`/`--effort` (claude) or `-m`/`-c model_reasoning_effort=…` (codex)
for that session only. Selectable values are whitelisted constants in `server.js`.

The dashboard's skill prompts work in both agents: `npm run setup` symlinks the bundled
skills into `~/.claude/skills/` and `~/.codex/skills/`, so claude and codex load the same
definitions.

Prompts are built server-side from validated ticket keys and PR numbers only. Repos
resolve to `REPOS_DIR/<name>` (default `~/Projects`); agent commands and model whitelists
are constants in `server.js`. The server binds to 127.0.0.1 only.

Hovering a row reveals a **hide** control for items you don't need to track right now.
Hidden items move to a collapsed **Hidden** section at the bottom, where they can be
restored. Hides are held in server memory only — restarting the server clears them.

CI state is computed from individual check runs, not GitHub's rollup: the `QA Code Review`
human gate is ignored (it's red until a human approves), and a rerun of a flaky check
counts as passing if any run of that check name passed.

## Setup

Everything is per-user: the dashboard reads *your* Jira assignments and *your* GitHub PRs
based on the credentials you provide. Requirements: macOS (launch buttons drive
Terminal.app), Node 18+, an authenticated `gh` CLI (`gh auth status`), Claude Code
(`claude`), and optionally Codex (`codex`).

1. Clone this repo and run `npm run setup` — it symlinks the bundled skills
   (`implement-ticket`, `address-review`, `resolve-conflicts`, `deep-review`,
   `verify-review`) into `~/.claude/skills/` and `~/.codex/skills/` so the launch prompts
   work in both agents. Skills you already have are left untouched; symlinks mean
   `git pull` updates them in place.
2. Create a Jira API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
3. Copy `.env.example` to `.env` and fill in `JIRA_EMAIL` and `JIRA_API_TOKEN`. If your
   repos aren't cloned under `~/Projects/<name>`, set `REPOS_DIR`.

## Run

```bash
npm start
```

Open <http://localhost:4477> and pin the tab. It refreshes every 2 minutes and on tab
focus. Tokens never leave the server process — the browser only talks to localhost.

```bash
npm test
```

## Scope rules

This tool stays small on purpose. Baked-in constraints:

- Read-only against Jira and GitHub. The only local state is hide/restore, kept in
  server memory.
- No config UI, no filters, no tabs, no search. The two queries and the noise lists are
  constants at the top of `server.js`.
- No history, charts, or analytics — current state only.
- A feature only gets added if it deletes a daily manual lookup.
