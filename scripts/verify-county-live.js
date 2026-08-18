/**
 * Live post-deploy verification of the four county paths, run on the VPS against the
 * running app and the production database. Read-only: it asks questions, it changes nothing.
 */
const http = require("http");

const BASE = { host: "127.0.0.1", port: 3000, path: "/api/query", method: "POST" };

const SCOPE_QUESTION =
  "For Baltimore County, do you want the countywide total (all law enforcement agencies mapped to "
  + "Baltimore County, summed — totals depend on each agency's reporting participation) or the "
  + "sheriff's office only (the single county agency record)? Choose: Countywide total or Sheriff's office only.";

let PAGE_TOKEN = null;

function getPageToken() {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: 3000, path: "/api/page-token", method: "GET", timeout: 20000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        const m = body.match(/"token":"([^"]+)"/);
        resolve(m ? m[1] : null);
      });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function ask(question, history) {
  const payload = JSON.stringify({ question, mode: "historical", history: history || [], pageToken: PAGE_TOKEN });
  return new Promise((resolve) => {
    const req = http.request(
      { ...BASE, headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 120000 },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      },
    );
    req.on("error", (e) => resolve({ status: 0, body: String(e) }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, body: "timeout" }); });
    req.write(payload);
    req.end();
  });
}

function field(body, name) {
  const out = [];
  const re = new RegExp(`"${name}":"((?:[^"\\\\]|\\\\.)*)"`, "g");
  let m;
  while ((m = re.exec(body))) out.push(m[1].replace(/\\"/g, '"').replace(/\\n/g, " "));
  return out.join(" | ");
}

let failures = 0;
function check(label, condition, detail) {
  const mark = condition ? "PASS" : "FAIL";
  if (!condition) failures += 1;
  console.log(`  ${mark}  ${label}`);
  if (!condition && detail) console.log(`        ${String(detail).slice(0, 400)}`);
}

(async () => {
  // The page token must be at least a second old before the API will accept it.
  PAGE_TOKEN = await getPageToken();
  if (!PAGE_TOKEN) { console.log("could not obtain a page token"); process.exit(1); }
  await new Promise((r) => setTimeout(r, 2500));

  console.log("1. county resolution + scorecard: Duval County, FL");
  let r = await ask("Duval County, FL scorecard");
  let sql = field(r.body, "sql");
  let title = field(r.body, "title");
  check("HTTP 200", r.status === 200, r.status);
  check("resolves to the Jacksonville Sheriff's Office ORI FL0160000", sql.includes("FL0160000"), sql.slice(0, 300));
  check("does not report the agency absent", !/could not find/i.test(r.body), title);
  check("does not reach the Jacksonville city agency", !sql.includes("FL0160200"), sql.slice(0, 300));
  console.log(`        title: ${title.slice(0, 120)}`);

  console.log("\n2. scorecard still builds for a one-agency county: Cook County, IL");
  r = await ask("Cook County, IL scorecard");
  sql = field(r.body, "sql");
  check("pinned to IL0160000", sql.includes("IL0160000"), sql.slice(0, 300));
  console.log(`        title: ${field(r.body, "title").slice(0, 120)}`);

  console.log("\n3. clarification instead of silently picking: Baltimore County, MD");
  r = await ask("Baltimore County, MD scorecard");
  let explanation = field(r.body, "explanation");
  check("asks which agency", /which one do you want/i.test(explanation), explanation.slice(0, 300));
  check("names both ORIs", new Set(explanation.match(/MD\d{7}/g) || []).size >= 2, explanation.slice(0, 300));
  check("runs no SQL", !field(r.body, "sql"), field(r.body, "sql").slice(0, 200));
  console.log(`        says: ${explanation.slice(0, 220)}`);

  console.log("\n4. the two-turn route flow, with the real scope message in history");
  r = await ask("county agency only", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
    { role: "assistant", content: SCOPE_QUESTION },
  ]);
  explanation = field(r.body, "explanation");
  check("asks which county agency", /is served by more than one law enforcement agency/i.test(explanation), explanation.slice(0, 300));
  check("runs no SQL", !field(r.body, "sql"), field(r.body, "sql").slice(0, 200));
  console.log(`        says: ${explanation.slice(0, 220)}`);

  console.log("\n5. countywide is not intercepted");
  r = await ask("countywide total", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
    { role: "assistant", content: SCOPE_QUESTION },
  ]);
  explanation = field(r.body, "explanation");
  check("not asked which single agency", !/is served by more than one law enforcement agency/i.test(explanation), explanation.slice(0, 200));

  console.log("\n6. ORI reply resolves, and the executed SQL is pinned to it");
  r = await ask("MD0030100", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
    { role: "assistant", content: SCOPE_QUESTION },
    { role: "user", content: "sheriff's office only" },
    { role: "assistant", content: "Baltimore County, MD has two county law enforcement agencies in the FBI Historical file and they are recorded under the same name, so I cannot tell which one you mean: Baltimore County (ORI MD0030000) and Baltimore County (ORI MD0030100). You can ask for one by its ORI code." },
  ]);
  sql = field(r.body, "sql");
  explanation = field(r.body, "explanation");
  const declinedForOri = /resolved to one specific county law enforcement agency/i.test(explanation);
  check("the ORI reply is not answered with the same decline",
    !/cannot tell which one you mean/i.test(explanation), explanation.slice(0, 300));
  check("either the SQL is pinned to MD0030100, or the contract refused an unpinned query",
    sql.includes("MD0030100") || declinedForOri, `sql=${sql.slice(0, 240)} :: ${explanation.slice(0, 200)}`);
  check("no other agency admitted", !sql.includes("MD0030000"), sql.slice(0, 300));
  console.log(`        sql: ${sql.slice(0, 200)}`);
  console.log(`        says: ${explanation.slice(0, 200)}`);
  if (!sql && !explanation) console.log(`        RAW(${r.status}): ${r.body.slice(0, 700)}`);

  console.log(`\n${failures === 0 ? "ALL LIVE CHECKS PASSED" : failures + " LIVE CHECK(S) FAILED"}`);
  process.exit(failures === 0 ? 0 : 1);
})();
