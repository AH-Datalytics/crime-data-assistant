#!/usr/bin/env node
// Test double for scripts/test-release.sh: the two answer endpoints of the public site. The answer depends on the
// release the fake current link points at (its `variant` file): same | changed-title | changed-rows | error | model.
// Every answer is logged as "<sessionId> <model>" to the fake query log, the way query_log rows are written.
//   node fake-site.cjs <port> <nibrs root> <query log file>
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");
const [port, root, qlog] = process.argv.slice(2);
const variant = () => { try { return fs.readFileSync(path.join(root, "current", "variant"), "utf8").trim(); } catch { return "same"; } };
http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    let body = {};
    try { body = JSON.parse(raw); } catch { res.writeHead(400); return res.end("bad json"); }
    if (!/^nibrs_auth=release:\d+:[0-9a-f]{64}$/.test(req.headers.cookie || "") || !body.pageToken) { res.writeHead(401); return res.end('{"success":false,"error":"Unauthorized"}'); }
    const v = variant();
    fs.appendFileSync(qlog, `${body.sessionId} ${v === "model" ? "claude-haiku" : "deterministic"}\n`);
    const answer = {
      sql: "SELECT 1", explanation: `Answer to ${body.question}.`, title: v === "changed-title" ? "A New Title" : `Title for ${body.question}`,
      columns: ["period", "value"], rows: v === "changed-rows" ? [{ period: 2025, value: 999 }] : [{ period: 2025, value: 190 }],
      rowCount: 1, truncated: false, chartConfig: null, chartMeta: { source: "X", agencyCount: 0, population: null },
      executionTimeMs: Math.floor(Math.random() * 900),
    };
    if (req.url === "/api/query") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (v === "error") return res.end(`data: ${JSON.stringify({ type: "error", error: "boom" })}\n\n`);
      return res.end(`data: ${JSON.stringify({ type: "result", requestId: Math.random().toString(36), ...answer })}\n\n`);
    }
    if (req.url === "/api/nibrs-query") {
      res.writeHead(200, { "content-type": "application/json" });
      if (v === "error") return res.end(JSON.stringify({ success: false, error: "boom" }));
      return res.end(JSON.stringify({ success: true, question: body.question, ...answer }));
    }
    res.writeHead(404); res.end();
  });
}).listen(Number(port), "127.0.0.1", () => console.log(`fake site on ${port}`));
