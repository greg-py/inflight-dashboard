import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.js";

// The production-release skill keeps one state file per release; the newest
// one not yet released is the release in flight, and its first unchecked gate
// is the next step.
export const readReleaseInFlight = () => {
  if (!existsSync(CONFIG.releasesDir)) return null;
  const files = readdirSync(CONFIG.releasesDir)
    .filter((f) => /^v\d{4}\.\d{2}\.\d{2}(\.\d+)?\.md$/.test(f))
    .map((f) => join(CONFIG.releasesDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    .slice(0, 3);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const status = text.match(/^Status:\s*(.+)$/m)?.[1]?.trim() ?? "";
    if (/released|abandoned|cancel/i.test(status)) continue;
    const gate = text.match(/^- \[ \] (.+)$/m)?.[1];
    return { version: file.split("/").pop().replace(/\.md$/, ""), next: gate?.replace(/\s*\(.*$/, "") ?? status };
  }
  return null;
};

// Slack, meetings and calendar have no local credentials; a Claude routine
// writes them to this file and the board shows whatever is there.
export const readContext = () => {
  if (!existsSync(CONFIG.contextFile)) return null;
  try {
    return JSON.parse(readFileSync(CONFIG.contextFile, "utf8"));
  } catch (err) {
    return { error: `context.json: ${err.message}` };
  }
};
