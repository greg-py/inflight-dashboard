---
name: resolve-conflicts
description: Bring a branch up to date with its base and resolve every merge conflict correctly — no local checkout required. Fetches both sides, predicts the collision surface before merging, resolves each conflict by establishing what both sides intended (never by picking a winner), then sweeps for the conflicts git resolved silently and wrongly: resurrected deletions, clean-merged-but-broken registries, duplicate migration numbers, stale callers of changed signatures. Verifies, commits, and pushes; anything needing a judgment call that could drop either side's work stops for approval first. Use when a PR is CONFLICTING, when a long-lived branch needs a fresh base merge, or when the user says "merge master into", "fix the conflicts", or "this branch is behind".
argument-hint: "[PR# | branch-name | PY-XXXXX] [--from <branch>] [--repo owner/name] [--local] [--rebase] [--no-push] [--dry-run] [--verify none|structural|build|tests]"
---

# /resolve-conflicts

Integrate a base branch into a feature branch and resolve the fallout. The job is not "make git stop
complaining" — it is to produce a tree in which **both sides' intent survives**, and to prove it.

Read `reference.md` (same directory) before resolving anything: it holds the conflict-class taxonomy
with the correct resolution and the trap for each, the silent-conflict classes that produce no
markers at all, the inspection commands, the PerformYard files that must move in lock step, and the
per-artifact rules for lock files, snapshots, suppressions, and LFS.

The defining insight of this skill: **the set of files that conflicted is not the set of files at
risk.** Git merges non-overlapping text hunks without complaint, so the dangerous cases are the ones
it resolves silently — a deletion undone, two registries merged into an inconsistent pair, a new
caller of a signature the base branch just changed. A run that resolves the markers and stops has
done the easy half.

## Non-Negotiable Rules

1. **Never discard a side to make the conflict go away.** Deleting a hunk, taking `-X ours`/`-X theirs`
   across a whole merge, or resolving to whatever compiles are all the same defect. Every resolution
   must be traceable to what each side was trying to do.
2. **Never force-push, and never rebase a branch with an open PR, without explicit approval.** Rebasing
   rewrites the commits reviewers anchored comments to and detaches resolved threads. `--rebase` is a
   request to *propose* it, not permission to do it.
3. **Never touch the user's working tree or current branch.** Work in an ephemeral worktree; the result
   reaches the branch via a push. `--local` is the only exception, and only against a clean tree.
4. **The escalation triggers in reference.md § Escalation are hard stops**, not warnings. Any conflict
   where you cannot establish both sides' intent from commits, PRs, or tickets goes to the user with
   the evidence — a plausible guess that silently drops someone's work is the worst outcome this
   skill can produce.
5. **Report the verification you actually ran, and name what you skipped.** If the environment can't
   build or test (no `node_modules`, nested-worktree resolution hazard — see reference.md), say so
   plainly and name CI as the gate. Never describe a structural check in language that implies a build.
6. **Resolution notes are part of the deliverable.** Any non-obvious resolution gets recorded for the
   reviewer — in the merge commit body, or a PR comment when it affects behavior. A reviewer who has
   to reverse-engineer why a hunk was dropped will assume it was an accident.

---

## Phase 0 — Parse Arguments & Resolve the Target

Parse `$ARGUMENTS`:

