// Read-only in-flight dashboard server: fetches Jira/GitHub data and serves the UI.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, CONFIG } from "./lib/config.js";
import { buildItems } from "./lib/model.js";
import { getUpstream } from "./lib/integrations.js";

const buildSnapshot = async () => {
  const upstream = await getUpstream();
  return {
    fetchedAt: upstream.fetchedAt,
    sources: upstream.sources,
    items: buildItems(upstream.jiraIssues, upstream.github.mine, upstream.github.merged),
    reviewRequests: upstream.github.reviewRequests,
  };
};

const json = (res, code, body) => {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/api/data") {
      json(res, 200, await buildSnapshot());
    } else if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(ROOT, "index.html")));
    } else {
      json(res, 404, { error: "not found" });
    }
  } catch (err) {
    json(res, 500, { error: err.message });
  }
}).listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`inflight dashboard -> http://localhost:${CONFIG.port}`);
});
