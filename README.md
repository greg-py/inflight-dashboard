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

## Signals

Every row states both what is wrong and where the review stands, because those
need different responses: `CI failing · approved` is one fix from shipping,
`CI failing · awaiting @alice · 4d` is a fix and then a wait.

Waiting work names who owes the next move. `awaiting @alice +1 · 4d` is a first
review, timed from the request — a re-request restarts that reviewer's clock.
`re-review @alice · 1d` is feedback you have already answered, timed from the
push that answered it rather than from the original request. `no reviewer
requested · 9d` means nobody is on the hook at all, which is flagged at any age:
unlike a slow reviewer, it will never resolve on its own.

`approved · ready to merge` is a claim about the whole pull request, so anything
red withdraws it and the row falls back to a plain `approved`. Approved work
held by QA reads `approved · awaiting QA` while it is queued and `approved · in
QA` once testing has started.

Checks that stay red until a person acts (`QA Code Review`, `Check removed test
IDs against QA`) are listed in `noisyChecks` and never count as a broken build —
they say something about QA's backlog, not about the branch. The QA gate is
still read from the check the CI verdict ignores, which is what makes
`QA passed · ready to merge` meaningful.

## Review threads

An unresolved thread is only worth showing if it still wants something from you,
so each one is classified before it is counted:

- **resolved** — marked resolved on GitHub. Done however it reads.
- **answered** — the last word is yours. Replying "fixed in 028e480" is the
  normal way feedback closes here, and it counts whether or not anyone ticks the
  thread. This is the common case by a wide margin.
- **praise** — the comment explicitly asks for nothing. Reviewers label with
  Conventional Comments, in italics (`_praise_`) or bold (`**nit:**`,
  `**issue (blocking):**`), so the label is read rather than guessed. Only the
  leading word counts, and only a recognised one: an unlabelled comment is
  actionable, which is the safe way to be wrong. `nonActionableLabels` holds the
  set that asks for nothing.
- **stale** — the code the comment was anchored to has changed since. The fix
  nearly always went in without anyone marking the thread, and chasing these
  forever is what makes a thread count worth ignoring.
- **bot** — counted separately. Bots review every push, often after an approval,
  and their findings need their own triage.
- **low** — a codex finding badged below P1. Codex stamps every finding with a
  priority, as the alt text of a shields.io badge ahead of the title, and the
  team triages P1 only; `codexActionablePriorities` holds the set that counts.
  These drop out rather than falling through to **open**, so a pull request
  whose only outstanding findings are P2 is nobody's move. The gate is keyed on
  the bot that opened the thread: CodeQL, cursor and claude do not use the
  priority scheme at all and are counted exactly as before. Two deliberate
  escapes — a badge that does not parse reads as no badge and keeps the finding
  (if the format moves, the board over-reports rather than going silent), and a
  human reply makes the thread a person asking for something, classified on that
  whatever codex badged it.
- **open** — everything else, and the only kind that reaches a row.

Threads survive approval. A reviewer who approves and leaves notes inline still
left notes, and those show as `6 open follow-ups` — worth doing before the
merge, but not the blocker that `6 open threads` on an unapproved pull request
would be.

Feedback counts as addressed when commits land after the changes-requested
review — unless a thread was opened after that push, which no push can have
answered. Draft pull requests are unfinished rather than defective: they carry
their real problems as signals but never become anyone's move, and they sit in
the development queue until they are marked ready.

Within a section, work sorts closest-to-shipping first, so what is one action
from done is never buried under what has barely started.

Above the board sits one reading:

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

## Upstream calls

GitHub allows a GraphQL request roughly ten seconds. Asking for every pull
request's checks, threads and review timeline in one call sat right on that
edge — slow on a good day and a 504 on a bad one — so the same work runs as
parallel calls that each stay well inside the limit, joined by pull request
number. Gateway failures are retried once (`upstreamRetries`) before anything
reaches the banner, since they are nearly always momentary.

A gateway failure returns an HTML error page rather than JSON. Banners report
the status and, where the body actually says something, a short reason from it —
never the page source.

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
- `lib/model.js` — pure joining, categorization, sorting, and inbox logic
- `lib/ai-usage.js` — AI capacity probes and their pure normalizers
- `index.html` — single-page dashboard UI
- `test.js` — domain and integration-mapping tests
