import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, CONFIG } from "./lib/config.js";
import { fetchJira } from "./lib/jira.js";
import { fetchGithub } from "./lib/github.js";
import { readReleaseInFlight, readContext } from "./lib/local.js";
import { buildLedger, STAGES } from "./lib/ledger.js";

const settle = async (name, fn, errors) => {
  try {
    return await fn();
  } catch (err) {
    errors.push(`${name}: ${err.message}`);
    return null;
  }
};

const snapshot = async () => {
  const errors = [];
  const [jira, github] = await Promise.all([settle("Jira", fetchJira, errors), settle("GitHub", fetchGithub, errors)]);
  const now = new Date();
  const rows = buildLedger({
    me: { login: github?.login ?? "", accountId: jira?.me ?? "" },
    tickets: jira?.tickets ?? [],
    podTickets: jira?.podTickets ?? [],
    groom: jira?.groom ?? [],
    myPrs: github?.myPrs ?? [],
    allPrs: github?.allPrs ?? [],
    release: github?.release ?? null,
    now,
  });
  return {
    fetchedAt: now.toISOString(),
    errors,
    stages: STAGES,
    rows,
    sprint: jira?.sprint ?? null,
    release: github?.release && {
      tag: github.release.tag,
      publishedAt: github.release.publishedAt,
      draft: github.release.draft,
      aheadBy: github.release.aheadBy,
      unreleased: github.release.unreleased,
      inFlight: readReleaseInFlight(),
    },
    context: readContext(),
    jiraBaseUrl: CONFIG.jiraBaseUrl,
    me: github?.login ?? "",
  };
};

// Serve the last good snapshot instantly and refresh behind it, so the page
// never waits on Jira and GitHub unless it asks to.
let cache = null;
let inflight = null;
const refresh = () => (inflight ??= snapshot()
  .then((data) => { cache = { at: Date.now(), data }; return data; })
  .finally(() => { inflight = null; }));
const board = async (fresh) => {
  if (fresh || !cache) return refresh();
  if (Date.now() - cache.at > CONFIG.cacheMs) refresh().catch(() => {});
  return cache.data;
};

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (url.pathname === "/api/board") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(await board(url.searchParams.has("fresh"))));
    } else if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(ROOT, "public", "index.html")));
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
}).listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`ledger → http://localhost:${CONFIG.port}`);
  refresh().catch((err) => console.error(err.message));
  setInterval(() => refresh().catch((err) => console.error(err.message)), 2 * CONFIG.cacheMs);
});
