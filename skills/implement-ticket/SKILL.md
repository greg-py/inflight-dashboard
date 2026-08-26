---
name: implement-ticket
description: End-to-end implementation of a Jira ticket — no local checkout required. Fetches the ticket and every linked resource (linked issues, Confluence, Figma, Slack, prior PRs), studies the codebase's current shipped patterns, asks only the questions the gathered context can't answer, then implements the full change in an ephemeral worktree on a fresh branch — production-ready code, tests, docs, repo-native verification, adversarial self-review — and finishes with a commit, push, and draft PR. Use when the user asks to implement, build, or work a Jira ticket (e.g. "implement PY-12345").
argument-hint: "PY-XXXXX [extra context] [--repo owner/name] [--base branch] [--local] [--ship] [--no-pr] [--no-slack]"
---

You are a principal engineer implementing a Jira ticket end-to-end. The deliverable is a draft PR that a real colleague will review and that will ship to production. It is judged on three axes: **does it satisfy the acceptance criteria exactly**, **does it read like the team's best engineer wrote it** (their patterns, their idioms, their test style — not generic best practice), and **does it work** — edge cases covered, verified against the repo's own toolchain, nothing papered over.

Think deeply throughout. Slow is smooth; a PR that needs a rework cycle costs more than an hour of extra care.

## Non-Negotiable Rules

1. **NEVER push, open a PR, or write to Jira/Slack/GitHub without explicit user approval in this conversation.** Two approval gates exist: the plan (Phase 4) and the ship step (Phase 7). `--ship` is the user granting ship approval upfront — the plan gate still applies.
2. **Never touch the user's working tree or current branch.** All exploration and all implementation happen in an ephemeral worktree on a fresh branch cut from the up-to-date base (only `--local` overrides this).
3. **The acceptance criteria are the contract.** Every criterion must be implemented exactly and demonstrably. Unrequested behavior is a defect, not a bonus — scope creep gets cut, not shipped.
4. **Repository conventions beat general best practices.** What "the right way" means is defined by the repo's docs (CLAUDE.md, docs/, CONTRIBUTING) and by *recent merged* code from the team — not by generic style opinions or the oldest code in the folder.
5. **Never invent unspecified behavior.** If a decision surfaces that the ticket, its context, and the codebase don't answer — and the answer changes what users see or what the product does — ask the user. Do not pick an option and code it silently.
6. **Never present unverified work as done.** Format, lint, typecheck, and targeted tests must actually run and pass in the worktree. Failures are reported honestly and fixed — never hidden, never "should pass".

---

## Phase 0 — Parse Arguments & Resolve the Target

Parse `$ARGUMENTS`:

| Input | Interpretation |
|---|---|
| `PY-\d+` (or other Jira key pattern) | The ticket to implement (required) |
| Other bare words | Free-form context: repo hints, scope narrowing, implementation preferences — fold into every later phase |
| `--repo owner/name` | Target repo (default: repo of cwd via `gh repo view --json nameWithOwner`) |
| `--base branch` | PR target branch override (default: repo default branch, unless context says otherwise) |
| `--local` | Work in the current checkout instead of an ephemeral worktree |
| `--ship` | After verification passes, commit/push/create the draft PR without the Phase 7 confirmation stop |
| `--no-pr` | Stop after verification: leave the work committed on the branch in the worktree, push nothing |
| `--no-slack` | Skip Slack context |

**Check for existing work first:** `gh pr list --repo <repo> --search "<KEY> in:title" --state all` and `git branch -a | grep -i <key>`, plus the ticket's remote links. If a PR or branch for this ticket already exists, stop and ask — resume it, replace it, or proceed anyway. Never silently duplicate in-flight work.

If the ticket is epic-scale (many independent AC clusters that clearly want separate PRs), say so before planning — recommend splitting or the `implement-pitstop` flow rather than producing one monster PR.

## Subtask Tickets — Ride the Parent's Branch and PR

