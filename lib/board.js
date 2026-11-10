import { fetchJira } from "./jira.js";
import { fetchGithub } from "./github.js";
import { readReleaseInFlight, readContext } from "./local.js";
import { buildLedger } from "./ledger.js";
import { CONFIG } from "./config.js";

// A source that fails becomes an error line on the page, and the board keeps
// that source's last good answer instead of going empty.
const lastGood = {};
const attempt = async (name, fetcher, errors) => {
  try {
    return (lastGood[name] = { at: new Date(), value: await fetcher() }).value;
  } catch (err) {
    const kept = lastGood[name];
    errors.push(`${name}: ${err.message}${kept ? ` · showing ${name} as of ${kept.at.toLocaleTimeString()}` : ""}`);
    return kept?.value ?? null;
  }
};

export const buildBoard = async () => {
  const errors = [];
  const [jira, github] = await Promise.all([attempt("Jira", fetchJira, errors), attempt("GitHub", fetchGithub, errors)]);
  const now = new Date();
  const context = readContext();
  if (context?.error) errors.push(context.error);
  return {
    fetchedAt: now.toISOString(),
    errors,
    rows: buildLedger({
      me: github?.login ?? "",
      tickets: jira?.tickets ?? [],
      podTickets: jira?.podTickets ?? [],
      ungroomed: jira?.ungroomed ?? [],
      myPrs: github?.myPrs ?? [],
      otherPrs: github?.otherPrs ?? [],
      release: github?.release ?? null,
      now,
    }),
    sprint: jira?.sprint ?? null,
    release: github?.release ? { ...github.release, inFlight: readReleaseInFlight() } : null,
    context: context?.error ? null : context,
    // What the page needs to turn any ticket key or PR number into a link.
    links: { project: CONFIG.project, ticket: `${CONFIG.jiraBaseUrl}/browse/`, repo: CONFIG.repo },
  };
};
