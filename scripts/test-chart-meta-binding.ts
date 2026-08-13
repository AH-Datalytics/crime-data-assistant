/**
 * Every chart-producing exit must LOG the chart metadata it RETURNS.
 *
 * The embed's origin check binds a chart by comparing the client's serialized
 * configuration against the one the answer logged, and that serialization now carries
 * a digest of the chart metadata -- source, agency count, population -- because those
 * render as factual claims beneath the chart and previously arrived from the client
 * unchecked.
 *
 * That binding only works if both sides serialize the same inputs. An exit that
 * returns chartMeta in its payload but logs without it produces a logged blob with no
 * chartMetaDigest and an exported blob with one, so a perfectly legitimate origin
 * becomes `unbound`.
 *
 * WHY THIS SUITE EXISTS RATHER THAN A SIMPLER ONE. My own verification for the
 * previous round asserted "every route contains at least one three-argument call" and
 * passed while EIGHT deterministic exits still logged with two -- the Current Trends
 * indexed-state, multi-city, historical-change and metadata paths, NIBRS metadata, SHR
 * metadata plus both deterministic planners, and Hate Crime metadata. Existence of the
 * pattern somewhere in a file says nothing about the site that matters. This pairs
 * each call with the payload it belongs to and compares the actual expressions.
 */
import assert from "node:assert";
import fs from "node:fs";
import { serializeChartConfigForLog } from "../lib/chart-config-log";
import { verifyEmbedOrigin } from "../lib/embed-origin";
import type { ChartConfig, ChartMeta } from "../lib/types";

let passed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
    passed++;
  } catch (error) {
    console.log(`  FAIL  ${name}\n        ${(error as Error).message}`);
    process.exitCode = 1;
  }
}

const ROUTES = [
  "app/api/query/route.ts",
  "app/api/hc-query/route.ts",
  "app/api/shr-query/route.ts",
  "app/api/nibrs-query/route.ts",
];

/** Normalize an expression for comparison: whitespace and trailing commas only. */
function normalizeExpr(expr: string): string {
  return expr.replace(/\s+/g, " ").replace(/,\s*$/, "").trim();
}

/**
 * The third argument of a serializeChartConfigForLog call, by paren matching.
 *
 * Returns null when the call has fewer than three arguments -- which is the defect
 * this suite exists to catch.
 */
function thirdArgument(source: string, callIndex: number): string | null {
  const open = source.indexOf("(", callIndex);
  if (open < 0) return null;
  let depth = 0;
  const args: string[] = [];
  let current = "";
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
      if (depth === 1) continue;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        args.push(current);
        break;
      }
    } else if (ch === "," && depth === 1) {
      args.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  return args.length >= 3 ? normalizeExpr(args.slice(2).join(",")) : null;
}

/** The `chartMeta:` expression of the payload nearest below a given offset. */
function payloadChartMeta(source: string, fromIndex: number): string | null {
  const window = source.slice(fromIndex, fromIndex + 3500);
  const match = window.match(/chartMeta:\s*([^\n]+?),?\s*\n/);
  return match ? normalizeExpr(match[1]) : null;
}

console.log("\nevery chart capture logs the metadata its own exit returns");
{
  let sitesChecked = 0;
  for (const file of ROUTES) {
    const source = fs.readFileSync(file, "utf8");
    let index = source.indexOf("serializeChartConfigForLog(");
    let siteNumber = 0;
    while (index >= 0) {
      siteNumber += 1;
      const line = source.slice(0, index).split("\n").length;
      const third = thirdArgument(source, index);
      const payload = payloadChartMeta(source, index);
      const label = `${file}:${line}`;

      check(`${label} logs chart metadata`, () => {
        assert.ok(
          third !== null,
          "this exit serializes its chart config without chart metadata, so an embed " +
            "exported from it can never bind: the logged blob has no chartMetaDigest " +
            "and the exported one does",
        );
      });

      // Where a payload chartMeta is visible nearby, the two must be the SAME
      // expression. The main model paths build their event far above the log write, so
      // no payload is found there; those pass the existence check above and are covered
      // behaviorally by the embed suites.
      if (payload && third) {
        check(`${label} logs the SAME metadata it returns`, () => {
          assert.strictEqual(
            third,
            payload,
            `logged \`${third}\` but the response returns \`${payload}\``,
          );
        });
      }

      sitesChecked += 1;
      index = source.indexOf("serializeChartConfigForLog(", index + 1);
    }
    void siteNumber;
  }

  check("all four routes were actually scanned", () => {
    // Guards against the scan silently finding nothing and reporting success -- the
    // same "zero eligible items looks clean" failure lib/audit-health exists for.
    assert.ok(sitesChecked >= 13, `expected at least 13 capture sites, scanned ${sitesChecked}`);
  });
}

