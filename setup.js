import { readdirSync, existsSync, mkdirSync, symlinkSync, lstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const skillsSource = join(dirname(fileURLToPath(import.meta.url)), "skills");
const targets = [join(homedir(), ".claude", "skills"), join(homedir(), ".codex", "skills")];

for (const targetDir of targets) {
  mkdirSync(targetDir, { recursive: true });
  for (const skill of readdirSync(skillsSource)) {
    const link = join(targetDir, skill);
    const exists = (() => {
      try {
        lstatSync(link);
        return true;
      } catch {
        return false;
      }
    })();
    if (exists) {
      console.log(`skip   ${link} (already present — keeping yours)`);
    } else {
      symlinkSync(join(skillsSource, skill), link);
      console.log(`linked ${link}`);
    }
  }
}
console.log("\nSkills are symlinked to this repo, so `git pull` updates them in place.");
if (!existsSync(join(dirname(fileURLToPath(import.meta.url)), ".env"))) {
  console.log("Reminder: copy .env.example to .env and fill in JIRA_EMAIL and JIRA_API_TOKEN.");
}
