# resolve-conflicts — reference

Conflict classes, silent-conflict classes, inspection commands, PerformYard-specific collision points,
artifact rules, verification tiers, escalation triggers.

## § Conflict classes

Classify every conflict before resolving it. The class determines the rule; the trap is what goes
wrong when the class is misread.

### Class 1 — Additive registry collision (most common, lowest risk)
**Signature:** `UU`, both sides appended entries to the same list, union, enum, dictionary, or barrel —
flag-slug arrays, collection selectors, index registries, JSON config maps, spell-check dictionaries.
**Rule:** keep **both** sides. Dedupe only exact duplicates. Honor the file's existing ordering
convention — alphabetical files stay sorted, append-at-end files stay appended.
**Traps:**
- The same key on both sides with **different values** is not a duplicate; it's a real semantic
  conflict about what the value should be. Escalate.
- Don't sort an append-at-end file "while you're in there." It inflates the diff and re-conflicts every
  other open branch.
- Registries usually come in pairs (see § Lock-step). Resolving the JSON and not the type union
  produces a tree that parses and fails at runtime.

### Class 2 — Divergent edits to the same logic
**Signature:** `UU`, both sides changed the same statement or block differently.
**Rule:** establish both intents from the commits/PRs before touching the text. Then either compose a
resolution that satisfies both, or — if they're genuinely incompatible — escalate. Never blend two
implementations syntactically into something neither side wrote.
**Trap:** "newer side wins" and "whichever compiles" are both guesses.

### Class 3 — Modify/delete
**Signature:** `DU` (base deleted, branch modified) or `UD` (branch deleted, base modified).
**Rule:** decide from *why* the deletion happened. An intentional removal — feature flag retired,
legacy component deleted — wins, and the other side's modification must then be re-homed or
consciously dropped, with a note. A deletion that was incidental doesn't win by default.
**Trap:** this is the class that loses work silently. `git checkout --ours` on a `DU` resurrects a file
the base branch deliberately removed; `--theirs` throws away the branch's change without a trace.
Never resolve one of these mechanically.

### Class 4 — Both-added
**Signature:** `AA` — the same path created on both sides. Usually the same fix implemented twice, or a
cherry-pick that also landed organically.
**Rule:** the shipped version (base side) is normally the keeper; graft any unique behavior from the
branch's copy on top. Verify the branch's *callers* match whichever version survives.
**Trap:** keeping both by renaming one leaves two implementations of the same thing.

### Class 5 — Deletion resurrection (no marker, or a marker resolved wrongly)
**Signature:** a file deleted on one side is present after the merge. Mechanisms vary — a `DU`/`UD`
resolved the wrong way, rename detection falling below the similarity threshold, or a squash-merge on
the base that re-adds a file the branch deleted.
**Rule:** build the deletion ledger *before* merging and assert it after (SKILL Phase 6, step 2).
**Trap:** resurrections compile. A restored feature-flag definition or a re-registered legacy nav
component ships as live code. This has bitten this repo before — treat the sweep as mandatory, not as
a belt-and-braces extra.

### Class 6 — Rename/modify
**Signature:** the base renamed a file, the branch edited the old path.
**Rule:** apply the branch's edit to the **new** path and confirm the old path is gone.
**Trap:** when rename detection fails, git keeps the old path *and* the new one. The duplicate looks
like an ordinary added file; only the deletion sweep or a stray-import grep catches it.

### Class 7 — Sequence collision (silent — different paths, so git never conflicts)
**Signature:** both sides claimed the same slot in a numbered or named sequence. In this repo:
`apps/migrations/src/migrations/NNNN-*` (master reached `0039`), plus DB index names, EventBridge rule
names, route prefixes.
**Rule:** after merging, list the sequence and check for duplicate prefixes. Renumber the branch's
entry to the next free slot and update every reference to it — directory name, registry entry, README,
tests, and anything that names the id in a string.
**Trap:** git will *never* flag this. Two `0038-` directories merge cleanly and break at run time.
Deleting or renaming a migration export can fail silently under swc — verify the runtime path, not
just the build.

### Class 8 — Tool-owned artifact
**Signature:** a conflict inside a file a tool generates. See § Artifacts for the per-artifact rule.
**Rule:** never hand-merge. Take one side wholesale, then regenerate, then read the regenerated diff.
**Trap:** a hand-merged lock file installs a dependency graph neither side tested.