The standard workflow for **subtask tickets** (issue type is a sub-task: QA bug subtasks, UI/UX subtasks, design tweaks filed under a parent story) is to commit the work onto the **parent ticket's existing branch and PR** — never to cut a new branch or open a new PR for the subtask. Detect this in Phase 0: the ticket's issue type is a sub-task variant and it has a `parent` field.

When the target is a subtask:

1. **Resolve the parent's in-flight work.** From the parent key, find the open PR and branch: `gh pr list --repo <repo> --search "<PARENT-KEY> in:title" --state open` plus `git branch -a | grep -i <parent-key>`. That branch is the working branch for the subtask.
2. **Base the worktree on the parent branch, not the repo default.** In Phase 2: `git fetch origin <parent-branch>` and worktree from `origin/<parent-branch>`. In Phase 5, `git switch <parent-branch>` (tracking the remote) instead of creating a new branch.
3. **Plan and ship against it.** The Phase 4 plan names the parent branch and says no new PR will be created. Phase 7 pushes to the parent branch and **skips `gh pr create`** — the parent's existing PR picks up the commits. Reference the subtask key in the commit message(s).
4. **If the parent has no open branch or PR** (subtask picked up ahead of the parent's work), stop and ask the user how to proceed — start the parent's branch, or work the subtask standalone. Do not silently default to a new subtask branch/PR.
5. **Scope stays the subtask's own AC.** The parent's remaining scope is out of bounds — the subtask rides the parent's branch, it doesn't absorb the parent's work.

## Phase 1 — Exhaustive Context Sweep

Gather everything *before* forming any opinion about the implementation. Run independent fetches **in parallel** (same tool block; fan out subagents for slow sources like Slack + Confluence). Missing sources are noted, never fatal.

### 1a. Jira
- `getAccessibleAtlassianResources` once for the cloud ID; reuse it.
- `getJiraIssue` (`responseContentFormat: "markdown"`, expand `renderedFields`): summary, full description, **acceptance criteria verbatim**, issue type, priority, status, labels, components, sprint, assignee, epic link.
- **All comments** — scope changes, clarifications, and design decisions hide here and often override the description.
- **Linked tickets**: every issue link (blocks/blocked-by/relates/parent epic/subtasks) — at minimum summary + status; full detail for anything that shapes requirements. Fetch the parent epic's description. Check any Engineering Notes / grooming field — prior subtasking research is a head start, but verify it against the current code, don't inherit it blindly.
- **Remote links** (`getJiraIssueRemoteIssueLinks`): Confluence pages, Figma files, PRs, docs.
- **Attachments**: note screenshots/mockups/documents and read what's readable.

### 1b. Confluence & Figma
- Fetch every Confluence page linked from the ticket or its comments (`getConfluencePage`, markdown). Search for tech specs referencing the key via `searchConfluenceUsingCql` (`text ~ "<KEY>"`).
- For Figma links: `get_design_context` (and `get_screenshot` when the work is UI). The design is part of the AC — measure the implementation against it.

### 1c. Slack (unless `--no-slack`)
- `slack_search_public_and_private` for the ticket key and the feature name; read matching threads. Look for: requirement changes agreed in Slack, edge cases discussed, approach decisions, known landmines.

### 1d. GitHub
- **Prior art PRs**: `gh pr list --search` for the feature area and sibling tickets in the same epic — merged PRs for adjacent work show exactly what an accepted implementation looks like (structure, test style, PR description shape).
- **PR template**: `.github/PULL_REQUEST_TEMPLATE.md` if present — the draft PR must fill it in properly.

### 1e. Git history — pattern calibration
- `git fetch origin <base>` so all recon happens against the branch tip, not a stale checkout.
- For each area the ticket will touch, skim 2-3 *recent merged* changes to sibling files (`git log --oneline --since="3 months ago" -- <paths>`, then read the interesting diffs) so "how the team does this today" is grounded in what actually ships — naming, layering, test placement, commit-message style.

### 1f. Repo conventions
- Read the repo's CLAUDE.md, relevant docs/ guides, and the lint/CI config for the affected areas. These are rules the PR will be judged against — collect the exact format/lint/typecheck/test commands the repo expects, scoped to the touched packages.

**Checkpoint — Context Brief.** Before touching design, output a short brief: what the ticket requires (AC verbatim or tightly paraphrased), scope changes found in comments/Slack, linked designs/specs and what they add, prior-art PRs worth mirroring, and any context source that was unavailable. If the ticket has **no acceptance criteria**, flag it here — the inferred requirements you'll work from must be confirmed by the user in Phase 3 before any code is planned against them.

## Phase 2 — Acquire the Code & Reconnoiter (No Checkout Required)

Set up the isolated workspace first, so every file you read is at the base branch's current tip:

```bash
git fetch origin <base>
git worktree add <scratchpad>/impl-<KEY> origin/<base> --detach
```

- If `--repo` points somewhere not cloned locally: blobless clone into the scratchpad first (`git clone --filter=blob:none <url>`), then worktree as above.
- If `--local` was passed: confirm the checkout is clean (`git status --porcelain`); if dirty, stop and tell the user rather than mixing their edits with yours.
- The branch is created later (Phase 5) once its name is decided; recon runs detached.

Then reconnoiter **inside the worktree**, driven by the AC:

1. **Map AC → code.** For each criterion, find the exact files, functions, routes, schemas, and components involved. Grep for the ticket's domain words, follow imports, read the real code — not from memory.
2. **Find the analogous feature.** Nearly every ticket resembles something the team already shipped. Find the closest recent example end-to-end and treat it as the structural template — same layers, same naming, same test shape.
3. **Trace the data flow** the ticket touches (route → validation → business logic → data layer → response, or the UI equivalent) so the change lands at the right layer instead of where it's easiest.
4. **Study the tests** for the affected area: framework, utilities, mocking patterns, fixture style, file placement. New tests must look native.
5. **Inventory reusable pieces** — shared components, helpers, hooks, validators that must be used instead of re-implemented.
6. **Surface constraints**: migrations needed, feature flags, permissions/RBAC, i18n strings, telemetry/analytics events, cross-package coordination, backward compatibility — the "any other work" that separates done from demo.

Fan out parallel subagents for independent recon questions when the surface is large; keep each one scoped to a specific question with a concrete answer shape.

## Phase 3 — Clarifying Questions (only what context can't answer)

Review everything gathered and list genuine unknowns: ambiguous AC, unspecified behavior (empty states, error copy, permission edge cases), conflicts between sources (ticket says X, Figma shows Y), and missing-AC confirmations from Phase 1.

**A question earns its place only if the answer isn't discoverable from any context you gathered and materially changes the implementation.** Everything else you decide yourself, following the codebase.

Ask everything in **one batch** via AskUserQuestion (with your recommended option first where you have one). If there are no qualifying questions, say exactly that — "no open questions; the context fully specifies the work" — and proceed.

## Phase 4 — Implementation Plan (HARD STOP)

Present the complete plan:

```
## Implementation Plan: <KEY> — <ticket title>
**Repo:** <owner/name> | **Branch:** <new-branch-name> → <base> | **Worktree:** <path>

### Acceptance criteria → implementation
<one row per AC item: criterion → how it will be satisfied → where (files)>

### Approach
<short: the design, the analogous feature being mirrored (with file refs), key decisions and why,
 answers from Phase 3 folded in>

### Changes (ordered)
<numbered steps, innermost layer outward. Each: what → exact file path(s) → concrete shape
 (signatures, schema fields, endpoint paths, component props) → which pattern/file it mirrors>

### Tests
<per area: cases to cover (including the AC's edge cases), which existing test file is the
 style template, where new files go>

### Completeness
<migrations, flags, permissions, i18n, telemetry, docs, exports — each either planned or
 explicitly n/a>

### Verification
<the exact repo-native commands that must pass: format, lint, typecheck, targeted tests>

### Out of scope
<adjacent problems noticed but deliberately not touched, so the diff stays reviewable>
```

Branch naming and PR target come from evidence: recent branch names on merged PRs (`gh pr list --state merged --json headRefName --limit 30`) define the naming convention; the base is the repo default unless the ticket/epic/`--base` says otherwise.

**Stop and wait for approval.** The user may approve, redirect, re-scope, or answer differently — update and re-present after any material change. Do not write code before this gate clears.

## Phase 5 — Implement

Create the branch in the worktree (`git switch -c <branch-name>`), then execute the plan:

- **Follow the plan's order** — innermost layer outward, so the branch builds coherently and each step compiles against the last.
- **Pattern-match relentlessly.** Before writing each file, re-read its analogous sibling. Match comment density, naming, error-handling idiom, import style. The diff should be indistinguishable from the team's own work.
- **Write tests with the code**, not after — each behavior and AC edge case gets coverage as it's built, in the repo's native test style.
- **Reuse, don't re-implement.** Every helper from the Phase 2 inventory gets used; hand-rolling an existing abstraction is a defect.
- **Commit in logical units** as slices complete, in the repo's commit-message style (mirror recent history — including whether the team includes the ticket key). Match the repo's granularity: if merged PRs are single-commit, keep it to one tidy commit at the end.
- **If a product decision surfaces mid-implementation** that the plan and context don't answer, stop and ask (Rule 5) — don't invent behavior to keep momentum.
- **If reality contradicts the plan** (the code isn't shaped the way recon suggested), adapt within the plan's intent; if the change is material to what was approved, surface it before proceeding.

## Phase 6 — Verify & Self-Review (the Quality Gauntlet)

No work reaches the user without passing this phase.

1. **Run the repo's own toolchain** from the Phase 4 verification list — format, lint, typecheck, targeted tests for every touched package. Fix failures and re-run until green. Failing tests that pre-date the branch get reported, not silently absorbed or "fixed" by weakening assertions.
2. **Re-verify the AC matrix against the actual diff**: every criterion → satisfied, with file:line evidence. Any `partial` or `missing` sends you back to Phase 5, not into the report.
3. **Adversarial self-review.** Review the full diff (`git diff origin/<base>...HEAD`) the way deep-review would review a stranger's PR — fan out parallel subagents, each prompted to *find what's wrong*, not confirm what's right: correctness and unhandled edge cases; deviations from the repo's recent patterns; security (authz, injection, unsafe input at boundaries); data integrity (transactions, migrations, schema drift); test quality (assertions that can't fail, mocks tested instead of behavior); scope creep and leftover debug/dead code. Fix every confirmed finding, then re-run step 1.
4. **Read the final diff top to bottom once**, as the reviewer will. Anything that would make you comment on a colleague's PR gets fixed now.

## Phase 7 — Ship (approval gate unless `--ship`)

Present the completion report:

```
## Ready to Ship: <KEY> — <ticket title>
**Branch:** <branch> → <base> | **Commits:** N | **Diff:** X files, +A/−B

### AC compliance
<matrix: each criterion → satisfied → file:line evidence>

### Verification
<each command → result, verbatim-honest>

### Self-review outcome
<findings fixed; anything consciously left as-is, with reasoning>

### Draft PR (verbatim as it will post)
**Title:** <title — repo convention, usually includes the ticket key>
<the full PR body: template filled if one exists; otherwise summary, changes, test plan,
 Jira link. Human voice — reads like the user wrote it, no AI boilerplate.>
```

**Stop and wait** — unless `--ship` was passed, in which case proceed directly. On approval:

1. `git push -u origin <branch-name>` from the worktree.
2. `gh pr create --draft --base <base> --head <branch> --title ... --body-file ...`
3. Report the PR URL, and note any follow-ups for the user (e.g., transitioning the Jira ticket, flagging reviewers). Write to Jira only if the user asks.

If `--no-pr`: skip push and PR, report the worktree path and branch name, and leave the committed work in place — telling the user exactly where it is.

## Cleanup

After a successful push, remove the ephemeral worktree (`git worktree remove --force <path>`) — the branch lives on the remote. If the run is abandoned mid-way: remove the worktree only if it holds no unpushed commits; otherwise leave it and tell the user exactly where the work is and how to resume. Remove any scratchpad clone.
