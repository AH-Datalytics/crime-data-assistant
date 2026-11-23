/**
 * data/reference/agency_succession.csv must equal what lib/agency-consolidations.ts produces: until the engine reads the CSV,
 * the TypeScript list is the source and the file is its export. Regenerate with `tsx scripts/export-agency-succession.ts`.
 */
import { readFileSync } from "node:fs";
import { successionCsv } from "./export-agency-succession";

const file = readFileSync("data/reference/agency_succession.csv", "utf8");
if (file !== successionCsv()) {
  console.error("data/reference/agency_succession.csv differs from lib/agency-consolidations.ts; run: tsx scripts/export-agency-succession.ts");
  process.exit(1);
}
console.log("agency_succession.csv equals the export of lib/agency-consolidations.ts");
