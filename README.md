# inflight-dashboard

A local, read-only dashboard for ongoing work. It joins your assigned Jira tickets
(including subtasks boards hide) to your open GitHub pull requests and shows:

- work that needs your attention, including review feedback, CI failures, conflicts,
  merge-ready changes, and stalled CI;
- work waiting on reviewers or QA;
- assigned tickets and subtasks with no open pull request yet, split by whether
  they are started or still queued;
- tickets you are Engineering Lead on that nobody has picked up;
- pull requests waiting for your review;
- work you have merged that is not in the last release yet;
- work someone has deliberately frozen.

Above the board sits one reading: how much of each coding agent's rate limit is
spent.

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
from done is never buried under what has barely started. Two things outrank
that. An urgent priority — `urgentPriorities`, P1 and above — because a P1 that
has barely started still beats a P3 one click from done; nothing below P1
reorders anything, since a board where every row carries a badge ranks nothing.
And the root of a blocked stack, because it is the single change that releases
everything queued behind it.

## Stacks

A pull request opened against another open pull request's branch cannot merge
until that one does, however green its own checks are. GitHub states the
relationship only as a base branch name, so the chain is rebuilt by matching
each base to the head it was opened from.

The chain matters more than any single row. Eleven approved, green pull requests
sitting on a twelfth that conflicts are not eleven pieces of good news, they are
one merge conflict — so everything below the root reads `blocked · behind #7392`
before anything else, and never claims to be ready for anything. The root states
what is riding on it (`stack root · 11 behind`) and sorts to the top of its
section. In the board, a whole blocked chain folds into one line naming the
change to fix; the rows stay one click away.

Waiting on the change underneath is position, not a defect — treating it as one
would move every row of a stack into your move at once. A base whose pull
request has already merged reads as unstacked rather than blocked forever, since
GitHub retargets those to the default branch shortly.

## In progress, to do, and unowned

Work with no pull request yet answers three different questions, so it gets
three sections rather than one queue that mixes them. **In progress** and
**To do** split on Jira's status *category*, not the status name, which every
board is free to rename; a draft pull request counts as started work and sits
with the rest of what is in progress.

**Needs an owner** is tickets you are Engineering Lead on that nobody has been
assigned — yours to answer for, and invisible to an assignee-scoped board.
Deliberately not the wider "you lead it, someone else has it": that is their
work, not a queue of yours, so the query is `assignee IS EMPTY` rather than
`assignee != currentUser()`.

That one needs a window or it becomes a junk drawer. Unbounded it returns
every ticket you were ever named on and nobody picked up, most of them years
stale; scoped to the open sprint it returns nothing, because these get groomed
a sprint or more ahead of being worked. `leadUnassignedLookbackDays` — sixty
days, roughly four sprints — is the middle that keeps the live ones.

## Holds

Work someone has deliberately frozen states it in the summary — `(HOLD MERGE)
Remove the legacy navigation` — or carries one of `holdLabels`. A hold outranks
every green signal underneath it: the row keeps its real signals but leaves your
move for the held lane, because a frozen change reading `ready to merge` at the
top of the board is the one error that costs more than showing nothing.

## How long, not just what

`updated` moves on every comment, label and bulk grooming edit, so it cannot say
how long something has sat in QA. The changelog can — the newest status
transition is when the current status began. That is what turns
`approved · awaiting QA` from a state into a decision: `approved · awaiting QA ·
6d` is worth chasing, and the same label at `0d` is not. A QA queue is slower
than a review queue, so it gets a longer fuse before the same amber.

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

## The next action

A row that has one names its next action as a prompt, ready to paste into Claude
Code. The button says which skill it is rather than "copy", because the name is
the thing worth knowing before you click:

| Row | Action |
|---|---|
| Review feedback outstanding — changes requested, open threads, or bot findings | `/address-review` |
| Conflicts with its base | `/resolve-conflicts` |
| Failing build | a prompt, since no skill covers this one |
| Assigned ticket with no pull request | `/implement-ticket` |
| A review someone asked of you | `/deep-review`, or `/verify-review` once you have reviewed it |

Feedback outranks the rest: it is the only one of the three another person is
waiting on, and answering it usually lands the commits that clear the others.

Prompts are built only from validated pull request numbers and ticket keys,
never from titles or branch names. The repo is always stated, because the skills
default it to whatever repo the shell is sitting in and a prompt copied off this
board gets pasted wherever the reader is, not where the work is.

Silence is a real answer. Work that is waiting on a reviewer, queued for QA,
merged and waiting on a release, or held offers nothing, because a wrong prompt
costs more than an absent one. Held work offers
nothing however actionable it looks — that is the same mistake as ranking it top
of the board, one click further along. Drafts offer nothing either: a draft
carries its problems as signals but never becomes anyone's move.

The dashboard only reads. It does not launch coding agents, create worktrees, rerun
CI, post reviews, update tickets, or otherwise act on the data it displays. Copying
a prompt puts it on your clipboard and stops there — whether it runs is your call.
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

The browser refreshes every five minutes. Jira and GitHub responses are cached for one,
which has to stay well under that: set equal to the refresh interval, the two clocks
drift out of phase and a scheduled poll can land just inside the cache window, receive
data already nearly five minutes old, and then hold it for five more — the masthead
reads "updated 9m ago" on a board that believes it refreshes every five minutes. The
cache is only there to collapse bursts (several tabs, a manual reload, the refresh that
fires when a hidden tab is focused again), so a minute covers it and every scheduled
poll still fetches fresh. The last good response remains visible if either service is
temporarily unavailable.

## Layout

- `server.js` — read-only HTTP API and static UI server
- `lib/config.js` — Jira/GitHub queries and display categorization settings
- `lib/integrations.js` — Jira/GitHub fetchers and TTL cache
- `lib/model.js` — pure joining, categorization, stacks, holds, and sorting logic
- `lib/ai-usage.js` — AI capacity probes and their pure normalizers
- `index.html` — single-page dashboard UI
- `test.js` — domain and integration-mapping tests
