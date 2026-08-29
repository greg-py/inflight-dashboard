// One-shot, read-only headless claude runs that turn red signals into causes.
// Cached per (PR, state) key; failed runs retry after a cooldown.
import { execFile } from "node:child_process";
import { CONFIG, repoPathFor } from "./config.js";
import { diagnosisKeyFor, parseDiagnosis } from "./model.js";
import { state, saveState, appendJournal } from "./state.js";

const diagnosisPromptFor = (pr, key) =>
  key.startsWith("ci:")
    ? `PR #${pr.number} in ${pr.repo} has failing CI on its latest commit. Run gh pr checks ${pr.number} --repo ${pr.repo} to find the failing checks, then inspect their logs (gh run view --log-failed). IGNORE the "${CONFIG.qaGateCheck}" check entirely — it is a human approval gate, not CI, and it is never the answer; diagnose the OTHER failing check(s). Known rerun-safe flaky patterns in this codebase: ${CONFIG.diagnosis.knownFlakes.join("; ")}. Decide whether the failure is a known-pattern flake or a real defect. Reply with EXACTLY one final line, nothing after it: "FLAKE: <which pattern, ≤15 words>" or "REAL: <root cause, ≤15 words>".`
    : `PR #${pr.number} in ${pr.repo} has review feedback: a changes-requested review and/or unresolved comment threads (possibly from the codex review bot). Read it all (gh pr view ${pr.number} --repo ${pr.repo} --comments, and gh api repos/${pr.repo}/pulls/${pr.number}/comments for inline threads), ignoring threads whose last word is the PR author's. Summarize what the reviewer(s) and bot(s) actually want changed. Reply with EXACTLY one final line, nothing after it: "WANTS: <the asks, ≤25 words>".`;

const diagnosing = new Set();

const runDiagnosis = (pr, key) => {
  diagnosing.add(key);
  const args = [
    "-p",
    diagnosisPromptFor(pr, key),
    "--model",
    CONFIG.diagnosis.model,
    "--max-turns",
    String(CONFIG.diagnosis.maxTurns),
    ...CONFIG.diagnosis.allowedTools.flatMap((tool) => ["--allowedTools", tool]),
  ];
  execFile(
    "claude",
    args,
    { cwd: repoPathFor(pr.repo), timeout: CONFIG.diagnosis.timeoutMs, encoding: "utf8" },
    (err, stdout) => {
      diagnosing.delete(key);
      const parsed = err ? null : parseDiagnosis(stdout);
      state.diagnoses.set(
        key,
        parsed
          ? { ...parsed, at: Date.now() }
          : {
              kind: "error",
              detail: String(err?.message ?? "unparseable output").slice(0, 120),
              at: Date.now(),
            },
      );
      saveState();
      if (parsed) {
        appendJournal({
          actor: "diagnosis",
          action: key.startsWith("ci:") ? "diagnosed CI failure" : "digested review feedback",
          id: `${pr.repo}#${pr.number}`,
          detail: `${parsed.kind}: ${parsed.detail}`,
        });
      }
    },
  );
};

// Diagnose any undiagnosed red signal on non-parked PRs (ticket-attached
// drafts included — they're the pipeline's own output).
export const scheduleDiagnoses = (items) => {
  if (!CONFIG.diagnosis.enabled) return;
  for (const item of items) {
    for (const pr of item.prs ?? []) {
      if (pr.isDraft && !item.key) continue;
      const key = diagnosisKeyFor(pr);
      if (!key || diagnosing.has(key)) continue;
      const existing = state.diagnoses.get(key);
      if (
        existing &&
        !(existing.kind === "error" && Date.now() - existing.at > CONFIG.diagnosis.errorRetryMs)
      ) {
        continue;
      }
      if (diagnosing.size >= CONFIG.diagnosis.maxConcurrent) return;
      runDiagnosis(pr, key);
    }
  }
};

export const attachDiagnoses = (items) => {
  for (const item of items) {
    for (const pr of item.prs ?? []) {
      const key = diagnosisKeyFor(pr);
      const diagnosis = key ? state.diagnoses.get(key) : null;
      if (diagnosis && diagnosis.kind !== "error") pr.diagnosis = diagnosis;
    }
  }
};