| Input | Interpretation |
|---|---|
| Bare number | GitHub PR number → its head branch is the target |
| `PY-\d+` (or other Jira key) | Ticket key → find its PR → head branch |
| Anything else bare | Branch name (target). Find its PR if one exists |
| *(nothing)* | The current branch, if this is a repo checkout and it isn't the default branch |
| `--from <branch>` | What to integrate (default: **the PR's own base branch**, else the repo default) |
| `--repo owner/name` | Target repo (default: cwd via `gh repo view --json nameWithOwner`) |
| `--local` | Work in the current checkout instead of a worktree |
| `--rebase` | Propose rebase instead of merge — requires approval (Rule 2) |
| `--no-push` | Stop after the commit; report the local SHA and worktree path |
| `--dry-run` | Inventory and plan only; no merge is left on disk |
| `--verify <tier>` | Force a verification tier (default: pick per Phase 7) |

Resolve the PR ↔ branch ↔ ticket triple as deep-review does (`gh pr list --head`, remote issue links,
`--search "<KEY> in:title"`). A PR is **not** required — a branch with no PR is a valid target — but
when one exists, record `headRefName`, `headRefOid`, `baseRefName`, `mergeable`, `mergeStateStatus`,
`isDraft`, `reviewDecision`.

**Take the base from the PR, not from habit.** A branch whose PR targets `release/29.29.1` must not
get `master` merged into it. If `--from` and the PR's base disagree, stop and ask.

## Phase 1 — Preflight

- `gh auth status -h github.com`; `git fetch origin <target> <base> --prune`. Never resolve against a
  stale remote — a conflict you fix against yesterday's base gets re-conflicted tomorrow.
- **Is a merge or rebase already in progress?** `git status`, plus `.git/MERGE_HEAD` / `REBASE_HEAD`.
  Finish or abort it deliberately; never start a second one on top.
- **Is the target already checked out in another worktree?** `git worktree list`. Git refuses a second
  checkout of the same branch, and this repo has many live worktrees.
- **Has someone pushed to the target since?** Compare local and `origin/<target>`. Fast-forward the
  local branch to origin first, and verify it's genuinely a fast-forward:
  ```bash
  git merge-base --is-ancestor <target> origin/<target>   # must succeed before you fast-forward
  ```
  If it fails, local and remote have diverged — that is its own conversation, not a merge.
- **`--local` only:** `git status --porcelain` must be empty. Do not stash; a stash popped after a
  merge produces a second conflict round and blends the user's unrelated edits into your resolution.
- Set `merge.conflictStyle=zdiff3` for the run. Without the base stage you cannot tell which side
  changed what, and guessing is how good hunks get dropped.

## Phase 2 — Acquire the Code

```bash
git worktree add <scratchpad>/merge-<target> <target> --detach
git -C <scratchpad>/merge-<target> switch -c <target>-merge-<base>   # local resolution branch
```

Detach-then-branch so a checkout of `<target>` elsewhere doesn't block the run; the result pushes with
`git push origin HEAD:<target>`. If `--repo` isn't cloned locally, blobless-clone it into the
scratchpad first (`git clone --filter=blob:none`).

Note the recovery handle before you start: `ORIG_HEAD` after the merge, or the pre-merge SHA you
recorded. `git merge --abort` and `git reset --hard <sha>` both need to be one command away.

## Phase 3 — Predict the Collision Surface (before merging)

Compute this *first*, because it is the checklist Phase 6 verifies against and it is far harder to
reconstruct once the tree is half-resolved.

```bash
MB=$(git merge-base <target> origin/<base>)
comm -12 <(git diff --name-only $MB <target> | sort) \
         <(git diff --name-only $MB origin/<base> | sort)     # touched by BOTH sides
git diff --diff-filter=D --name-only $MB <target>             # deletions on the branch side
git diff --diff-filter=D --name-only $MB origin/<base>        # deletions on the base side
git log --oneline $MB..origin/<base>                          # what the base brings, by PR
```

From those, write down before merging:

1. **The both-sides file list.** Every file on it will either conflict or auto-merge — and the
   auto-merges are the ones to audit, not trust.
2. **The deletion ledger** from both sides. Phase 6 asserts every one of these files is still gone.
3. **The dependency surface.** For each base-side commit, ask what it changed that the branch's new
   code could call: signatures, exports, required schema fields, renamed flag slugs, permission
   strings, collection names. String-literal references are invisible to a typechecker — grep for
   them by hand.
4. **The lock-step pairs and sequence collisions** from reference.md that either side touched — paired
   TS/Python registries, numbered migrations, `.gitattributes` merge=lfs paths, committed artifacts.

## Phase 4 — Merge and Inventory the Conflicts

```bash
git merge origin/<base> --no-edit    # expect it to fail; that's the point
git diff --name-only --diff-filter=U
git status --short | grep -E '^(UU|AA|DU|UD|AU|UA|DD)'
```

Inventory every conflicted path with its **status code** — `UU` content, `AA` both-added, `DU`/`UD`
modify/delete, `DD` both-deleted — because the code determines the resolution class, and modify/delete
is the class that silently loses work. Classify each against reference.md § Conflict classes and
record which class you assigned. An unclassifiable conflict is an escalation, not a judgment call.

If the count is large or a repo-wide reformat is in the range (see reference.md § Class 10), stop and
propose a strategy before resolving anything.

## Phase 5 — Resolve, Hunk by Hunk

For each conflict, in this order — never resolve before step 2:

1. **Read all three stages.** `git show :1:<file>` (base), `:2:` (ours/branch), `:3:` (theirs/base).
   The base stage is what makes the diff legible.
2. **Establish both intents.** `git log --merge --left-right -p -- <file>` shows only the commits that
   touched this file on each side. Follow them to their PRs and tickets when the change isn't
   self-evident. You are looking for two answers: what did each side want?
3. **Resolve so both hold**, per the class's rule in reference.md. For additive registries that means
   keeping *both* sides and honoring the file's existing ordering convention. It never means picking.
4. **Re-read the merged hunk in context**, not just the seam — a resolution that's locally correct and
   globally inconsistent (a slug added to the JSON but not the type union) is the common failure.
5. **Record the decision** and, for anything non-obvious, why the other side's text didn't survive
   verbatim.

Never hand-merge an artifact that a tool owns. Never edit LFS pointer content. Never "fix" formatting
by hand. reference.md § Artifacts covers each.

If the same conflicts will recur (a long-lived branch that merges the base repeatedly), enable
`git rerere` so the next run replays these resolutions.

## Phase 6 — Hunt the Silent Conflicts

The markers are gone; now find what git got wrong without telling you. Work the Phase 3 checklist:

1. **Audit every auto-merge on the both-sides list.** For each file, diff the merge result against
   *each* parent and confirm both sides' additions are present:
   ```bash
   git diff <target-pre-merge-sha> -- <file>   # should show only the base's additions
   git diff origin/<base> -- <file>            # should show only the branch's additions
   ```
   A file that shows nothing against one parent lost that side.
2. **Sweep the deletion ledger.** Every path from Phase 3's deletion lists must still be absent:
   ```bash
   for f in $(git diff --diff-filter=D --name-only $MB <target-pre-merge-sha>); do
     [ -e "$f" ] && echo "RESURRECTED: $f"
   done
   ```
   Repeat for the base side. A resurrection compiles fine and ships dead code, or worse, re-registers
   a removed feature flag.
3. **Check the dependency surface.** For each base-side change the branch's new code could touch,
   confirm the branch's callers still match. String literals (flag slugs, permission strings,
   collection names, route paths) need a grep — no typechecker will help.
