/**
 * Production replay harness for nibrsai.com/test.
 *
 * Operational tooling only — no product code. Drives the real /test flow,
 * confirms a NEW query_log row was actually created before evaluating
 * anything, then asserts on the stored narrative and guardrail tags.
 *
 * Why this exists: an earlier ad-hoc script silently failed to submit
 * (nothing reached query_log) because it assumed a `Continue` button and a
 * `<select>` source picker. Neither exists. The real UI is:
 *   - question field:  input[type="text"]   (there is no <textarea>)
 *   - submit:          the toolbar button labelled exactly "Ask"
 *   - source chooser:  each candidate source is a whole <button> whose text
 *                      STARTS WITH the source name, e.g.
 *                      "Historical LibraryAnnual FBI data from 1..."
 *                      "Current TrendsBest matchRecent monthly d..."
 *                      "Homicide ReportsHomicide victim-offender..."
 *     A single-candidate question renders "Recommended source:" instead.
 *   The toolbar "Ask" button must be excluded when clicking a chooser card,
 *   which is exactly what the earlier script got wrong.
 *
 * Usage (must run through the playwright-skill executor so `playwright`
 * resolves):
 *   node <skill>/run.js scripts/replay-production-queries.js            # all
 *   node <skill>/run.js scripts/replay-production-queries.js 7772 7780  # subset
 *   node <skill>/run.js scripts/replay-production-queries.js --selftest  # 1 control
 *
 * Exit code 0 only if every selected replay produced a new log row AND
 * passed its assertions.
 */

const path = require("path");
const { execFileSync } = require("child_process");

const PW_SKILL_DIR =
  process.env.PW_SKILL_DIR ||
  "C:/Users/jeffm/.claude/plugins/cache/playwright-skill/playwright-skill/4.1.0/skills/playwright-skill";

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require(path.join(PW_SKILL_DIR, "node_modules", "playwright")));
}

const TARGET_URL = process.env.REPLAY_URL || "https://nibrsai.com/test";
const VPS = process.env.REPLAY_VPS || "root@178.156.243.51";
const LOG_DB = process.env.REPLAY_LOG_DB || "/opt/nibrs/shared/query_log.db";

/** Source card name -> query_log.tab value. Keeps replays pinned to one source. */
const SOURCE_TO_TAB = {
  "Current Trends": "current",
  "Historical Library": "historical",
  NIBRS: "nibrs",
  "Homicide Reports": "shr",
  "Hate Crime": "hate_crime",
};