console.log("\nend to end: a deterministic answer's chart can be bound");
{
  // Production shape for a deterministic exit: the answer logs with real result
  // columns AND its own chartMeta; the embed serializes with no columns and the same
  // chartMeta. The two must produce matching chart identity.
  const config: ChartConfig = {
    type: "line",
    xAxis: "year",
    yAxis: ["murders"],
    title: "Murders by city",
  };
  const meta: ChartMeta = { source: "RTCI", agencyCount: 412, population: 39_500_000 };

  check("the logged and exported serializations agree on chart identity", () => {
    const logged = serializeChartConfigForLog(config, ["year", "murders"], meta)!;
    const exported = serializeChartConfigForLog(config, [], meta)!;
    const l = JSON.parse(logged) as Record<string, unknown>;
    const e = JSON.parse(exported) as Record<string, unknown>;
    assert.strictEqual(l.chartMetaDigest, e.chartMetaDigest, "the metadata digest must match");
    assert.notStrictEqual(l.columns, e.columns, "and the column metadata is expected to differ");
  });

  check("a deterministic origin verifies through verifyEmbedOrigin", () => {
    const logged = serializeChartConfigForLog(config, ["year", "murders"], meta);
    const exported = serializeChartConfigForLog(config, [], meta);
    const stub = {
      prepare: () => ({
        get: () => ({
          tab: "current",
          sql: "SELECT 1",
          chart_config: logged,
          delivery_action: "answer",
          proof_mode: "shadow",
          proof_manifest: JSON.stringify({ blocker: null, hypotheticalAction: "answer" }),
        }),
        all: () => [{ name: "request_id" }, { name: "proof_manifest" }],
      }),
    };
    const verdict = verifyEmbedOrigin(stub, {
      requestId: "req-1",
      tab: "current",
      sql: "SELECT 1",
      chartConfigJson: exported,
    });
    assert.strictEqual(verdict.state, "verified", verdict.reason);
  });

  check("an exit that logged WITHOUT metadata cannot bind", () => {
    // The failure the eight un-threaded exits would have produced.
    const loggedWithout = serializeChartConfigForLog(config, ["year", "murders"]);
    const exported = serializeChartConfigForLog(config, [], meta);
    const stub = {
      prepare: () => ({
        get: () => ({
          tab: "current",
          sql: "SELECT 1",
          chart_config: loggedWithout,
          delivery_action: "answer",
          proof_mode: "shadow",
          proof_manifest: JSON.stringify({ blocker: null, hypotheticalAction: "answer" }),
        }),
        all: () => [{ name: "request_id" }, { name: "proof_manifest" }],
      }),
    };
    const verdict = verifyEmbedOrigin(stub, {
      requestId: "req-1",
      tab: "current",
      sql: "SELECT 1",
      chartConfigJson: exported,
    });
    assert.strictEqual(verdict.state, "unbound", "a legitimate chart would have been rejected");
  });
}

console.log(`\nchart metadata binding tests: ${passed} passed`);
if (process.exitCode) {
  console.log("chart metadata binding tests: FAILED");
} else {
  console.log("chart metadata binding tests: passed");
}
