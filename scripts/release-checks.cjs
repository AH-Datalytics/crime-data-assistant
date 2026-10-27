#!/usr/bin/env node
/**
 * Release answer checks for scripts/release.sh (design: docs/superpowers/specs/2026-10-27-server-side-release-design.md).
 *
 *   node release-checks.cjs cookie
 *     Prints the middleware's auth cookie value (nibrs_auth) signed with AUTH_PASSWORD, for the health checks.
 *
 *   node release-checks.cjs ask <questions.json> <base url> <out dir> <session prefix>
 *     Asks every question once, as the page does (empty history, manual routing, the page token and the auth cookie;
 *     both signed the way lib/page-token.ts and middleware.ts verify them: AUTH_PASSWORD, or each one's built-in
 *     secret when the site runs without a password, as production does), and writes <out>/<name>.status, <name>.body and
 *     <out>/sessions.txt ("<name> <sessionId>"). Exits non-zero if any request fails to complete.
 *
 *   node release-checks.cjs validate <questions.json> <dir>
 *     Exits 0 only if every captured answer in <dir> is a complete, successful answer (the same test compare
 *     applies). release.sh runs it on the baseline, so an unusable live answer stops the release before the deploy.
 *
 *   node release-checks.cjs compare <questions.json> <before dir> <after dir> [expected-changes.json]
 *     Fail-closed comparison. Each answer must be HTTP 200 and a complete, successful answer (JSON with
 *     success:true, or SSE whose only data event is type "result"); no error event. After masking only the
 *     enumerated volatile fields, the canonical answer after the switch must equal the one before it. A question
 *     named in expected-changes.json may differ ONLY in the fields its entry lists, and its checker (a module
 *     exporting check(after) -> {ok, why}) must pass. The file and its checkers are read from the tree release.sh
 *     extracted at the target SHA; a checker path must stay inside that tree. Two failed
 *     answers never compare equal: a failed answer fails the check on either side.
 *     Prints one line per question and exits 0 only if every question passes.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const die = (msg) => { console.error(`release-checks: ${msg}`); process.exit(2); };
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (e) { die(`cannot read ${p}: ${e.message}`); } };

function loadQuestions(p) {
  const q = readJson(p);
  if (!Array.isArray(q.questions) || q.questions.length === 0) die(`${p}: no questions`);
  if (!Array.isArray(q.masked)) die(`${p}: no masked list`);
  const names = new Set();
  for (const x of q.questions) {
    if (!/^[A-Za-z0-9_-]+$/.test(x.name || "") || names.has(x.name)) die(`${p}: bad or duplicate name ${x.name}`);
    if (!["/api/query", "/api/nibrs-query"].includes(x.endpoint)) die(`${p}: ${x.name}: unknown endpoint ${x.endpoint}`);
    if (typeof x.question !== "string" || !x.question) die(`${p}: ${x.name}: no question`);
    names.add(x.name);
  }
  return q;
}

/**
 * The middleware's auth cookie (prefix:expires:hmac; middleware.ts, secret AUTH_PASSWORD || "nibrs-dev-secret") and
 * the routes' page token (base64 ts:hmac16; lib/page-token.ts, secret AUTH_PASSWORD || "nibrs-page-token-secret").
 * Without AUTH_PASSWORD the middleware lets every request through and only the page token is checked.
 */
function credentials() {
  const pw = process.env.AUTH_PASSWORD || "";
  const expires = String(Date.now() + 3600_000);
  const payload = `release:${expires}`;
  const cookie = `${payload}:${crypto.createHmac("sha256", pw || "nibrs-dev-secret").update(payload).digest("hex")}`;
  const ts = String(Date.now() - 5000);
  const pageToken = Buffer.from(`${ts}:${crypto.createHmac("sha256", pw || "nibrs-page-token-secret").update(ts).digest("hex").slice(0, 16)}`).toString("base64");
  return { cookie, pageToken };
}

