# inflight-dashboard

A local, read-only dashboard for ongoing work. It joins your assigned Jira tickets
(including subtasks boards hide) to your open GitHub pull requests and shows:

- work that needs your attention, including review feedback, CI failures, conflicts,
  merge-ready changes, and stalled CI;
- work waiting on reviewers or QA;
- assigned tickets and subtasks that do not have an open pull request yet;
- pull requests waiting for your review;
- work you have merged that is not in the last release yet; and
- unread GitHub notifications the board does not already show in full.

Pull requests awaiting review name the reviewer who has been sitting on them
longest — `awaiting @alice +1 · 4d` — so a stalled review says who to nudge. The
clock is the reviewer's own: a re-request restarts it.

Above the board sits a strip of two readings:

- **Sprint** — how much of your sprint scope is closed against how much of the sprint
  calendar is gone. The tick on the bar is the clock; the fill is the burn, so a fill
  behind the tick is scope running behind time.
- **Capacity** — how much of each coding agent's rate-limit window is spent, and when
  it rolls over.

`[SYSTEM]` in the masthead cycles the theme to `[LIGHT]` or `[DARK]` and remembers
the choice in the browser; `[SYSTEM]` follows the OS.

## Merged, not shipped

A repo's latest release tag is compared against its default branch, and the pull
request numbers in the intervening commit subjects (`… (#7502)`) are matched to your
merged pull requests. Comparing trees rather than merge timestamps is what makes this
exact — a timestamp says nothing about which commits a tag actually contains.

A repo with no releases has no answer to give, so it is named in a note under the
section rather than being quietly counted as fully shipped. The same goes for a
release gap deeper than the compare endpoint's 250-commit limit.

The dashboard only reads. It does not launch coding agents, create worktrees, rerun
CI, post reviews, update tickets, or otherwise act on the data it displays.
Hide/restore is a local display preference stored in the browser.

## Capacity probes

Each provider is probed independently and fails soft — one that is unreachable shows
its error in place of its bars and leaves the rest of the board alone.

- **Claude** reads the OAuth credential Claude Code already keeps in your login
  keychain (`Claude Code-credentials`) and calls the same `/api/oauth/usage` endpoint
  the CLI's own `/usage` command uses. The token is used for that one request and is
  never logged or stored. macOS asks once for permission to read the entry; denying it
  just greys out the Claude rows.
- **Codex** calls `account/rateLimits/read` on the Codex app-server protocol
  (`codex app-server` over stdio), which reads the limit live from the server. This has
  to be a live read rather than a local one: a single limit is shared by the CLI, the
  IDE extension and the ChatGPT desktop app, and the session logs under
  `~/.codex/sessions` only ever record the CLI's own traffic. A local reading goes
  stale — and silently understates you — the moment you work anywhere else. When a
  limit is spent, the server's reason (`workspace member credits depleted`) is printed
  under the bars, because 100% alone does not say whether the window is used up or the
  credits are gone.

To add a provider, add a probe to `PROVIDERS` in `lib/ai-usage.js` returning
`{ gauges, observedAt }`.

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
- `lib/model.js` — pure joining, categorization, sorting, sprint and inbox logic
- `lib/ai-usage.js` — AI capacity probes and their pure normalizers
- `index.html` — single-page dashboard UI
- `test.js` — domain and integration-mapping tests
