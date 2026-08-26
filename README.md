# inflight-dashboard

A single-page local dashboard for tracking in-flight work at a glance: all assigned Jira
tickets (including subtasks, which board views hide) joined to open GitHub PRs, sorted by
who's blocked.

## Sections

- **Needs you** — a PR has changes requested, real CI failures, merge conflicts, is a
  draft, or is approved with settled CI (ready to merge).
- **Waiting on others** — PRs awaiting review, or tickets sitting in a QA/review status
  with no open PR.
- **No open PR** — assigned tickets that haven't started (or whose PRs already merged).
- **Reviews requested of you** — other people's open PRs where your review is requested,
  oldest first.

PRs are linked to tickets automatically by extracting `PY-####` from the branch name and
PR title. PRs with no ticket key show up as their own rows so nothing goes missing.

Hovering a row reveals a **hide** control for items you don't need to track right now.
Hidden items move to a collapsed **Hidden** section at the bottom, where they can be
restored. Hides are held in server memory only — restarting the server clears them.

CI state is computed from individual check runs, not GitHub's rollup: the `QA Code Review`
human gate is ignored (it's red until a human approves), and a rerun of a flaky check
counts as passing if any run of that check name passed.

## Setup

1. Requires Node 18+ and an authenticated `gh` CLI (`gh auth status`).
2. Create a Jira API token at <https://id.atlassian.com/manage-profile/security/api-tokens>.
3. Copy `.env.example` to `.env` and fill in `JIRA_EMAIL` and `JIRA_API_TOKEN`.

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