4. **Check sequence collisions and lock-step pairs.** Duplicate migration prefixes, a TS registry
   updated without its Python twin. See reference.md § Lock-step.
5. **Assert the merge is actually clean:** `git ls-files -u` empty, `git diff --check` reports no
   leftover markers, and a marker grep that covers strings and docs too.

## Phase 7 — Verify

Pick the tier by what moved, per reference.md § Verification, and be honest about what the environment
supports:

- **structural** (always, non-negotiable): no markers, no unmerged paths, every conflicted file parses
  — JSON, YAML, Python compile, TS syntax. Plus the whole of Phase 6.
- **build** (when shared packages or generated types moved): targeted builds/typechecks for the
  touched packages only. This is the only tier that catches a stale caller of a changed signature.
- **tests** (when logic on both sides overlapped): the repo's targeted tests for the touched areas.

Failures stop the run. A pre-existing failure gets reported as pre-existing with the evidence that
it pre-dates the merge — never absorbed silently and never "fixed" by weakening an assertion.

If a tier is impossible here, say which and why, and name CI as the gate (Rule 5).

## Phase 8 — Report, and Decide Whether to Gate

```
## Merge: origin/<base> → <target>
**PR:** #N (<url>) | **Conflicts:** N files (<class breakdown>) | **Silent issues found:** N | **Verification:** <tiers run / skipped + why>

### Resolutions
**1. `path/file.ts`** (UU, class 1 additive-registry) — kept both sides; base added X, branch added Y
   <one line on ordering/dedup, or on why a side's text changed>

### Silent conflicts caught
<each one, or "none — deletion ledger clean, N auto-merges audited, dependency surface checked">

### Verification
<commands run → result; tiers skipped → why; CI as gate if applicable>

### Next
<push + expected PR state, or the approval being requested>
```

