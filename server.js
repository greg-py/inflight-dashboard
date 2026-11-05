import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, CONFIG } from "./lib/config.js";
import { buildBoard } from "./lib/board.js";

// Answer from the last good board at once and rebuild it in the background,
// so the page only waits on Jira and GitHub when it asks to.
let cache = null;
let building = null;
const rebuild = () => (building ??= buildBoard()
  .then((data) => (cache = { at: Date.now(), data }).data)
  .finally(() => { building = null; }));

const board = (fresh) => {
  if (fresh || !cache) return rebuild();
  if (Date.now() - cache.at > CONFIG.cacheMs) rebuild().catch(() => {});
  return cache.data;
};

const page = join(ROOT, "public", "index.html");

createServer(async (req, res) => {
  const { pathname, searchParams } = new URL(req.url, "http://localhost");
  try {
    if (pathname === "/api/board") {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(await board(searchParams.has("fresh"))));
    } else if (pathname === "/") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(readFileSync(page));
    } else {
      res.writeHead(404).end();
    }
  } catch (err) {
    res.writeHead(500, { "Content-Type": "application/json" }).end(JSON.stringify({ error: err.message }));
  }
}).listen(CONFIG.port, "127.0.0.1", () => {
  console.log(`inflight → http://localhost:${CONFIG.port}`);
  const log = (err) => console.error(err.message);
  rebuild().catch(log);
  setInterval(() => rebuild().catch(log), 2 * CONFIG.cacheMs);
});