// ---------------------------------------------------------------- replay cases
const REPLAYS = [
  {
    id: "7772",
    question: "carjackings in baltimore city",
    source: "NIBRS",
    assert: (row) => [
      [/baltimore/i.test(row.response), "narrative must name Baltimore"],
      [!/dataset City/i.test(row.response), 'narrative must not contain "dataset City"'],
      [!/cities in the dataset/i.test(row.response), "no generic place substitution"],
      [row.rows > 0, "must return rows"],
    ],
  },
  {
    id: "7773",
    question: "carjackings in baltimore city by month",
    source: "NIBRS",
    assert: (row) => [
      [/baltimore/i.test(row.response), "narrative must name Baltimore"],
      [!/dataset City/i.test(row.response), 'narrative must not contain "dataset City"'],
      [row.rows > 0, "must return rows"],
    ],
  },
  {
    id: "7780",
    question: "murder victim race in Houston since 2010",
    source: "Homicide Reports",
    assert: (row) => [
      [!/Asianpacific/i.test(row.response), '"Asianpacific" must not appear'],
      [
        !/Comparison includes/i.test(row.response) || /Asian\/Pacific Islander/.test(row.response),
        "if a comparison list is present it must use Asian/Pacific Islander",
      ],
      [row.rows > 0, "must return rows"],
    ],
  },
  {
    id: "7783",
    question: "police staffing in Chicago since 1980",
    source: "Historical Library",
    assert: (row) => {
      const tags = (row.guardrails || "").split(",").map((t) => t.trim()).filter(Boolean);
      return [
        [
          !tags.includes("contract-year-lower-bound-missing"),
          "unsuffixed lower-bound tag must be absent (final SQL enforces 1980)",
        ],
        [row.rows >= 40, "must return the full 1980-present series"],
        [/chicago/i.test(row.response), "narrative must name Chicago"],
      ];
    },
  },
  {
    id: "control-historical",
    question: "total violent crime in Chicago since 2010",
    source: "Historical Library",
    assert: (row) => [
      [/chicago/i.test(row.response), "narrative must name Chicago"],
      [!/dataset City|cities in the dataset/i.test(row.response), "no place garbling"],
      [row.rows > 0, "must return rows"],
    ],
  },
  {
    id: "control-typo",
    question: "murders in new orlens 2020",
    source: "Historical Library",
    assert: (row) => [
      [/new orleans/i.test(row.response), "typo must resolve to New Orleans"],
      [row.rows > 0, "must return rows"],
    ],
  },

  // --- Cache-behavior diagnostics -------------------------------------------
  // Log 7802 resolved "new orlens" correctly but recorded NO geo-typo-corrected
  // tag, most likely because the response was served from cache and the tag is
  // pushed only on the non-cached branch. These two cases run back to back with
  // an IDENTICAL question: the first should miss the cache, the second should
  // hit it. Marked diagnostic so cache behavior is reported without failing the
  // Fix 2 / Fix 3 verification run.
  {
    id: "diag-typo-uncached",
    question: "murders in new orlens 2019",
    source: "Historical Library",
    diagnostic: true,
    assert: (row) => {
      const tags = (row.guardrails || "").split(",").map((t) => t.trim()).filter(Boolean);
      return [
        [/new orleans/i.test(row.response), "typo must resolve to New Orleans"],
        [tags.includes("geo-typo-corrected"), "first (uncached) run should record geo-typo-corrected"],
      ];
    },
  },
  {
    id: "diag-typo-cached",
    // Deliberately identical to diag-typo-uncached so this run hits the cache.
    question: "murders in new orlens 2019",
    source: "Historical Library",
    diagnostic: true,
    assert: (row) => {
      const tags = (row.guardrails || "").split(",").map((t) => t.trim()).filter(Boolean);
      return [
        [/new orleans/i.test(row.response), "typo must still resolve to New Orleans"],
        [
          !tags.includes("geo-typo-corrected"),
          "second (cached) run is expected to omit geo-typo-corrected — confirms the cache-branch gap",
        ],
      ];
    },
  },
];

// ---------------------------------------------------------------- query_log access
/**
 * Run a query against query_log and return parsed rows.
 * Uses sqlite3 -json (available: 3.45.1) so narratives containing newlines,
 * quotes, commas, or pipes survive transport intact.
 */
function sqlite(query) {
  const out = execFileSync("ssh", [VPS, `sqlite3 -json ${LOG_DB} "${query.replace(/"/g, '\\"')}"`], {
    encoding: "utf8",
    timeout: 60000,
  }).trim();
  if (!out) return [];
  try {
    return JSON.parse(out);
  } catch (err) {
    throw new Error(`Could not parse sqlite3 JSON output: ${err.message}\nRaw: ${out.slice(0, 200)}`);
  }
}

function maxLogId() {
  const rows = sqlite("SELECT COALESCE(MAX(id),0) AS maxId FROM query_log;");
  return rows.length ? Number(rows[0].maxId) : 0;
}

/** Poll until a row with id > sinceId appears (optionally on a specific tab). */
async function waitForNewRow(sinceId, expectedTab, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tabClause = expectedTab ? ` AND tab='${expectedTab}'` : "";
    const rows = sqlite(
      `SELECT id, tab, rows AS rowCount, COALESCE(guardrails,'') AS guardrails, ` +
        `COALESCE(response,'') AS response FROM query_log ` +
        `WHERE id > ${sinceId}${tabClause} ORDER BY id ASC LIMIT 1;`
    );
    if (rows.length) {
      const r = rows[0];
      return {
        id: Number(r.id),
        tab: r.tab,
        rows: Number(r.rowCount),
        guardrails: r.guardrails || "",
        response: r.response || "",
      };
    }
    await new Promise((res) => setTimeout(res, 3000));
  }
  return null;
}