**Auto-execute through Phase 9** when *all* of these hold: every conflict fell in a class whose rule
preserves both sides mechanically (additive registries, formatting, tool-owned artifacts), the
verification tier for what moved passed, Phase 6 found nothing, and no escalation trigger fired.
Routine base-freshening merges are the common case and shouldn't demand a round trip.

**HARD STOP with the plan** when any of: a resolution required judgment that could drop or alter
either side's intent; a modify/delete where the deletion looks intentional but the modification is
load-bearing; the required verification tier couldn't run; Phase 6 found a silent issue; `--rebase`
or a force-push is involved; a binary/LFS side must be chosen; or `--no-push`/`--dry-run` was passed.
Present the resolutions with evidence and wait. Ambiguity is never approval.

## Phase 9 — Commit & Push

1. **Commit** with git's default merge message (`--no-edit`) — reviewers and tooling recognize the
   standard form. Append a body only to record non-obvious resolutions (Rule 6).
2. **Hooks:** don't skip them silently. If the environment forces `--no-verify`, run the hook's
   command manually and report the result.
3. **Push** `git push origin HEAD:<target>`. Force-push only with the approval from Rule 2, and then
   only `--force-with-lease`.
4. **Confirm the outcome, don't assume it.** Re-read the PR: `mergeable` should have flipped
   `CONFLICTING` → `MERGEABLE`. Note that the push re-triggers CI, and in some configurations
   invalidates an existing approval — say so if the PR was approved.
5. Report the pushed SHA, the PR's new state, CI status, and anything left open.

## Cleanup

Remove the ephemeral worktree (`git worktree remove --force`) and any scratchpad clone — including on
an abandoned run. Never leave resolved-but-unpushed work in a worktree without telling the user its
exact path and SHA. If you changed `merge.conflictStyle` or enabled `rerere` outside the worktree's
own config, say so.

## When NOT to use

- The branch isn't actually conflicting and doesn't need a fresher base — `mergeable: MERGEABLE` and a
  recent merge base means there's nothing to do. Say that instead of merging for its own sake.
- The user wants the PR *merged* into the base (that's a merge/squash of the PR, a different act with
  different gates), or wants a release cut — use `/production-release`.
- Cherry-pick conflicts during a release: `/production-release` owns those and stops for the operator
  by design.
- The conflict is really a design disagreement between two branches. Resolve the design with the
  humans first; a merge commit can't arbitrate it.

## Session Status File (inflight dashboard)

If your initial working directory is under `~/.cache/inflight-worktrees/`, this session was launched from the local inflight dashboard — keep it informed by writing `.agent-status.json` at the worktree root at every phase transition:

```json
{ "state": "working", "detail": "<one short line: current phase, or what you're waiting for>" }
```

States: `working` (default), `awaiting-approval` (stopped at an approval gate waiting for the user), `blocked` (waiting on an answer to a question), `done` (final report delivered; work pushed or complete). Update `detail` on every transition. Never commit this file — the dashboard reads it and cleans it up.

### Staging approvals in autonomous mode

When `--autonomous` is active and you reach a gate whose action is **outward-facing** (submitting a review, posting reply comments — anything that lands in a colleague's notifications), stage it instead of stopping in the terminal: write an executable `.approval.sh` at the worktree root containing exactly the staged command(s) — nothing else, no side quests — and set the status file to:

```json
{ "state": "awaiting-approval", "detail": "<what's staged>", "approval": { "label": "<verb phrase, e.g. submit review>", "detail": "<one line of what it will do>" } }
```

The dashboard renders an Approve button that runs `.approval.sh` in this worktree (and a Dismiss button that declines it). Keep any long content the script posts in files in the worktree (e.g. `review-body.md`) referenced with `--body-file`.

## Autonomous Mode (`--autonomous`)

This skill is already autonomous by design (verify, commit, push). With `--autonomous`, the one interactive stop — a judgment call that could drop either side's work — becomes status `blocked` with the specific question as `detail`, instead of waiting in the terminal. On success set status `done` with what was merged and pushed.
