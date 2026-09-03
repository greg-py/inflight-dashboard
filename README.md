# inflight-dashboard

A local, read-only dashboard for ongoing work. It joins your assigned Jira tickets
(including subtasks boards hide) to your open GitHub pull requests and shows:

- work that needs your attention, including review feedback, CI failures, conflicts,
  merge-ready changes, and stalled CI;
- work waiting on reviewers or QA;
- assigned tickets and subtasks that do not have an open pull request yet;
- pull requests waiting for your review; and
- recently merged pull requests associated with assigned tickets.

The dashboard only reads Jira and GitHub. It does not launch coding agents, create
worktrees, rerun CI, post reviews, update tickets, or otherwise act on the data it
displays. Hide/restore is a local display preference stored in the browser.

## Setup

1. Install Node 18+ and authenticate the `gh` CLI.
2. Create a Jira API token at
   <https://id.atlassian.com/manage-profile/security/api-tokens>.
3. Copy `.env.example` to `.env` and fill in `JIRA_EMAIL` and `JIRA_API_TOKEN`.

## Run

```bash
npm start
```

Open <http://localhost:4477>, and press Ctrl-C in the terminal when you are done.

The browser refreshes every three minutes. Jira and GitHub responses are cached for two
minutes, and the last good response remains visible if either service is temporarily
unavailable.

## Layout

- `server.js` — read-only HTTP API and static UI server
- `lib/config.js` — Jira/GitHub queries and display categorization settings
- `lib/integrations.js` — Jira/GitHub fetchers and TTL cache
- `lib/model.js` — pure joining, categorization, and sorting logic
- `index.html` — single-page dashboard UI
- `test.js` — domain and integration-mapping tests
