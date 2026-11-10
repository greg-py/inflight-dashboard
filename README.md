# Inflight

A local board for in-flight work, as two plain lists. **Your move** on the
left: one line per thing to do, verb first, oldest trigger on the right.
**Waiting on others** on the right, grouped by Jira status, closest to
shipping first, each naming who has it. Held work, parked drafts, tickets
outside the sprint and merges not yet released fold away underneath.

Every ticket's stage comes from its Jira status, cross-checked against
GitHub, and exactly one person owns the next move.

```bash
npm start      # http://localhost:4477 (PORT to override)
npm test
```

`npm start` restarts the server when a source file changes, so the page never
shows the rules of an older version of the code.

`.env` needs `JIRA_EMAIL` and `JIRA_API_TOKEN`. GitHub uses `gh auth token`
unless `GITHUB_TOKEN` is set. No dependencies.

## UI

The page is plain HTML on [Basecoat](https://basecoatui.com) — shadcn/ui's
components as HTML classes, with no framework and no build step. Its
stylesheet and script load from jsDelivr, pinned to `basecoat-css@1.1.0` with
integrity hashes; bump both together. Rows are Basecoat `item`s, counts and
owners `badge`s, actions `btn`s, the folds an `accordion`, and copies a
`toast`. Every color is a Basecoat token, so light and dark follow the system
until the moon button picks one. Each component's docs are available as
Markdown for agents: `https://basecoatui.com/components/<name>.md`.

## Whose move

| Stage | Jira | Ball | Your move when |
|---|---|---|---|
| To do | TO DO | you | in the open sprint; a Bug Sub-task; a CSM bug in READY |
| Build | In Progress | you | always |
| Review | In Code Review | reviewer | engineering approval → move to Ready To Test; conflicts, red CI, changes requested, unanswered threads; nobody requested; reviewed and not re-requested; no review after 2 business days |
| QA queue | Ready To Test | QA | the PR still lacks an engineering review |
| Testing | In Testing | QA lead | a Bug Sub-task of yours is open on it |
| Merge | READY TO MERGE | you | always, unless any PR beneath it in the stack is not yet at Merge |

**Engineering approval** is the latest APPROVED review from a member of the
`engineering` team whose body carries no QA marker (`QA:OK`, `QA:APPROVED`,
`:koala:`, 🐨). QA approves with real reviews, so GitHub's own review
decision cannot tell the two apart. doug-py is on both teams; the marker
decides.

**Drift** is Jira and GitHub disagreeing about the stage — an approved PR on
a ticket still in code review, a PR open for review on a ticket still In
Progress, a draft on a ticket at READY TO MERGE. It is always your move. An
engineering-approved PR agrees with any Jira stage from QA queue to Merge,
since GitHub cannot see QA's progress.

A ticket is only as far along as its least-advanced open PR. Stacks are
rebuilt from base and head branches, across authors: a PR that passed QA but
sits on someone else's open PR waits on that PR. Titles carrying `(HOLD …)`
or `(ON HOLD)` go to the shelf.

A Bug Sub-task QA files is your move on its own line; its parent waits on it.
Routine sub-tasks (nothing to do but start or build them) fold into their
parent's line as a count by status.

## Beyond your own tickets

- **Reviews** — every open PR in the organization that you review has one row until you approve it. A PR requesting your review, by name or through a team you are on, is your move. So is one that moved after you requested changes, or after you commented on a PR that asked for your review. Until the author pushes, it lists under Waiting, named for the author. When the PR belongs to a ticket of yours, the ticket's row carries the review.
- **Pod** — Street Sharks tickets in the open sprint with no assignee are yours to assign; approved-but-not-moved or READY TO MERGE for a day list under Waiting, named for their owner. A teammate's ticket is never your move once it has an assignee.
- **Release** — you run releases, so anything merged since the latest tag is one Release move, naming which merges are yours; the commits fold under Unreleased.
- **Grooming** — tickets you lead whose Engineering tab is empty, updated in the last 60 days.
- **Shelf** — held work and drafts idle for 14 days.

## Slack, meetings and calendar

These have no local credentials. Anything that writes
`~/.claude/inflight/context.json` feeds the Owed and Calendar panels:

```json
{
  "generatedAt": "2026-11-04T14:00:00Z",
  "owed": [{ "who": "Matt", "what": "Super User Accounts sandbox on new nav", "since": "2026-11-02T15:00:00Z", "url": "https://…" }],
  "calendar": [{ "start": "2026-11-06T17:00:00Z", "title": "Subtasking + Grooming", "prep": "jira-ticket-groomer" }]
}
```

## Code

- `lib/jira.js`, `lib/github.js`, `lib/local.js` fetch and normalize each source.
- `lib/ledger.js` turns tickets and PRs into rows, one owner each. It is pure,
  and `test/ledger.test.js` pins every rule.
- `lib/board.js` puts the sources and the ledger together into the page's data.
  If Jira or GitHub fails, it keeps that source's last good answer and says so.
- `server.js` serves the page and the board, answering from a warm cache.
- `lib/config.js` holds every PerformYard-specific value.

Each row the page receives is `{ key, title, url, status, lane, heading,
waitingOn, next, prs, chips, ageMs }`: `lane` is `mine`, `waiting`, `shelf` or
`later`; `next` is a skill to copy or a page to open. `url` opens the row's Jira ticket,
or its pull request when it has no ticket. Every pull request is linked among
the row's facts, and the page links every ticket key and PR number it shows.
