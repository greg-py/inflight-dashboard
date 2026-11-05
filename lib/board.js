import { fetchJira } from "./jira.js";
import { fetchGithub } from "./github.js";
import { readReleaseInFlight, readContext } from "./local.js";
import { buildLedger } from "./ledger.js";

// A source that fails becomes an error line on the page, not an empty board.
const attempt = async (name, fetcher, errors) => {
  try {
    return await fetcher();
  } catch (err) {
    errors.push(`${name}: ${err.message}`);
    return null;
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
  };
};
