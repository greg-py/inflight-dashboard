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
- work someone has deliberately frozen;
- draft prototypes nobody has touched in weeks, out of the way.

## Layout

The board reads top to bottom as *mine, then everyone's, then nobody's*:

- **Your move** is a tray of cards across the top — every row the model puts in
  `needs_you`, plus reviews someone asked of you. Each card leads with its stage,
  carries every signal, and ends in the skill that does the next step.
- **In flight** is the workflow drawn left to right: To do, Building, Review, QA,
  Merge, and Unreleased. Everything waiting on someone else, being built, queued,
  or unowned rides the column its Jira status puts it in (`STAGE_OF_STATUS` in
  `index.html`); merged-not-released is the sixth stage. A card keeps what is
  wrong (tags) apart from who owes the next move and for how long (the line at
  its foot), since those need different responses. The six stages sit side by
  side from 1360px, where a card still fits the longest skill name; narrower,
  they wrap into rows of three, then two, in order, and on a phone they become
  a strip to swipe. The page itself never scrolls sideways.
- **Held**, **Parked** and **Hidden** sit folded on the shelf at the bottom.

Where each model section is drawn lives in `PLACEMENT`; a section it has never
heard of falls back to the pipeline rather than vanishing.

## Signals

Every row states both what is wrong and where the review stands, because those
need different responses: `CI failing · approved` is one fix from shipping,
`CI failing · awaiting @alice · 4d` is a fix and then a wait.

Waiting work names who owes the next move. `awaiting @alice +1 · 4d` is a first
review, timed from the request — a re-request restarts that reviewer's clock.
`re-review @alice · 1d` is feedback you have already answered, timed from the
push that answered it rather than from the original request.

Two states have nobody on the hook, so both are your move at any age: unlike a
slow reviewer, they never resolve on their own. `no reviewer requested · 9d` is
a pull request nobody was ever asked to review, timed from when it was marked
ready. `re-request @alice · 1d` is one somebody reviewed and nobody has asked
again: submitting any review — a comment-only one included — takes a reviewer
off GitHub's requested list, and nothing but a re-request puts them back. So a
reviewer who left comments you then answered and pushed for is not waiting on
anything; they are waiting to be asked.

Pushes are timed from when the commit reached GitHub — the earliest of its
check suites — not from the commit's own date, which can be days older.

`approved · ready to merge` is a claim about the whole pull request, so anything
red withdraws it and the row falls back to a plain `approved`. Approved work
held by QA reads `approved · awaiting QA` while it is queued and `approved · in
QA` once testing has started. Which of those an approval reads as depends on the
ticket, so pull requests are categorized against the ticket they are attached
to.

Checks that stay red until a person acts (`QA Code Review`, `Check removed test
IDs against QA`) are listed in `noisyChecks` and never count as a broken build —
they say something about QA's backlog, not about the branch. The QA gate is
still read from the check the CI verdict ignores, which is what makes
`QA passed · ready to merge` meaningful. The enforcer passes every draft without
looking at it, so a draft has no gate verdict at all.

`CI stuck 5h` is timed from when the oldest pending check began waiting, not
from the commit: a commit written in the morning and pushed in the afternoon is
running, not stuck.

Runs pile up on a commit — a re-run, a workflow triggered again by a review —
and only the newest describes the branch as it stands, so each check is judged
by its newest run: a failure that has been re-run reads `CI running`, not
`CI failing`. A check is its workflow as well as its name, since two workflows
can each have a job of the same name and one passing must not hide the other
failing. The QA gate reads its newest run the same way: the enforcer re-reads
every QA comment and review each time it runs, so an approval arrives as a
fresh passing run while the failures from before it stay listed on the commit.

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
  forever is what makes a thread count worth ignoring. That holds for a bot's
  finding as much as a person's.
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
their real problems as signals but never become anyone's move. `draft · 17d`
says how long since anyone pushed to one.

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
section. In the pipeline, two or more changes blocked behind the same one fold
into one line naming the change to fix; the cards stay one click away.

