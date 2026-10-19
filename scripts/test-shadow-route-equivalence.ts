/**
 * Enabling shadow changes nothing a caller receives from the four QUERY routes.
 *
 * Handoff §9.1 Stage 1: "Prove with response fixtures/snapshots that enabling shadow
 * does not change routing, SQL, retry decisions, rows, narrative, charts,
 * clarification/decline behavior, or user-visible payloads." Invariant 14 and §449 say
 * it in stronger terms: off and shadow "cannot change routing, SQL, retries, rows,
 * narrative, charts".
 *
 * WHY THIS EXISTS SEPARATELY FROM test-shadow-equivalence.ts. That suite proves the
 * embed route byte-for-byte, then substitutes a unit assertion -- emitFactualPayload
 * returns its argument -- for the four query routes. That assertion is true and
 * insufficient: it covers the terminal helper, not mode-dependent work EARLIER in a
 * route. Cache key selection is exactly such work, and a defect there (shadow taking a
 * fingerprinted key while off took the baseline key, so enabling shadow silently
 * re-invoked the model and was free to return different SQL, rows, narrative and charts)
 * passed that suite untouched. Handler-level fixtures are the actual proof.
 *
 * WHY THE MODEL-CALL SEQUENCE IS THE PRIMARY ASSERTION, NOT THE PAYLOAD. The stub
 * returns constant SQL, so two responses can agree byte-for-byte while one of them
 * quietly re-invoked the model -- which is precisely the defect. In production that
 * second invocation is free to return something different. So the sequence of model
 * calls carries the proof and the payload comparison corroborates it. When this suite
 * was first run against the unfixed cache, the byte comparison passed and only the call
 * sequence failed.
 *
 * WHY WARM IS NOT ZERO CALLS. A cache hit skips TRANSLATION but still regenerates the
 * post-query narrative, so a warm factual request legitimately consults the model once.
 * The invariant asserted here is therefore: zero TRANSLATION calls on a warm cache, and
 * an identical call sequence between off and shadow. Asserting a bare zero would fail
 * against correct behavior.
 *
 * HOW TO CONFIRM THESE COMPARISONS ARE STILL LIVE. Make the stub's reply depend on the
 * mode -- e.g. append a word to `title` when PROOF_MODE is shadow -- and every cold
 * comparison must fail. Perturbing the QUESTION instead is not a valid probe: the
 * Current/Historical SSE payload does not echo the question, so that route passes while
 * the other three fail. (The warm comparisons correctly stay green under the title probe,
 * because a cache hit never reaches the model at all.)
 *
 * WHAT IS NORMALIZED, AND WHY THAT IS SAFE. `executionTimeMs` is wall-clock and
 * `requestId` is a fresh uuid per response; both differ between any two calls for
 * reasons that have nothing to do with proof. Nothing else is touched, so a
 * proof-caused difference cannot hide inside the normalization.
 */
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";
import Database from "better-sqlite3";
import { __resetResponseCacheForTests } from "../lib/response-cache";

let passed = 0;
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

/** A page token must be between 1 second and 1 hour old, so a freshly generated one fails. */
function agedPageToken(): string {
  const secret = process.env.AUTH_PASSWORD || "nibrs-page-token-secret";
  const ts = String(Date.now() - 5_000);
  const sig = createHmac("sha256", secret).update(ts).digest("hex").slice(0, 16);
  return Buffer.from(`${ts}:${sig}`).toString("base64");
}

/**
 * The query routes rate-limit to 5 requests per minute per IP and this suite issues far
 * more than that. A distinct IP per request keeps the limiter out of the comparison --
 * without it, later requests would 429 for reasons unrelated to proof.
 */
let ipCounter = 0;
function nextIp(): string {
  ipCounter += 1;
  return `10.${Math.floor(ipCounter / 250) % 250}.${ipCounter % 250}.1`;
}

type CallKind = "translate" | "explain" | "other";
type ModelReply = { sql: string; explanation: string; title?: string; chartHint?: string; xAxis?: string; yAxis?: string | string[] };

