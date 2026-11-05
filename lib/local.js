import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.js";

// The production-release skill keeps one state file per release; the newest
// one that is not released yet is the release in flight.
export const readReleaseInFlight = () => {
  if (!existsSync(CONFIG.releasesDir)) return null;
  const files = readdirSync(CONFIG.releasesDir)
    .filter((f) => /^v\d{4}\.\d{2}\.\d{2}(\.\d+)?\.md$/.test(f))
    .map((f) => ({ f, at: statSync(join(CONFIG.releasesDir, f)).mtimeMs }))
    .sort((a, b) => b.at - a.at);
  for (const { f } of files.slice(0, 3)) {
    const text = readFileSync(join(CONFIG.releasesDir, f), "utf8");
    const status = text.match(/^Status:\s*(.+)$/m)?.[1]?.trim() ?? "";
    if (/released|abandoned|cancel/i.test(status)) continue;
    const gates = [...text.matchAll(/^- \[( |x)\] (.+)$/gm)];
    const nextGate = gates.find((g) => g[1] === " ")?.[2] ?? null;
    return {
      version: f.replace(/\.md$/, ""),
      status,
      done: gates.filter((g) => g[1] === "x").length,
      total: gates.length,
      nextGate: nextGate?.replace(/\s*\(.*$/, "") ?? null,
    };
  }
  return null;
};

// Slack, meeting notes and calendar arrive through a Claude routine that
// writes this file; the board shows whatever it finds, and how old it is.
export const readContext = () => {
  if (!existsSync(CONFIG.contextFile)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG.contextFile, "utf8"));
  } catch (err) {
    return { error: `context.json: ${err.message}` };
  }
};
