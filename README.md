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
| Merge | READY TO MERGE | you | always, unless stacked on a parent not yet at Merge |
| Ship | Done, merged after the latest tag | you | until the next release |

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

- **Reviews** — PRs requesting your review, and ones you asked changes on that have moved, are your move.
- **Pod** — Street Sharks tickets in the open sprint with no assignee are yours to assign; approved-but-not-moved, READY TO MERGE for a day, or no reviewer list under Waiting, named for their owner.
- **Release** — your merges since the latest tag are yours to release; everyone's fold under Unreleased.
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

The rules live in `lib/ledger.js` and are pinned by `test/ledger.test.js`.
