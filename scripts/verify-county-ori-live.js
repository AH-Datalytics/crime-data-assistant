/** Live check of the ORI-reply path alone, spaced out so the rate limiter is not the result. */
const http = require("http");

const SCOPE_QUESTION =
  "For Baltimore County, do you want the countywide total (all law enforcement agencies mapped to "
  + "Baltimore County, summed — totals depend on each agency's reporting participation) or the "
  + "sheriff's office only (the single county agency record)? Choose: Countywide total or Sheriff's office only.";
const DECLINE =
  "Baltimore County, MD has two county law enforcement agencies in the FBI Historical file and they are "
  + "recorded under the same name, so I cannot tell which one you mean: Baltimore County (ORI MD0030000) "
  + "and Baltimore County (ORI MD0030100). You can ask for one by its ORI code.";

function getPageToken() {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: 3000, path: "/api/page-token", method: "GET", timeout: 20000 }, (res) => {
      let body = "";
      res.on("data", (c) => { body += c; });
      res.on("end", () => { const m = body.match(/"token":"([^"]+)"/); resolve(m ? m[1] : null); });
    });
    req.on("error", () => resolve(null));
    req.end();
  });
}

function ask(question, history, token) {
  const payload = JSON.stringify({ question, mode: "historical", history, pageToken: token });
  return new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port: 3000, path: "/api/query", method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 180000 },
      (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => resolve({ status: res.statusCode, body }));
      });
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

(async () => {
  const waitSeconds = Number(process.argv[2] || 70);
  console.log(`waiting ${waitSeconds}s for the rate limiter to clear...`);
  await new Promise((r) => setTimeout(r, waitSeconds * 1000));

  const token = await getPageToken();
  await new Promise((r) => setTimeout(r, 2500));

  const r = await ask("MD0030100", [
    { role: "user", content: "violent crime in Baltimore County, MD" },
    { role: "assistant", content: SCOPE_QUESTION },
    { role: "user", content: "sheriff's office only" },
    { role: "assistant", content: DECLINE },
  ], token);

  const sql = field(r.body, "sql");
  const explanation = field(r.body, "explanation");
  console.log(`status: ${r.status}`);
  console.log(`sql: ${sql.slice(0, 400)}`);
  console.log(`explanation: ${explanation.slice(0, 400)}`);

  const pinned = sql.includes("MD0030100");
  const otherAgency = sql.includes("MD0030000");
  const refusedForOri = /resolved to one specific county law enforcement agency/i.test(explanation);
  const repeatedDecline = /cannot tell which one you mean/i.test(explanation);

  console.log("");
  console.log(`  ${!repeatedDecline ? "PASS" : "FAIL"}  the ORI reply is not answered with the same decline`);
  console.log(`  ${pinned || refusedForOri ? "PASS" : "FAIL"}  SQL pinned to MD0030100, or the contract refused an unpinned query`);
  console.log(`  ${!otherAgency ? "PASS" : "FAIL"}  the other agency is not admitted`);
  if (!r.body.trim()) console.log(`  RAW: ${r.body.slice(0, 600)}`);
  const ok = !repeatedDecline && (pinned || refusedForOri) && !otherAgency;
  console.log(ok ? "\nORI PATH VERIFIED LIVE" : "\nORI PATH CHECK FAILED");
  process.exit(ok ? 0 : 1);
})();