### Class 9 — Binary / LFS
**Signature:** no textual merge possible. This repo's `.gitattributes` sets `merge=lfs` on
`packages/ai/src/rag/evals/datasets/uda-*.json`, `packages/ai/src/rag/evals/fixtures/uda/**`, and
`lambdas/Lambdas/UpdateSandboxConfiguration/config/Default/{DocumentContents,DocumentEmbeddings}.json`.
**Rule:** a side must be chosen explicitly by the user. Escalate; never pick for them.
**Trap:** editing a pointer file's text corrupts it. LFS pointers also generate local-only lint/spell
noise CI never sees — don't chase it.

### Class 10 — Reformat storm
**Signature:** the base ran a repo-wide formatter (this repo did, re-sorting Tailwind classes under
prettier's v4 resolution) and every file the branch touched conflicts on formatting alone.
**Rule:** take the base's formatted version per file, re-apply the branch's semantic change on top,
then re-run the repo's formatter. Do not hand-align.
**Trap:** hand-resolving a reformat hunk buries a real semantic change inside hundreds of cosmetic
ones, where no reviewer will find it. If the storm is large, propose the strategy before starting.

### Class 11 — Both-deleted
**Signature:** `DD`.
**Rule:** confirm the deletion was intended by both, then `git rm`. Check for orphaned references —
imports, registry entries, docs.

### Class 12 — Structural/whitespace-only seam
**Signature:** the conflict is import ordering, trailing commas, or a moved block with no behavior
change.
**Rule:** resolve to satisfy the repo's linter, then let the formatter settle it.
**Trap:** easy to resolve carelessly and drop a real import the branch needed.

## § Silent conflicts (no markers at all)

Git merges by text hunk, so semantic incompatibility in *different* hunks or *different files* merges
clean. These are found only by looking:

| Class | Mechanism | Detection |
|---|---|---|
| Stale caller | Base changed a signature/export; branch added a caller of the old form elsewhere | Build/typecheck the touched packages |
| New required field | Base added a required schema/model field; branch added a construction site | Build, plus the schema's own tests |
| Renamed string constant | Base renamed a flag slug, permission string, collection name, route path; branch references the old literal | **Grep** — typecheck cannot see string literals |
| Half-merged pair | One of two files that must agree got the merge; the twin didn't | § Lock-step |
| Sequence duplicate | Class 7 | List the sequence, check prefixes |
| Resurrection | Class 5 | Deletion ledger sweep |
| Lost side in auto-merge | Both sides edited one file in separate hunks; a bad 3-way lost one | Diff the result against **each** parent |

## § Inspection commands

```bash
git show :1:<file>  :2:<file>  :3:<file>        # base / ours / theirs stages
git diff --base --ours --theirs -- <file>       # each side against the merge base
git log --merge --left-right -p -- <file>       # only the commits that conflicted, per side
git checkout --conflict=zdiff3 -- <file>        # re-materialize markers showing the base
git ls-files -u                                 # unmerged paths; must be empty when done
git diff --check                                # leftover conflict markers + whitespace errors
git merge --abort                               # bail cleanly
git reset --hard ORIG_HEAD                      # undo a committed merge
git config rerere.enabled true                  # replay these resolutions on the next base merge
```

Never `git merge -X ours` / `-X theirs` for a whole merge — it silently drops the other side's hunks
across every file. Per-file `git checkout --ours/--theirs` is legitimate only for whole-artifact files
where taking one side wholesale is the correct semantics (Class 8/9).

## § Lock-step pairs (PerformYard)

A conflict in one of these means checking its twin **even when the twin merged cleanly**:

- **RBAC:** root `rbac.json` ↔ `packages/dto/src/service-actions/rbac/**` (TS) ↔
  `webserver/service_actions/rbac*.py` (Python). CLAUDE.md requires both implementations to define the
  same roles with the same resolution logic. Permission strings are string literals — grep them.
- **Collection registries:** `packages/dto/src/collections/index.ts` (selectors) ↔
  `webserver/performyard/schemas/__init__.py` (`Collections` enum + index registration) ↔
  `packages/models/src/models/defs/**`.
- **Feature flags:** `packages/models/src/models/defs/feature-flag.ts` (`FLAG_SLUGS`) ↔
  `lambdas/Lambdas/UpdateSandboxConfiguration/config/Default/Company.json` (`feature_flag`) ↔ every
  consumer's string reference. Sibling `config/Large/Company.json` carries a deliberately minimal set —
  don't "sync" it.
- **Contracts:** `packages/service-contracts/**` ↔ its service-actions ↔ its consumers. A merged
  contract change with unmerged consumers typechecks only if you build.
- **Deployment:** `deployment/src/config/lambdas.ts` ↔ `deployment/src/config/<env>/index.ts` (per-env
  registration) ↔ the lambda's own directory. A lambda registered in some environments and not others
  is a valid state — check the intent before "fixing" it.
- **Spell check:** `.cspell/performyard-words.txt` — append-at-end, not sorted.

## § Artifacts

| Artifact | Rule |
|---|---|
| `package-lock.json` | Take one side, then re-run `npm install` to regenerate. Never hand-merge hunks. |
| `**/eslint-suppressions.json` (6 of them) | Generated by `eslint --suppress-all`, prettier-ignored. Regenerate; never `--prune-suppressions`. |
| `**/__snapshots__/*.snap` | Take the base side, re-run the test with update, then **read** the regenerated diff. |
| `dist/` bundles committed for actions | Do not rebuild to resolve — the base's committed bundle is what runs. Take it wholesale. |
| `*.d.ts`, `.builds`, `cdk.out`, `.turbo` | Generated; regenerate or take the base side. |
| LFS paths (§ Class 9) | Escalate for an explicit side choice. |

`.prettierignore` decides whether a resolved file needs formatting at all — notably
`lambdas/Lambdas/UpdateSandboxConfiguration/config` and `*.test.ts` are ignored (`.ts` only; `.tsx`
tests are **not** ignored).

## § Verification tiers

Pick by what moved; run the highest tier the environment supports; report exactly what you ran.

- **structural** — always. No markers (`git diff --check` + a grep covering strings and docs), no
  unmerged paths, every conflicted file parses: `python3 -c 'import json;json.load(...)'`,
  `python3 -m py_compile <file>`, YAML load, TS syntax. Plus all of SKILL Phase 6.
- **build** — when shared packages, generated types, or contracts moved. Targeted only:
  `npx turbo run build --filter='<pkg>'`. Never a root `npm run build`. This is the only tier that
  catches a stale caller.
- **tests** — when logic on both sides overlapped. Targeted files via `npx vitest run <paths>` from the
  repo root (never `--root <pkg>`). Budget a few minutes, then stop and report.

**Environment hazards that make build/tests unavailable — say so rather than reporting a weaker check
as a stronger one:**
- A fresh worktree has no `node_modules` and no built artifacts. `npm install` plus
  `npx turbo run build --filter='./packages/*'` provisions it (~a few minutes).
- A worktree **nested inside the root repo** (`.claude/worktrees/<name>/`) with no local
  `node_modules` resolves `@performyard/*` **up into the root checkout**, i.e. whatever branch that
  repo is on. Symptom: floods of phantom errors in files you never touched, with paths pointing
  outside the worktree. `turbo build` does not fix it. Either install, or declare the tier unavailable
  and name CI as the gate.
- The pre-commit hook here is only `node ./webserver/packageVersionCheck.js`. If you must bypass hooks,
  run that command manually and report its result.

## § Escalation (hard stops — SKILL Rule 4)

Stop and present evidence rather than resolving, when:

1. Two sides changed the same logic and the commits/PRs/tickets don't establish which intent should
   win (Class 2).
2. A modify/delete where the deletion reads as intentional but the modification is load-bearing
   (Class 3).
3. Any resolution that would drop a side's work — even a small one — without a clear reason to.
4. The same key/slug/id on both sides with different values.
5. A binary or LFS file needs a side chosen (Class 9).
6. A rebase or force-push is in play, on a branch with an open PR or any chance someone else pulled it.
7. The required verification tier can't run *and* the conflict classes weren't all mechanical.
8. A reformat storm, or a conflict count large enough that a strategy should be agreed first
   (Class 10).
9. The base is wrong for this branch — the PR targets a release branch, or `--from` disagrees with the
   PR's base.
10. Local and remote have diverged on the target branch (not a fast-forward).