A chain can start on someone else's open pull request, which the board never
fetched as one of yours, so each pull request also asks whether its base branch
has an open pull request of its own. One opened on a colleague's branch reads
`blocked · behind @justin #760` rather than claiming it is ready to merge into a
branch that is not the default.

Waiting on the change underneath is position, not a defect — treating it as one
would move every row of a stack into your move at once. A base whose pull
request has already merged reads as unstacked rather than blocked forever, since
GitHub retargets those to the default branch shortly.

## In progress, to do, and unowned

Work with no pull request yet answers three different questions, so the model
gives it three sections rather than one queue that mixes them. On the board,
in progress is the Building column, to do is the To do column, and unowned work
sits in To do too, badged `no owner` so it never reads as yours. **In progress** and
**To do** split on Jira's status *category*, not the status name, which every
board is free to rename. A status that hands the ticket to someone else —
`waitingStatuses`: design review, code review, QA, READY TO MERGE, or a CSM bug
that needs clarification — puts it under waiting instead.

A ticket whose pull requests are all drafts goes wherever its status puts it,
exactly like one with none, because drafts are never anyone's move and the
status is the deliberate signal. Research handed over as READY TO MERGE with its
prototype still a draft is waiting, not being built; a draft moved back to TO DO
while a decision is pending is queued.