// ---------------------------------------------------------------- UI driving
async function submitQuestion(page, question, sourceName) {
  const box = page.locator('input[type="text"], textarea').first();
  await box.click();
  await box.fill("");
  await box.fill(question);

  // The toolbar submit button is labelled exactly "Ask".
  await page.locator("button").filter({ hasText: /^Ask$/ }).first().click();

  // The chooser may take a moment; it is optional (some questions route directly).
  for (let attempt = 0; attempt < 12; attempt++) {
    await page.waitForTimeout(1000);

    // Chooser cards are whole buttons whose text STARTS WITH the source name.
    // Exclude the toolbar "Ask" button explicitly.
    const card = page
      .locator("button")
      .filter({ hasText: new RegExp("^" + sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")) })
      .filter({ hasNotText: /^Ask$/ })
      .first();

    if (await card.count().catch(() => 0)) {
      const label = (await card.textContent().catch(() => "")) || "";
      console.log(`      chooser -> clicking "${label.trim().slice(0, 42)}"`);
      await card.click();
      return true;
    }

    // Single-candidate variant.
    const cont = page.locator("button, a").filter({ hasText: /Continue/i }).first();
    if (await cont.count().catch(() => 0)) {
      console.log("      chooser -> clicking Continue");
      await cont.click();
      return true;
    }
  }
  console.log("      (no chooser appeared; question routed directly)");
  return false;
}

// ---------------------------------------------------------------- main
(async () => {
  // NOTE: when launched via the playwright-skill executor (`node run.js <this
  // file>`), process.argv still belongs to run.js, so argv[2] is this script's
  // own path. Match only against known ids so a stray path is never mistaken
  // for an id filter (which silently selected zero cases).
  const knownIds = new Set(REPLAYS.map((r) => r.id));
  const args = process.argv.slice(2).filter((a) => knownIds.has(a));
  const selftest = process.argv.includes("--selftest");
  const cases = selftest
    ? REPLAYS.filter((r) => r.id === "control-historical")
    : args.length
      ? REPLAYS.filter((r) => args.includes(r.id))
      : REPLAYS;

  if (cases.length === 0) {
    console.error("No matching replay cases. Known ids: " + REPLAYS.map((r) => r.id).join(", "));
    process.exit(2);
  }

  console.log(`Replaying ${cases.length} case(s) against ${TARGET_URL}\n`);
  const browser = await chromium.launch({ headless: true });
  const results = [];

  for (const testCase of cases) {
    const expectedTab = SOURCE_TO_TAB[testCase.source];
    console.log(`[${testCase.id}] "${testCase.question}"  (source: ${testCase.source} -> tab ${expectedTab})`);

    const before = maxLogId();
    console.log(`      query_log max id before: ${before}`);

    const page = await browser.newPage();
    page.setDefaultTimeout(90000);
    let row = null;
    try {
      await page.goto(TARGET_URL, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(3500);
      await submitQuestion(page, testCase.question, testCase.source);
      row = await waitForNewRow(before, expectedTab);
    } catch (err) {
      console.log(`      ERROR driving UI: ${err.message}`);
    }
    await page.close();

    if (!row) {
      console.log(`      FAIL: no new query_log row on tab '${expectedTab}' — the query never reached the server\n`);
      results.push({ id: testCase.id, ok: false, reason: "no new log row" });
      continue;
    }

    console.log(`      new row id=${row.id} tab=${row.tab} rows=${row.rows} guardrails=[${row.guardrails}]`);
    console.log(`      narrative: ${row.response.slice(0, 150)}`);

    const checks = testCase.assert(row);
    const failed = checks.filter(([ok]) => !ok).map(([, label]) => label);
    if (failed.length) {
      // Diagnostic cases report their outcome but never fail the run — they
      // characterize behavior (e.g. cache-branch tagging) rather than assert a
      // contract we have already decided to enforce.
      const level = testCase.diagnostic ? "INFO" : "FAIL";
      failed.forEach((f) => console.log(`      ${level}: ${f}`));
      results.push({
        id: testCase.id,
        ok: Boolean(testCase.diagnostic),
        diagnostic: Boolean(testCase.diagnostic),
        reason: failed.join("; "),
        logId: row.id,
      });
    } else {
      console.log(`      PASS (${checks.length} checks)`);
      results.push({ id: testCase.id, ok: true, diagnostic: Boolean(testCase.diagnostic), logId: row.id });
    }
    console.log("");
  }

  await browser.close();

  console.log("=== SUMMARY ===");
  for (const r of results) {
    const label = r.diagnostic ? (r.reason ? "INFO" : "PASS") : r.ok ? "PASS" : "FAIL";
    const note = r.reason ? " — " + r.reason : "";
    console.log(`${label}  ${r.id}${r.logId ? ` (log ${r.logId})` : ""}${note}`);
  }
  const gating = results.filter((r) => !r.diagnostic);
  const failures = gating.filter((r) => !r.ok).length;
  console.log(`${gating.length - failures}/${gating.length} gating checks passed` +
    (results.length > gating.length ? ` (${results.length - gating.length} diagnostic, non-gating)` : ""));
  process.exit(failures === 0 ? 0 : 1);
})();