async function ask(qfile, base, out, prefix) {
  const q = loadQuestions(qfile);
  fs.mkdirSync(out, { recursive: true });
  const sessions = [];
  let bad = 0;
  for (const x of q.questions) {
    const sessionId = `${prefix}-${x.name}`;
    const { cookie, pageToken } = credentials();
    const body = { question: x.question, history: [], routingMode: "manual", sessionId, pageToken, ...(x.mode ? { mode: x.mode } : {}) };
    let status = 0, text = "";
    try {
      const res = await fetch(base + x.endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: `nibrs_auth=${cookie}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.RELEASE_ASK_TIMEOUT_MS || 60000)),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = `request failed: ${e.message}`;
      bad += 1;
    }
    fs.writeFileSync(path.join(out, `${x.name}.status`), String(status));
    fs.writeFileSync(path.join(out, `${x.name}.body`), text);
    sessions.push(`${x.name} ${sessionId}`);
    console.log(`ask ${x.name}: HTTP ${status}, ${Buffer.byteLength(text)} bytes`);
  }
  fs.writeFileSync(path.join(out, "sessions.txt"), sessions.join("\n") + "\n");
  if (bad) process.exit(1);
}

/** The answer object, or {error} when the response is not one complete, successful answer. */
function parseAnswer(status, text) {
  if (status !== 200) return { error: `HTTP ${status}` };
  const t = text.trim();
  if (t.startsWith("{")) {
    let j; try { j = JSON.parse(t); } catch { return { error: "malformed JSON" }; }
    if (j.success !== true) return { error: `success=${j.success} ${j.error ?? ""}`.trim() };
    if (!Array.isArray(j.rows) || !Array.isArray(j.columns)) return { error: "no rows/columns" };
    return { answer: j };
  }
  const events = t.split(/\n\n+/).filter(Boolean).map((e) => e.replace(/^data: ?/, ""));
  if (events.length === 0) return { error: "empty body" };
  const parsed = [];
  for (const e of events) { try { parsed.push(JSON.parse(e)); } catch { return { error: "malformed SSE event" }; } }
  if (parsed.some((e) => e.type === "error")) return { error: "error event" };
  const results = parsed.filter((e) => e.type === "result");
  if (results.length !== 1 || parsed.length !== 1) return { error: `expected exactly one result event, got ${parsed.length} event(s), ${results.length} result(s)` };
  if (!Array.isArray(results[0].rows) || !Array.isArray(results[0].columns)) return { error: "no rows/columns" };
  return { answer: results[0] };
}

/** Canonical JSON (sorted keys at every level, arrays in order) of the answer without the masked fields. */
function canonical(answer, masked, skip = []) {
  const drop = new Set([...masked, ...skip]);
  const sort = (v) => (Array.isArray(v) ? v.map(sort) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sort(v[k])])) : v);
  return JSON.stringify(sort(Object.fromEntries(Object.entries(answer).filter(([k]) => !drop.has(k)))));
}

/** The reviewed expected changes, validated: known questions, listed fields, a checker inside the extracted tree. */
function loadExpected(expectedFile, names) {
  const expected = {};
  if (!expectedFile || !fs.existsSync(expectedFile)) return expected;
  const e = readJson(expectedFile);
  if ("root" in e) die(`${expectedFile}: "root" is not allowed; checker paths are relative to the extracted tree`);
  const root = path.resolve(path.dirname(expectedFile), "../../..");
  for (const [name, entry] of Object.entries(e.changes ?? {})) {
    if (!names.has(name)) die(`${expectedFile}: unknown question ${name}`);
    if (!Array.isArray(entry.fields) || entry.fields.length === 0) die(`${expectedFile}: ${name}: no fields listed`);
    if (typeof entry.checker !== "string") die(`${expectedFile}: ${name}: no checker`);
    const checkerPath = path.resolve(root, entry.checker);
    const rel = path.relative(root, checkerPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) die(`${expectedFile}: ${name}: checker ${entry.checker} is outside the release tree`);
    if (!fs.existsSync(checkerPath)) die(`${expectedFile}: ${name}: checker ${entry.checker} not found`);
    const mod = require(checkerPath);
    if (typeof mod.check !== "function") die(`${expectedFile}: ${name}: checker exports no check()`);
    expected[name] = { fields: entry.fields, check: mod.check };
  }
  return expected;
}

function compare(qfile, beforeDir, afterDir, expectedFile) {
  const q = loadQuestions(qfile);
  const expected = loadExpected(expectedFile, new Set(q.questions.map((x) => x.name)));
  const read = (dir, name) => parseAnswer(Number(fs.readFileSync(path.join(dir, `${name}.status`), "utf8")), fs.readFileSync(path.join(dir, `${name}.body`), "utf8"));
  let fail = 0;
  for (const x of q.questions) {
    let before, after;
    try { before = read(beforeDir, x.name); after = read(afterDir, x.name); } catch (e) { console.log(`FAIL ${x.name}: missing capture (${e.message})`); fail += 1; continue; }
    if (before.error) { console.log(`FAIL ${x.name}: the answer before the switch is not a complete answer (${before.error})`); fail += 1; continue; }
    if (after.error) { console.log(`FAIL ${x.name}: the answer after the switch is not a complete answer (${after.error})`); fail += 1; continue; }
    const exp = expected[x.name];
    const same = canonical(before.answer, q.masked, exp?.fields ?? []) === canonical(after.answer, q.masked, exp?.fields ?? []);
    if (!same) { console.log(`FAIL ${x.name}: the answer changed${exp ? ` outside its expected fields (${exp.fields.join(", ")})` : ""}`); fail += 1; continue; }
    if (exp) {
      let r; try { r = exp.check(after.answer); } catch (e) { r = { ok: false, why: `checker threw: ${e.message}` }; }
      if (!r || r.ok !== true) { console.log(`FAIL ${x.name}: expected change not as reviewed (${r?.why ?? "checker failed"})`); fail += 1; continue; }
      console.log(`PASS ${x.name}: unchanged except the reviewed fields (${exp.fields.join(", ")}), checker passed`);
    } else console.log(`PASS ${x.name}: unchanged`);
  }
  process.exit(fail ? 1 : 0);
}

function validate(qfile, dir) {
  const q = loadQuestions(qfile);
  let fail = 0;
  for (const x of q.questions) {
    let r;
    try { r = parseAnswer(Number(fs.readFileSync(path.join(dir, `${x.name}.status`), "utf8")), fs.readFileSync(path.join(dir, `${x.name}.body`), "utf8")); }
    catch (e) { r = { error: `missing capture (${e.message})` }; }
    if (r.error) { console.log(`FAIL ${x.name}: not a complete answer (${r.error})`); fail += 1; } else console.log(`OK ${x.name}`);
  }
  process.exit(fail ? 1 : 0);
}

const [cmd, ...args] = process.argv.slice(2);
if (cmd === "cookie" && args.length === 0) console.log(credentials().cookie);
else if (cmd === "ask" && args.length === 4) ask(...args).catch((e) => die(e.message));
else if (cmd === "validate" && args.length === 2) validate(...args);
else if (cmd === "expected" && args.length === 2) { const q = loadQuestions(args[0]); const e = loadExpected(args[1], new Set(q.questions.map((x) => x.name))); console.log(`expected changes: ${Object.keys(e).join(", ") || "none"}`); }
else if (cmd === "compare" && (args.length === 3 || args.length === 4)) compare(...args);
else die("usage: cookie | expected <questions.json> <expected-changes.json> | ask <questions.json> <base url> <out dir> <session prefix> | validate <questions.json> <dir> | compare <questions.json> <before> <after> [expected-changes.json]");
