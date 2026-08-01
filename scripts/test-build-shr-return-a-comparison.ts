import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shr-coverage-build-"));
  const sourcePath = path.join(dir, "source.db");
  const outputPath = path.join(dir, "artifact.db");
  const crimePath = path.join(dir, "crime.db");
  try {
    const shr = new Database(sourcePath);
    shr.exec(`
      CREATE TABLE shr_agency_identity (
        ori TEXT, state TEXT, canonical_agency TEXT, first_year INTEGER, last_year INTEGER
      );
      CREATE TABLE incidents (
        id INTEGER PRIMARY KEY, ori TEXT, state TEXT, year INTEGER, month INTEGER, homicide_type TEXT
      );
      CREATE TABLE victims (id INTEGER PRIMARY KEY, incident_id INTEGER);
    `);
    const identity = shr.prepare("INSERT INTO shr_agency_identity VALUES (?, 'TX', ?, 1976, 2024)");
    identity.run("TX00101", "Alpha");
    identity.run("TX00102", "Beta");
    identity.run("TX00103", "Gamma");
    identity.run("TX00104", "Delta");
    identity.run("TX00105", "Epsilon");
    const incident = shr.prepare("INSERT INTO incidents (ori, state, year, month, homicide_type) VALUES (?, 'TX', ?, ?, 'Murder')");
    const victim = shr.prepare("INSERT INTO victims (incident_id) VALUES (?)");
    const gammaId = Number(incident.run("TX00103", 2022, 3).lastInsertRowid);
    victim.run(gammaId); victim.run(gammaId);
    const deltaId = Number(incident.run("TX00104", 2022, 5).lastInsertRowid);
    victim.run(deltaId); victim.run(deltaId);
    shr.close();

    const crime = new Database(crimePath);
    crime.exec(`
      CREATE TABLE historical_agency (ori TEXT, agency TEXT, state TEXT);
      CREATE TABLE historical_agency_crime (ori TEXT, year INTEGER, murder INTEGER);
    `);
    const agency = crime.prepare("INSERT INTO historical_agency VALUES (?, ?, 'TX')");
    const annual = crime.prepare("INSERT INTO historical_agency_crime VALUES (?, ?, ?)");
    for (const [ori, name, year, murders] of [
      ["TX00101", "Alpha", 2020, 0],
      ["TX00102", "Beta", 2020, 5],
      ["TX00104", "Delta", 2022, 10],
      ["TX00105", "Epsilon", 2020, -1],
    ] as const) {
      agency.run(ori, name);
      annual.run(ori, year, murders);
    }
    crime.close();

    process.env.SHR_DB_PATH = sourcePath;
    process.env.CRIME_DATA_DB_PATH = crimePath;
    process.argv.push("--apply", "--output", outputPath);
    await import("./build-shr-return-a-comparison");

    assert(fs.existsSync(outputPath));
    const artifact = new Database(outputPath, { readonly: true });
    const byOri = new Map((artifact.prepare("SELECT * FROM shr_return_a_comparison").all() as Array<Record<string, unknown>>)
      .map((row) => [String(row.shr_ori), row]));
    assert.equal(byOri.get("TX00101")?.display_value, 0);
    assert.equal(byOri.get("TX00101")?.display_status, "validated_zero");
    assert.equal(byOri.get("TX00102")?.display_value, null);
    assert.equal(byOri.get("TX00102")?.display_status, "gap");
    assert.equal(byOri.get("TX00103")?.display_value, 2);
    assert.equal(byOri.get("TX00103")?.caveat_code, "identity_uncertainty");
    assert.equal(byOri.get("TX00104")?.display_value, 2);
    assert.equal(byOri.get("TX00104")?.comparison_conflict, 1);
    assert.equal(byOri.get("TX00105")?.display_status, "coverage_unknown");
    const invariant = artifact.prepare(
      "SELECT COUNT(*) AS n FROM shr_return_a_comparison WHERE shr_victims > 0 AND display_value IS NULL",
    ).get() as { n: number };
    assert.equal(invariant.n, 0);
    artifact.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log("SHR comparison artifact builder tests passed");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