A draft with no ticket of yours has no status to go by, so idleness decides:
one nobody has pushed to for `parkedDraftDays` (fourteen) is **Parked**, folded
on the shelf at the bottom of the board. One that carries someone else's
ticket key, or a finished one, still links it.

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
Remove the legacy navigation`. Labels are not read: no PY ticket has carried a
hold label in the past year, while the summary marker is on dozens. A hold outranks
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

A review requested of you reads `asked 2d`, timed from the newest request
naming you (or a team of yours), not from when the pull request was opened.

The half-filled circle in the masthead cycles the theme to light (sun) or dark
(moon) and remembers the choice in the browser; the circle follows the OS. Every
colour is one `light-dark()` token, so the two themes cannot drift apart.

## Merged, not shipped

A repo's latest release tag is compared against its default branch, and the pull
request numbers in the intervening commit subjects (`… (#7502)`) are matched to your
merged pull requests. Comparing trees rather than merge timestamps is what makes this
exact — a timestamp says nothing about which commits a tag actually contains. Only
the subject line counts: a squash commit's body lists the branch's own commits, and
a number quoted there is a mention, not a merge.

A stacked pull request is judged by its own number first. The stacks here are
merged bottom-up by tooling that lands each change on the default branch as its own
squash commit (`… (#7575)`), even though GitHub records it as merged into its
parent's branch. Only when its own number is not in the gap is the chain followed,
the way open stacks are rebuilt: a change merged by hand into another's branch
reaches the default branch inside that one's squash commit, so it ships when the
change it was merged into does — or, while that one is still open, has not reached
the default branch at all.

Repos in `deployOnMergeRepos` (Logan) deploy every merge to master on their own and
cut no releases, so a merge there is shipped and never listed.

A repo with no releases has no answer to give, so it is named in a note under the
section rather than being quietly counted as fully shipped. The same goes for a
release gap deeper than `releaseGapCommitLimit`, and for a stacked change whose
chain leads to a branch this board never saw (`2 stacked untraced`). The note shows
whether or not the section has rows: "everything merged is released" above a repo
the board could not check would be exactly the claim it must not make. A lookup that
fails is a different thing from a repo that never released: it keeps that repo's
last answer, and says `release lookup failed` only when there is none.

## The next action

Every row a skill can take carries one as a prompt, ready to paste into Claude
Code, in every section — waiting, held, parked and drafts included. The section
says whose move it is; the button is there for when you want to run the skill
anyway. It says which skill it is rather than "copy", because the name is the
thing worth knowing before you click. The first row that matches wins:

| Row | Action |
|---|---|
| Review feedback outstanding — changes requested, open threads, or bot findings | `/address-review` |
| Conflicts with its base | `/resolve-conflicts`, with `--stack` when the change sits in a stack |
| Failing build, or CI stuck for hours | `/fix-ci`, with `--stack` when the change sits in a stack |
| Clean pull request whose ticket is in QA, or approved and ready to send there | `/qa-guide` on the ticket |
| Any other clean pull request | `/deep-review`, which on your own pull request fixes what it finds |
| Assigned ticket with no pull request | `/implement-ticket` |
| Ticket whose pull request has merged | `/qa-guide` |
| A bug you lead that nobody owns | `/diagnose-bug` |
| Any other ticket you lead that nobody owns | `/jira-ticket-groomer` — again, once groomed, to bring the notes up to date |
| A review someone asked of you | `/deep-review`, or `/verify-review` once you have reviewed it |
| Merged, not shipped (on the section) | `/production-release check` |

A stacked change's conflict or red build is never only its own: the fix has to reach
every pull request after it, so the prompt asks the skill to work the whole stack.
A ticket you lead that nobody owns is not yours to implement; your move as its lead is
to find a bug's cause or to groom the rest.

The masthead also carries the recurring prompts that need no row — `/standup-prep`,
`/weekly-pod-update` and `/sprint-retro-brainstorm` for the pod in `CONFIG.pod`. Skills
that need something only you know (who asked, what to query, what to file) are not
offered: there is nothing on the board to build their prompt from.

Feedback outranks the rest: it is the only one of the three another person is
waiting on, and answering it usually lands the commits that clear the others. A
problem outranks the ticket's stage — a red build in QA still goes to `/fix-ci`.

Prompts are built only from validated pull request numbers and ticket keys,
never from titles or branch names. The repo is always stated, because the skills
default it to whatever repo the shell is sitting in and a prompt copied off this
board gets pasted wherever the reader is, not where the work is.

A ticket row that has an open pull request offers nothing of its own: the skill
is on the pull request's line. Merged, not shipped is asked once for the whole
section, since a release check is about the repo rather than any one change.

The dashboard only reads. It does not launch coding agents, create worktrees, rerun
CI, post reviews, update tickets, or otherwise act on the data it displays. Copying
a prompt puts it on your clipboard and stops there — whether it runs is your call.
Hide/restore is a local display preference stored in the browser. A row remembers
the state it was hidden in and comes back by itself when that changes — hidden while
waiting on a reviewer, it reappears when the reviewer asks for changes.

## Upstream calls

GitHub allows a GraphQL request roughly ten seconds. Asking for every pull
request's checks, threads and review timeline in one call sat right on that
edge — slow on a good day and a 504 on a bad one — so the same work runs as
parallel calls that each stay well inside the limit, joined by repo and pull
request number. The checks get a call of their own, because telling one
workflow's job from another's with the same name costs about as much as
everything else about the pull request put together.

Every call has a deadline (`upstreamTimeoutMs`), so one that hangs cannot hold
the shared refresh, and every open tab, for minutes. Gateway failures, dropped
connections and calls past their deadline are retried once (`upstreamRetries`)
before anything reaches the banner, since they are nearly always momentary.
Searches page past GitHub's fifty-result limit rather than stopping at it.

Payloads are kept to what the board reads. Release gaps come from GraphQL, not
the REST compare, which returns every changed file's patch — over a megabyte for a
day's gap. Jira's changelog, which only ever feeds a QA wait's age, is fetched
for the tickets in QA alone and for status changes only, rather than expanded on
every ticket, which made the search thirteen times heavier.

A gateway failure returns an HTML error page rather than JSON. Banners report
the status and, where the body actually says something, a short reason from it —
never the page source.

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
- `index.html` — single-page dashboard UI
- `test.js` — domain and integration-mapping tests