/**
 * Stands in for the Anthropic API and records the KIND of each call.
 *
 * Kind is read off the system prompt rather than the URL, because a route consults the
 * model for two different jobs and only one of them is the cacheable translation.
 */
function installModelStub(initial: ModelReply) {
  const realFetch = globalThis.fetch;
  let reply = initial;
  const sequence: CallKind[] = [];
  globalThis.fetch = (async (input: unknown, init?: unknown) => {
    const url = typeof input === "string" ? input : String((input as { url?: string })?.url ?? "");
    if (!url.includes("api.anthropic.com")) {
      return (realFetch as (i: unknown, n?: unknown) => Promise<Response>)(input, init);
    }
    let kind: CallKind = "other";
    try {
      const body = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
      const system = String((Array.isArray(body.system) ? body.system[0]?.text : body.system) ?? "");
      // Current/Historical and NIBRS open with "SQL query generator"; SHR and Hate Crime
      // open with "translates natural-language questions about ... data into SQL".
      if (system.includes("SQL query generator") || system.includes("translates natural-language questions")) kind = "translate";
      else if (system.includes("descriptions of crime data query results")) kind = "explain";
    } catch { /* leaves kind as "other", which no assertion expects */ }
    // Two diagnostics for adding a route or a fixture, both off by default.
    // DEBUG_PROMPTS surfaces a system prompt this classifier does not recognize -- an
    // unrecognized translation call would otherwise be bucketed as "other" and make the
    // warm-cache assertions pass VACUOUSLY, which is how the SHR and Hate Crime fixtures
    // first appeared to succeed. DEBUG_RETRY prints the instruction that provoked a
    // second translation, which is what identified SHR's missing homicide_type filter.
    if (kind === "other" && process.env.DEBUG_PROMPTS) {
      try {
        const b = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
        const sysText = String((Array.isArray(b.system) ? b.system[0]?.text : b.system) ?? "(none)");
        console.log(`  UNCLASSIFIED max_tokens=${b.max_tokens} :: ${sysText.slice(0, 110).replace(/\s+/g, " ")}`);
      } catch {}
    }
    sequence.push(kind);
    if (process.env.DEBUG_RETRY && kind === "translate" && sequence.filter((k) => k === "translate").length > 1) {
      try {
        const b = JSON.parse(String((init as { body?: string })?.body ?? "{}"));
        const last = b.messages?.[b.messages.length - 1];
        console.log(`  RETRY_REASON :: ${String(last?.content ?? "").slice(0, 400).replace(/\s+/g, " ")}`);
      } catch {}
    }
    return new Response(JSON.stringify({
      id: "msg_stub",
      type: "message",
      role: "assistant",
      model: "claude-haiku-4-5-20251001",
      content: [{ type: "text", text: kind === "explain"
        ? reply.explanation
        : JSON.stringify({
            sql: reply.sql,
            explanation: reply.explanation,
            title: reply.title ?? "",
            chartHint: reply.chartHint ?? "none",
            xAxis: reply.xAxis ?? "",
            yAxis: reply.yAxis ?? "",
          }) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof globalThis.fetch;
  return {
    sequence: () => [...sequence],
    reset: () => { sequence.length = 0; },
    restore: () => { globalThis.fetch = realFetch; },
    setReply: (next: ModelReply) => { reply = next; },
  };
}

/** Everything a caller can observe, with only per-request volatiles neutralized. */
async function observe(res: Response) {
  const raw = await res.text();
  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    body: raw
      .replace(/"executionTimeMs":\s*\d+/g, '"executionTimeMs":<ms>')
      .replace(/"requestId":\s*"[^"]*"/g, '"requestId":"<id>"'),
  };
}

type RouteCase = {
  /** Displayed, and used to keep each route's fixture questions distinct. */
  label: string;
  importPath: string;
  reply: ModelReply;
  question: string;
  /**
   * The model calls a COLD factual request makes on this route, in order.
   *
   * Recorded per route rather than assumed, because the routes genuinely differ:
   * Current/Historical and NIBRS follow the translation with a separate narrative pass,
   * while SHR and Hate Crime answer from the translation alone. An earlier version of
   * this suite asserted one universal sequence and failed against correct behavior on
   * two routes. What must NOT vary is this sequence between off and shadow.
   */
  coldCalls: CallKind[];
};

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shadowroute-"));
  const paths = {
    rtci: path.join(dir, "crime_data.db"),
    log: path.join(dir, "query_log.db"),
    nibrs: path.join(dir, "nibrs.db"),
    rollup: path.join(dir, "nibrs_rollups.db"),
    shr: path.join(dir, "shr.db"),
    hc: path.join(dir, "hate_crime.db"),
  };

  /**
   * Every fixture is created in WAL mode.
   *
   * getManagedDb opens these readonly and then sets `journal_mode = WAL`. Production
   * databases are already WAL so that pragma is a no-op, but a freshly created fixture
   * is in `delete` mode, where the same pragma needs write access and throws -- which
   * surfaced as the route's generic "Could not open nibrs.db".
   */
  {
    const db = new Database(paths.rtci);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE agencies (ori TEXT, agency_name TEXT, state TEXT, total_months INTEGER);
      CREATE TABLE agency_monthly (ori TEXT, agency_name TEXT, agency TEXT, state TEXT, type TEXT, year INTEGER, month INTEGER, offense TEXT, count INTEGER, murders INTEGER, population INTEGER);
      CREATE TABLE agency_population (ori TEXT, year INTEGER, population INTEGER);
    `);
    db.prepare("INSERT INTO agencies VALUES (?,?,?,?)").run("TX0001", "Austin", "TX", 96);
    // `agency` as well as `agency_name`: the shadow omission probe looks for the former,
    // and its absence produced a caught-but-noisy failure on every request.
    // Request accounting stage 3a: the production RTCI columns (type, offense, count) as well, since a Current number is now
    // compiled by the application from them.
    const ins = db.prepare("INSERT INTO agency_monthly VALUES (?,?,?,?,?,?,?,?,?,?,?)");
    for (const year of [2019, 2020, 2021, 2022]) {
      for (let month = 1; month <= 12; month++) ins.run("TX0001", "Austin", "Austin", "TX", "City", year, month, "Murder", 3, 3, 950_000);
    }
    db.prepare("INSERT INTO agency_population VALUES (?,?,?)").run("TX0001", 2022, 950_000);
    db.close();
  }
  {
    const db = new Database(paths.log);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE query_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, tab TEXT, question TEXT, sql TEXT,
      row_count INTEGER, error TEXT, duration_ms INTEGER, response TEXT, guardrails TEXT,
      model TEXT, session_id TEXT, chart_config TEXT, request_id TEXT, model_response TEXT,
      delivery_action TEXT, proof_mode TEXT, proof_manifest TEXT)`);
    db.close();
  }
  {
    const db = new Database(paths.nibrs);
    db.pragma("journal_mode = WAL");
    db.exec(`CREATE TABLE summary_victim_state_monthly (
      state TEXT, year INTEGER, month INTEGER, offense TEXT, victim_count INTEGER)`);
    const ins = db.prepare("INSERT INTO summary_victim_state_monthly VALUES (?,?,?,?,?)");
    for (const year of [2019, 2020, 2021, 2022]) {
      for (let month = 1; month <= 12; month++) ins.run("TX", year, month, "murder", 4);
    }
    db.close();
  }
  {
    const db = new Database(paths.rollup);
    db.pragma("journal_mode = WAL");
    db.exec("CREATE TABLE rollup_meta (key TEXT, value TEXT)");
    db.close();
  }
  {
    const db = new Database(paths.shr);
    db.pragma("journal_mode = WAL");
    // `month` is required by the SHR fact loader's data-cutoff query.
    // homicide_type matters: the SHR route requires `homicide_type = 'Murder'` on any
    // murder question, and retried with the model when the stubbed SQL omitted it.
    // Request accounting (plan r2.1): SHR numbers are compiled by the application over incidents joined to
    // victims, so the fixture carries both tables (one victim per incident).
    db.exec(`CREATE TABLE incidents (
      id INTEGER PRIMARY KEY, ori TEXT, year INTEGER, month INTEGER, state TEXT, state_name TEXT, agency TEXT, homicide_type TEXT,
      victim_count INTEGER, weapon TEXT, weapon_group TEXT, circumstance TEXT)`);
    db.exec("CREATE TABLE victims (id INTEGER PRIMARY KEY, incident_id INTEGER, victim_num INTEGER, sex TEXT, race TEXT, ethnicity TEXT, age TEXT, age_num INTEGER)");
    const ins = db.prepare("INSERT INTO incidents VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
    const vic = db.prepare("INSERT INTO victims VALUES (?,?,1,'Male','White','Unknown','30',30)");
    let n = 0;
    for (const year of [2019, 2020, 2021, 2022]) {
      for (let month = 1; month <= 12; month++) { n += 1; ins.run(n, "TX0001", year, month, "TX", "Texas", "Austin", "Murder", 1, "Handgun", "Firearm", "argument"); vic.run(n, n); }
    }
    db.close();
  }
  {
    const db = new Database(paths.hc);
    db.pragma("journal_mode = WAL");
    // `ori` and `incident_number` are required by the default incident-count pattern, and by the
    // guardrail that rewrites an aliased COUNT(*) into COUNT(DISTINCT ori); without them, schema
    // validation failed and the route went back to the model for a recovery retry -- an extra call
    // unrelated to proof.
    db.exec(`CREATE TABLE hate_crime_incidents (
      incident_number TEXT, ori TEXT, year INTEGER, state_abbr TEXT, bias_motivation TEXT, offense_name TEXT, victim_count INTEGER)`);
    const ins = db.prepare("INSERT INTO hate_crime_incidents VALUES (?,?,?,?,?,?,?)");
    for (const year of [2019, 2020, 2021, 2022]) {
      for (let i = 0; i < 6; i++) ins.run(`HC-${year}-${i}`, `TX000${i}`, year, "TX", "Anti-Black", "Intimidation", 1);
    }
    db.close();
  }

  // All set before importing ANY route: lib/claude.ts constructs the Anthropic client at
  // module scope, and lib/dynamic-facts.ts introspects every database at module load.
  process.env.ANTHROPIC_API_KEY = "sk-ant-test-stub";
  process.env.RTCI_DB_PATH = paths.rtci;
  process.env.QUERY_LOG_DB_PATH = paths.log;
  process.env.NIBRS_DB_PATH = paths.nibrs;
  process.env.NIBRS_ROLLUP_DB_PATH = paths.rollup;
  process.env.SHR_DB_PATH = paths.shr;
  process.env.HATE_CRIME_DB_PATH = paths.hc;
  delete process.env.PROOF_MODE;

  const stub = installModelStub({ sql: "SELECT 1", explanation: "placeholder" });
  const { NextRequest } = await import("next/server");

  const ROUTES: RouteCase[] = [
    {
      label: "app/api/query",
      importPath: "../app/api/query/route",
      question: "how many murders in Austin, TX each year from 2019 to 2022",
      // Request accounting stage 3a: a numeric Current answer is compiled by the application from a supported question type
      // (here C1 by year), so the cold path makes NO model call and the stub below is never asked. The suite still proves
      // off and shadow deliver the same bytes.
      coldCalls: [],
      reply: {
        sql: "SELECT year, SUM(murders) AS murders FROM agency_monthly WHERE agency_name = 'Austin' AND state = 'TX' AND year BETWEEN 2019 AND 2022 GROUP BY year ORDER BY year",
        explanation: "Murders in Austin, TX by year.",
        title: "Murders in Austin",
        chartHint: "line",
        xAxis: "year",
        yAxis: "murders",
      },
    },
    {
      label: "app/api/nibrs-query",
      importPath: "../app/api/nibrs-query/route",
      question: "how many murder victims in Texas each year from 2019 to 2022",
      // Request accounting stage 2b: a numeric NIBRS answer is compiled by the application from a supported question type
      // (here N1, a state series), so the cold path makes NO model call and the stub below is never asked. The suite still
      // proves off and shadow deliver the same bytes.
      coldCalls: [],
      reply: {
        sql: "SELECT year, SUM(victim_count) AS victims FROM summary_victim_state_monthly WHERE state = 'TX' AND offense = 'murder' AND year BETWEEN 2019 AND 2022 GROUP BY year ORDER BY year",
        explanation: "Murder victims in Texas by year.",
        title: "Murder victims in Texas",
        chartHint: "line",
        xAxis: "year",
        yAxis: "victims",
      },
    },
    {
      label: "app/api/shr-query",
      importPath: "../app/api/shr-query/route",
      // GC-080 (owner ruling): "homicide" now selects the all-homicide licence, and this stub is
      // murder-restricted, so the question says murder. The suite tests caching, not the measure.
      // Request accounting (stage 1): the stub now groups by weapon as the question asks. It grouped by
      // year only, silently dropping "by weapon", and the route now refuses exactly that.
      question: "how many murder victims in Texas each year from 2019 to 2022 by weapon",
      // Request accounting (plan r2.1): an SHR number is compiled by the application, so the cold path makes NO model
      // call; the stub below is never asked. The suite still proves off and shadow deliver the same bytes.
      coldCalls: [],
      reply: {
        sql: "SELECT year, weapon, SUM(victim_count) AS victims FROM incidents WHERE state = 'TX' AND homicide_type = 'Murder' AND year BETWEEN 2019 AND 2022 GROUP BY year, weapon ORDER BY year",
        explanation: "Homicide victims in Texas by year.",
        title: "Homicide victims in Texas",
        chartHint: "line",
        xAxis: "year",
        yAxis: ["victims"],
      },
    },
    {
      label: "app/api/hc-query",
      importPath: "../app/api/hc-query/route",
      question: "how many anti-Black hate crime incidents in Texas each year from 2019 to 2022",
      coldCalls: ["translate"],
      reply: {
        // hc-claude.ts:23 defines the DEFAULT hate-crime measure as
        // COUNT(DISTINCT incident_number || ori || year); a bare COUNT(*) here is `offense_count`.
        // This fixture is about cache equivalence, so it uses the product's own default pattern.
        sql: "SELECT year, COUNT(DISTINCT incident_number || '|' || ori || '|' || year) AS incidents FROM hate_crime_incidents WHERE state_abbr = 'TX' AND bias_motivation = 'Anti-Black' AND year BETWEEN 2019 AND 2022 GROUP BY year ORDER BY year",
        explanation: "Anti-Black hate crime incidents in Texas by year.",
        title: "Anti-Black hate crimes in Texas",
        chartHint: "line",
        xAxis: "year",
        yAxis: ["incidents"],
      },
    },
  ];

  for (const route of ROUTES) {
    const { POST } = (await import(route.importPath)) as { POST: (req: unknown) => Promise<Response> };
    stub.setReply(route.reply);

    async function underMode(mode: string | undefined, question: string) {
      const before = process.env.PROOF_MODE;
      if (mode === undefined) delete process.env.PROOF_MODE;
      else process.env.PROOF_MODE = mode;
      stub.reset();
      try {
        const res = await POST(new NextRequest(`http://localhost/${route.importPath}`, {
          method: "POST",
          body: JSON.stringify({ question, pageToken: agedPageToken() }),
          headers: { "Content-Type": "application/json", "x-forwarded-for": nextIp() },
        }));
        const observed = await observe(res);
        return { ...observed, calls: stub.sequence() };
      } finally {
        if (before === undefined) delete process.env.PROOF_MODE;
        else process.env.PROOF_MODE = before;
      }
    }

    console.log(`\n${route.label} -- cold path`);
    {
      // Questions are unique per scenario: the response cache is module-level and
      // per-process, so sharing one would leak warmth and make call sequences meaningless.
      // THE SAME question in both modes, each run genuinely cold.
      //
      // An earlier version asked `cold-off` in one mode and `cold-shadow` in the other,
      // which made a body comparison impossible -- two different questions may legitimately
      // produce different answers -- so it could only check status and call counts. Resetting
      // the module-level cache between runs lets one input be served cold twice, which is
      // what makes the cold path comparable at all.
      // The suffix only makes the cold question distinct from the warm one. It must be ordinary
      // wording: request accounting (stage 1) refuses an SHR question containing a word it cannot
      // interpret, and the old token "cold-case" was exactly that.
      const coldQuestion = `${route.question} please`;

      __resetResponseCacheForTests();
      const off = await underMode(undefined, coldQuestion);
      __resetResponseCacheForTests();
      const shadow = await underMode("shadow", coldQuestion);

      await check(`${route.label}: off makes exactly the expected model calls`, () => {
        assert.strictEqual(off.status, 200, `unexpected status; body: ${off.body.slice(0, 400)}`);
        assert.deepStrictEqual(off.calls, route.coldCalls);
      });

      await check(`${route.label}: the cold response is byte-identical in off and shadow`, () => {
        assert.strictEqual(shadow.status, off.status);
        assert.strictEqual(shadow.contentType, off.contentType);
        assert.strictEqual(shadow.body, off.body, "the cold response must be byte-for-byte identical");
        assert.deepStrictEqual(shadow.calls, off.calls, "the model-call sequence must match");
        assert.deepStrictEqual(shadow.calls, route.coldCalls);
      });
    }

    console.log(`\n${route.label} -- warm cache`);
    {
      const question = `${route.question} warm-case`;
      __resetResponseCacheForTests();
      const cold = await underMode(undefined, question);
      // Reported as a check rather than thrown: a bare assert here aborted the whole
      // loop on the first bad fixture and hid the remaining routes entirely.
      const warmable = cold.status === 200;
      await check(`${route.label}: the warm-cache fixture reaches a factual exit`, () => {
        assert.strictEqual(cold.status, 200, `warming failed: ${cold.body.slice(0, 400)}`);
      });
      if (!warmable) continue;

      await check(`${route.label}: a second off request skips translation`, async () => {
        const warm = await underMode(undefined, question);
        assert.strictEqual(warm.status, 200);
        assert.ok(!warm.calls.includes("translate"), `off re-translated: ${warm.calls.join(",")}`);
      });

      await check(`${route.label}: enabling shadow also skips translation on that cache`, async () => {
        const warm = await underMode("shadow", question);
        assert.strictEqual(warm.status, 200);
        assert.ok(
          !warm.calls.includes("translate"),
          `shadow re-translated a cache warmed under off (${warm.calls.join(",")}), so enabling shadow can change SQL, rows, narrative and charts`,
        );
      });

      await check(`${route.label}: the warm response is byte-identical in off and shadow`, async () => {
        const off = await underMode(undefined, question);
        const shadow = await underMode("shadow", question);
        assert.strictEqual(shadow.status, off.status);
        assert.strictEqual(shadow.contentType, off.contentType);
        assert.strictEqual(shadow.body, off.body, "the response must be byte-for-byte identical");
        assert.deepStrictEqual(shadow.calls, off.calls, "the model-call sequence must match");
      });

      await check(`${route.label}: warming under shadow is readable from off`, async () => {
        // The other direction of interoperability: an entry written while observing must
        // still serve once observation stops, or turning shadow OFF would change behavior.
        const shadowFirst = `${route.question} shadow-warmed`;
        const warmed = await underMode("shadow", shadowFirst);
        assert.strictEqual(warmed.status, 200, `body: ${warmed.body.slice(0, 400)}`);
        const readInOff = await underMode(undefined, shadowFirst);
        assert.strictEqual(readInOff.status, 200);
        assert.ok(
          !readInOff.calls.includes("translate"),
          `off re-translated an entry warmed in shadow: ${readInOff.calls.join(",")}`,
        );
      });
    }
  }

  stub.restore();
  console.log(`\nshadow route equivalence tests: ${passed} passed`);
  if (process.exitCode) console.log("shadow route equivalence tests: FAILED");
  else console.log("shadow route equivalence tests: passed");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
