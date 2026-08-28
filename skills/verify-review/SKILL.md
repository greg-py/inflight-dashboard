---
name: verify-review
description: Second-pass re-review of someone else's PR after you requested changes — verify the author actually addressed your feedback (adequately, correctly, cleanly, on-pattern) and introduced no regressions with their new commits. No local checkout required. Reconstructs your prior review, computes the delta the author pushed since it, scores each requested change as addressed/partial/not-addressed/pushed-back, adversarially verifies every new finding, and produces an updated GitHub review that is never posted without explicit user approval.
argument-hint: "[PR# | branch-name | PY-XXXXX] [--repo owner/name] [--since <sha|review-id>] [--all-reviewers] [--focus areas] [--local] [--no-slack] [--no-jira]"
---

You already reviewed this PR and requested changes. The author has since pushed commits claiming to address your feedback. Your job now is narrow and specific: **verify they actually did the work** — that every change you asked for was made, that each one is adequate, correct, simple, clean, documented, and follows the codebase's patterns — and that in the process of addressing your feedback they did not introduce new bugs, regressions, or scope creep. The deliverable is an *updated* review: approve if it's genuinely done, keep requesting changes if it isn't, with a scorecard that maps one-to-one onto what you originally asked for.

Two failure modes are equally unacceptable: **waving it through** (marking a requested change "addressed" because a commit touched that file, without confirming the fix is correct and complete) and **moving the goalposts** (raising fresh nitpicks on code you already saw and didn't flag the first time). Re-review only the response to your feedback and the new commits — not the whole PR again.

Think deeply and skeptically throughout. Never rush to output.

## Non-Negotiable Rules

1. **NEVER post anything to GitHub, Jira, Slack, or any external system without explicit user approval in this conversation.** The deliverable of this skill is a *draft* updated review. Posting happens only after the user says to post.
2. **Never modify the user's working tree or current branch.** All code inspection happens in an ephemeral worktree (or the current checkout only if `--local` is passed or the branch is already checked out).
3. **Your prior review is the contract.** The primary checklist is the set of changes *you* requested. Every item on it must be adjudicated against the code at the current head with an end-to-end trace — "a commit touched this file" is not an adjudication.
4. **Only re-review the delta.** The review surface is what changed *since your last review* (`<review-SHA>..<head>`) plus the specific lines your comments anchored to. Do not re-raise issues on unchanged code you already saw, and do not open new fronts on pre-existing code the new commits didn't touch.
5. **Every new finding must survive end-to-end verification** (Phase 5's gauntlet). A regression you can't trace to a concrete failure path does not exist.
6. **Repository conventions beat general best practices.** "Clean" and "on-pattern" are defined by the repo's docs (CLAUDE.md, docs/, CONTRIBUTING) and *recent* merged commits from other developers — not generic style opinions.

---

## Phase 0 — Parse Arguments & Resolve the Target

Parse `$ARGUMENTS`:

| Input | Interpretation |
|---|---|
| Bare number (e.g. `7051`) | GitHub PR number |
| `PY-\d+` (or other Jira key pattern) | Jira ticket key |
| Anything else bare | Branch name |
| `--repo owner/name` | Target repo (default: repo of cwd via `gh repo view --json nameWithOwner`) |
| `--since <sha\|review-id>` | Override the delta anchor (default: the commit your most recent review was pinned to) |
| `--all-reviewers` | Weight every reviewer's requested changes equally on the checklist (default: yours primary, others secondary) |
| `--focus a,b` | Restrict the regression scan to specific categories (default: all) |
| `--local` | Use the current checkout instead of an ephemeral worktree |
| `--no-slack` / `--no-jira` | Skip those context sources |

Resolve the PR↔branch↔ticket triple **exactly as deep-review does** (`gh pr view`, `gh pr list --head`, remote issue links, `--search "<KEY> in:title"`). A PR is **required** — with no PR there is no prior review to verify; say so and stop. Record `headRefName`, `headRefOid` (current head SHA — the new review pins here), base, author, state.

Confirm the seat is right:
- If **you have no prior review** on this PR, this skill doesn't apply — you haven't requested changes yet. Point the user at `deep-review` for a first pass and stop.
- If the **PR author is the user**, that's the `address-review` seat (responding to reviewers on your own PR), not this one. Note it prominently and confirm before continuing — GitHub also forbids self-APPROVE, so the verdict would be capped at COMMENT.

State the resolved triple (PR #, head/base branches, ticket key, repo) and the seat check in one line before continuing.

## Phase 1 — Reconstruct the Prior-Review Baseline

This is what makes a re-review a re-review. Rebuild exactly what you asked for and when.

### 1a. Your reviews and their pin commits
- `gh api repos/{repo}/pulls/{n}/reviews --paginate` — every review, with `id`, `user.login`, `state`, `commit_id`, `submitted_at`, `body`. Identify **your** reviews (match the authenticated login via `gh api user --jq .login`).
- The **delta anchor** is the `commit_id` of your *most recent* review (what the code looked like when you last looked). If `--since` was passed, use that instead. Record this SHA — call it `<review-SHA>`.
- Keep the **body** of each of your reviews (REQUEST_CHANGES/COMMENT bodies carry the points not anchored to any line).

### 1b. The complete feedback inventory (resolution state included)
The REST comments endpoint doesn't expose resolved/outdated, so use GraphQL for threads:
```bash
gh api graphql -f query='query($owner:String!,$repo:String!,$pr:Int!,$cursor:String){
  repository(owner:$owner,name:$repo){pullRequest(number:$pr){
    reviewThreads(first:50,after:$cursor){pageInfo{hasNextPage endCursor}
      nodes{id isResolved isOutdated path line startLine diffSide
        comments(first:30){nodes{id databaseId author{login} body createdAt}}}}}}}' \
  -f owner=... -f repo=... -F pr=...
```
Paginate fully. For each thread capture: author of the first comment, anchor (path:line + diff side), full text, thread ID + latest comment databaseId (needed to reply), and `isResolved`/`isOutdated`.

### 1c. Build the Requested-Changes Checklist
Normalize your feedback into a numbered checklist — this is the spine of the whole review:
- One row per distinct thing you asked for. **Split bundled comments** ("this is racy, and also rename the var" = two rows). Fold your review-body points in as rows too, even though they have no line anchor.
- Mark each row's origin (inline thread vs. review body) and its current thread state (resolved / outdated / unresolved).
- **Secondary items:** unless `--all-reviewers`, list *other* reviewers' unresolved requested changes as a clearly separated secondary section — so nothing the author addressed for a colleague gets missed, without diluting your contract. With `--all-reviewers`, merge everyone equally into the primary checklist (collapsing duplicates, both reviewers named).
- **Read the author's replies** on each thread. A reply may (a) claim a fix with a SHA, (b) answer a question, or (c) push back on your comment. Note which — each gets adjudicated in Phase 4, not taken at face value.

## Phase 2 — Context Sweep (lighter, same spirit as deep-review)

You cannot judge "adequate / correct / on-pattern" without knowing what the code is supposed to do. In parallel, fan out for the slow sources:
- **Jira** (unless `--no-jira`): description and **acceptance criteria verbatim**, plus all ticket comments (scope changes hide here). The AC is the arbiter when "addressed differently" means the author changed behavior.
- **PR body** — re-read it; the author may have updated testing notes or a changelog describing how they addressed the round of feedback.
- **Slack** (unless `--no-slack`): search the ticket key + PR number for anything discussed *after* your review — the author may have settled an approach with you or someone else out-of-band.
- **Confluence/Figma** — only if linked and relevant to a requested change (e.g., you asked for UI fidelity to a mock).
- **Repo conventions** — CLAUDE.md / docs / lint config for the touched areas, plus *recent* merged siblings, so "follows codebase patterns" is grounded in what the team ships today.

**Checkpoint — Re-Review Brief.** Before touching code, output a short brief: the delta anchor SHA + how many commits landed since your review, the checklist item count (X yours / Y secondary), any author pushback to adjudicate, and any context source that was unavailable.

## Phase 3 — Acquire the Code & Compute the Delta (No Checkout Required)

```bash
git fetch origin <headRefName>
git worktree add <scratchpad>/verify-<pr> <headRefOid> --detach
```
Pin to `headRefOid` (record it — the new review pins here). If `--repo` isn't cloned locally, blobless-clone first (`git clone --filter=blob:none`). If `--local`, confirm the current checkout is on the head branch and clean (`git status --porcelain`); if dirty, stop. **Always remove the worktree in cleanup**, including on failure.

Compute the **response delta** — the heart of the surface:
```bash
git fetch origin <review-SHA>            # GitHub retains it even after force-push
git log --oneline <review-SHA>..<headRefOid>   # the commits the author pushed since your review
git diff <review-SHA>..<headRefOid>            # what actually changed
```
- **Force-push / rebase guard:** check `git merge-base --is-ancestor <review-SHA> <headRefOid>`. If it's *not* an ancestor, the branch was rebased/squashed since your review — say so, and expect the raw delta to contain rebase noise. In that case lean on per-anchor history (`git log -L<line>,<line>:<path> <headRefOid>`) and each thread's `isOutdated` flag to distinguish real response changes from rebase churn, rather than trusting the flat `git diff`.
- Also keep the full merge-base diff (`git merge-base origin/<base> <headRefOid>`, then `git diff`) for context only — you need it to trace regressions, not to re-review from scratch.

## Phase 4 — Adjudicate Each Requested Change (the Scorecard)

Work in the worktree. For **each checklist item**, independently and exhaustively, trace the current code end-to-end at head (read the full function, callers, callees, contracts, and tests — not just the anchor line), then render one verdict:

- **`ADDRESSED — good`** — the change was made and it is adequate, correct, simple, clean, documented as needed, and matches repo patterns. Cite the commit + file:line that did it.
- **`ADDRESSED — but`** — the concern was resolved, but the fix introduces a new problem: incomplete, over-engineered, a wrong/deprecated pattern, missing test, sloppy naming, or a fresh smell. Record the residual issue precisely — this becomes a finding.
- **`PARTIALLY ADDRESSED`** — some of what you asked for landed; part is still missing. Say exactly which part remains.
- **`NOT ADDRESSED`** — no change, or a change that doesn't actually resolve the concern. Confirm you're looking at head, not a stale diff.
- **`ADDRESSED DIFFERENTLY`** — the author took a different approach or pushed back in a reply. Adjudicate on the merits like address-review does: trace whether their alternative is correct and AC-compliant; if they're right, accept it and say so; if they're wrong, hold the line with evidence; if it changes behavior the ticket doesn't specify, it's a product question for the user.
- **`SUPERSEDED / MOOT`** — the surrounding code changed such that your comment no longer applies. Explain why.

Rules for this phase:
- **Confirm, don't assume.** A thread marked resolved or a reply saying "fixed in abc123" is a *claim*. Open the commit, trace the code, and confirm the claim holds. Reviewers get waved-through fixes precisely because someone trusted the checkbox.
- **Adequacy, not just presence.** The bar is the seven qualities in this skill's mandate (adequate, appropriate, correct, simple, clean, well-documented, pattern-following) — a fix that works but is copy-pasted, untested, or fights the codebase is `ADDRESSED — but`, not `good`.
- **Answer your own questions.** For checklist items that were questions, check whether the author's reply (or the code/ticket) actually answers them; if so, that item is resolved.
- For large checklists, fan adjudication out to parallel subagents — one item each, full context brief, prompted to find evidence that the fix is *incomplete or wrong* — and spot-check their traces before accepting.

## Phase 5 — Regression Scan on the New Commits + Verification Gauntlet

Independently of the checklist, review the **response delta as its own diff** for anything the author *introduced* while addressing feedback. Read every changed file in the delta fully. Hunt across categories (unless `--focus` restricts) exactly as deep-review Phase 3 does — correctness/bugs, security/authz (per the repo's RBAC model), data integrity/transactions, performance, repo-pattern deviations, type safety, API-contract breaks, test coverage for the new logic, and misleading/leftover comments or debug code. Pay special attention to the classic re-review regressions: a fix that satisfies one comment while breaking an adjacent case, a hasty refactor that drops a guard, a rename that misses a call site, a test weakened to make the fix pass.

Then run **every** candidate — from both Phase 4 (`ADDRESSED — but`, `PARTIAL`, `NOT ADDRESSED`) and this phase — through **deep-review's adversarial verification gauntlet** (its Phase 4): trace end-to-end, check every escape hatch, `git blame` against the delta to confirm the new commits (not pre-existing code) caused it, check whether a comment/Slack/reply already explains it, confirm CI didn't already catch it, and validate pattern claims against *recent* merged code. Verdicts: `CONFIRMED` / `LIKELY` (state the assumption) / `DEAD`. Only CONFIRMED, and medium+ LIKELY, survive.

Re-calibrate severity: **critical** (data loss / security / mainline crash), **high** (incorrect behavior users hit, or an unaddressed requested change that blocked the PR), **medium** (edge-case bug, real pattern violation, missing meaningful test), **low** (author's call).

## Phase 6 — Draft the Updated Review (Ready-to-Post, NOT Posted)

Comments post under the user's name.

**Stance in this seat:** you already asked once, and that earns directness the first pass didn't have — on a still-open item you don't need to relitigate whether there's a problem. But directness is not sharpness. No scolding, no "as I mentioned above," no counting rounds. Three re-review shapes:

- **Still open:** reference the original ask so the thread reads as continuous, then say what's left. "still returns early on the empty case — does the guard need to move above the early return?" Direct about the gap, open about the fix.
- **Resolved:** a short ack, only where it adds something. "yep, that's it." Brief, not effusive. Silence is fine too — don't ack all six threads.
- **New finding in their fix commits:** back to first-pass footing. You haven't lived in this new code either, so **ask, don't declare** — "am I reading this right that…", "is that intentional?" A confidently wrong assertion on round two costs more trust than it did on round one.

<!-- CANONICAL VOICE BLOCK — keep byte-identical across deep-review, address-review, verify-review. Edit one, edit all three. -->
### Voice

Write like a colleague typing in the GitHub box between meetings, not like a report. Every comment passes one test: *"would a human plausibly have typed this?"*

- **Short.** 1–3 sentences. Five is a hard ceiling, and only for something genuinely subtle. If it needs a paragraph to land, it's two comments or one question.
- **Skip the proof.** You did the tracing — don't narrate it. No repro walkthroughs, no "previously X, now Y" timelines, no citing three files to establish a claim. State it and let them go look; the evidence is there for round two.
- **No structure inside a comment.** No bold labels, no bullet lists, no headers, no severity words, no multi-paragraph build-up. Prose.
- **The fix in half a sentence,** as a question where it fits: "would calling resync there cover it?" — not a prescription with rationale.
- **Contractions. Plain names. Short declaratives of varying length.** "the query is slow" beats "the query exhibits suboptimal performance characteristics." Say the blunt thing straight: "I don't know." "That won't work." "Not worth fixing."
- **Prefixes** lowercase where they help — `issue:`, `suggestion:`, `question:`, `nit:`, `praise:`. Don't force one onto every comment.
- **Vary openings and sentence shapes.** Three comments that all open "issue: I think…" read as generated.
- ```suggestion``` blocks (GitHub suggested-change syntax) when the fix is small and certain; otherwise one sentence.

**Kill list.** Preambles and closers: "Great question", "You're absolutely right", "Let me…", "In summary", "Hope this helps". Padding: "It's worth noting that", "It's important to understand", "essentially", "basically", "in order to". Consultant words: leverage, utilize, robust, seamless, comprehensive, holistic, streamline, ensure, facilitate, surface (as a verb). Shapes: the "not just X — it's Y" reveal, the rule-of-three list, stacked em-dashes for drama, bold-label bullets, emoji and ✅ garnish, hedge stacks like "it seems like it might potentially". Connectives: however → but, therefore → so, additionally → and, prior to → before. Never restate the code back, and never summarize what you just said.

Before presenting, reread each one and cut. The most common failure is text that is *correct and thorough* but reads like documentation — that's a rewrite, not a pass.
<!-- END CANONICAL VOICE BLOCK -->

**The review body posts empty**, same as deep-review. The scorecard is for the user, not the author — per-item status goes as a reply on each original thread, new findings go inline on the lines they concern, and the APPROVE/REQUEST_CHANGES state carries the bottom line. So `body: ""` in the posted review. Everything you'd have written as an overall comment goes to the user in the draft below instead.

The one exception is the same as deep-review's: something genuinely non-inline that no line and no existing thread can carry. Don't smuggle a scorecard summary in under it — if it could hang off a line or a thread, put it there. If it truly can't, propose it to the user and let them decide.

**Anchoring rules** (same as deep-review): every inline comment targets a line that exists in the current diff (RIGHT for added/context, LEFT for deleted); use multi-line anchors where the finding spans a hunk; verify each anchor against the actual head diff before presenting — mis-anchored comments fail to post. For a still-open item whose original thread went **outdated** (the line moved), anchor a fresh comment on the current line rather than relying on the stale thread.

**Present to the user in this exact structure:**

```
## Draft Re-Review: <PR title> (<PR URL>)
**Pinned to:** <short head SHA> | **Since your review at:** <short review-SHA> (<N> new commits) | **Branch:** <head> → <base> | **Jira:** <KEY>

### Requested-Changes Scorecard (your review)
<one row per checklist item → verdict → evidence (commit + file:line)>
  1. <compressed quote of what you asked> — ADDRESSED — good — <trace/cite>
  2. ...
[### Other reviewers' items (secondary)  ← only if any, unless --all-reviewers merged them above]

### New findings in the response commits (N)   ← regressions / issues the fixes introduced
**1. `path/file.ts:123` — <severity> <category>**
> <exact comment body as it would post>

### Summary (for you — does NOT post)
<2–4 sentences: how much of what you asked for landed, what's still outstanding or newly
broken, and the bottom line. This is chat-only; the posted review body is empty.>

### Dropped in verification: N candidates (one-line reasons, so the user can veto a drop)

### Proposed status: APPROVE | REQUEST_CHANGES | COMMENT — <one-line rationale>
```

Status guidance: **APPROVE** when every requested change is `ADDRESSED — good` / `MOOT` and no medium+ new finding survives. **REQUEST_CHANGES** when any item is `NOT ADDRESSED` / `PARTIAL`, or a `high`+ regression survives, or an `ADDRESSED — but` is serious enough to block. **COMMENT** when only low-severity items remain (author's call) — or when the author is the user (self-APPROVE is forbidden; say so).

## Phase 7 — Approval Loop (HARD STOP)

**Stop and wait.** Ask the user to approve, edit, drop, override a verdict (their word wins — they may know an item was settled offline), or dig deeper. Re-present the updated draft after any material change. Never treat silence or ambiguity as approval, and never post.

## Phase 8 — Post (only after explicit approval)

Post as **one review** so the author gets a single notification:
```bash
gh api repos/{owner}/{repo}/pulls/{n}/reviews --input review.json
```
with `review.json`: `{"commit_id": "<pinned head SHA>", "body": "", "event": "<APPROVE|REQUEST_CHANGES|COMMENT>", "comments": [{"path": ..., "line": ..., "side": "RIGHT", "body": ...}, ...]}` (add `start_line`/`start_side` for multi-line anchors).

- **`body` is `""`.** GitHub accepts an empty body on all three events as long as `comments` is non-empty. The only time it carries text is the Phase 6 exception the user explicitly approved.
- Replies that belong on an existing thread (close-the-loop acks, "still open because…") post as thread replies instead: `gh api repos/{repo}/pulls/{n}/comments/{latest_comment_databaseId}/replies -f body=...`. Decide per item whether it reads better as a new review comment or a reply on the original thread — continuity usually favors the reply.
- If a review ends up with zero inline comments (everything landed → `APPROVE`, with per-item acks posted as thread replies), the body is the only channel left — use one plain sentence, not a summary.
- If any comment is rejected for anchoring, fix the anchor and re-post; if it genuinely cannot be anchored, ask the user rather than moving it into the body.
- If the verdict is APPROVE and `--all-reviewers` wasn't set, leave other reviewers' unresolved threads alone — they resolve their own.
- Confirm with the posted review URL.

## Cleanup

Remove the ephemeral worktree (`git worktree remove --force`) and any scratchpad clone. Runs even when the re-review is abandoned mid-way.

## Session Status File (inflight dashboard)

If your initial working directory is under `~/.cache/inflight-worktrees/`, this session was launched from the local inflight dashboard — keep it informed by writing `.agent-status.json` at the worktree root at every phase transition:

```json
{ "state": "working", "detail": "<one short line: current phase, or what you're waiting for>" }
```

States: `working` (default), `awaiting-approval` (stopped at an approval gate waiting for the user), `blocked` (waiting on an answer to a question), `done` (final report delivered; work pushed or complete). Update `detail` on every transition, and use these EXACT state strings — anything else is coerced to `working`, which makes the dashboard think the session never finished. Never commit this file — the dashboard reads it and cleans it up.

### Staging approvals in autonomous mode

When `--autonomous` is active and you reach a gate whose action is **outward-facing** (submitting a review, posting reply comments — anything that lands in a colleague's notifications), stage it instead of stopping in the terminal: write an executable `.approval.sh` at the worktree root containing exactly the staged command(s) — nothing else, no side quests — and set the status file to:

```json
{ "state": "awaiting-approval", "detail": "<what's staged>", "approval": { "label": "<verb phrase, e.g. submit review>", "detail": "<one line of what it will do>" } }
```

The dashboard renders an Approve button that runs `.approval.sh` in this worktree (and a Dismiss button that declines it). Keep any long content the script posts in files in the worktree (e.g. `review-body.md`) referenced with `--body-file`.

## Autonomous Mode (`--autonomous`)

With `--autonomous`, produce the complete verified review with no interactive stops, then **stage the submission instead of posting it**: write the review body and inline comments to files in the worktree, create `.approval.sh` containing exactly the command(s) that post the review, and set status `awaiting-approval` with `approval: { label: "submit review (<verdict>)", detail: "<N findings, one-line verdict>" }` per the staging section above. Posting a review to a colleague's PR always remains behind that one click — `--autonomous` never submits it directly.
