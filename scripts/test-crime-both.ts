/**
 * P182 for two or more places (lib/nibrs-shadow/crime-both.ts), offline: the violent crime and property crime answers lined up as one table,
 * as a total by place or a period series (several places, long), a rate headed per 100,000, blanks kept; never two sources or two shapes.
 */
import assert from "node:assert/strict";
import { composeBoth } from "../lib/nibrs-shadow/crime-both";
import type { PartAnswer } from "../lib/nibrs-shadow/crime-over-time";

const YEAR = { binding: { kind: "grouping", dimension: "time.year" }, header: "Year", ordered: true } as const;
const AGENCY = { binding: { kind: "grouping", dimension: "geo.agency" }, header: "Agency" } as const;
const stat = (header: string, as: string) => ({ binding: { kind: "statistic", as }, header }) as const;
const ans = (title: string, cols: unknown[], rows: unknown[][], extra: string[] = [], source = "Source: Crime Index."): PartAnswer =>
  ({ kind: "historical", question: {}, meaning: { measures: [{}] }, delivered: { table: { columns: cols, rows }, text: [title, ...extra, source] } }) as never;

// A total by place.
{
  const v = ans("A and B Violent Crimes by Agency, 2024", [AGENCY, stat("Violent crimes", "x")], [["A", 10], ["B", 20]], ["Figures for the A and B police."]);
  const p = ans("A and B Property Crimes by Agency, 2024", [AGENCY, stat("Property crimes", "x")], [["A", 100], ["B", null]], ["Figures for the A and B police.", "Crime Index has no property crime figure for B in 2024, shown blank."]);
  const r = composeBoth(v, p)!;
  assert.deepEqual(r.delivered.table.columns.map((c) => c.header), ["Agency", "Violent crime", "Property crime"]);
  assert.deepEqual(r.delivered.table.rows, [["A", 10, 100], ["B", 20, null]]);
  assert.deepEqual(r.delivered.text, ["A and B Violent and Property Crime by Agency, 2024", "Figures for the A and B police.", "Crime Index has no property crime figure for B in 2024, shown blank.", "Source: Crime Index."]);
  // A rate is headed per 100,000.
  const rv = ans("A and B Violent Crime Rate by Agency, 2024", [AGENCY, stat("Violent crime per 100,000", "x")], [["A", 1.5]]);
  const rp = ans("A and B Property Crime Rate by Agency, 2024", [AGENCY, stat("Property crime per 100,000", "x")], [["A", 7.5]]);
  const rr = composeBoth(rv, rp)!;
  assert.deepEqual(rr.delivered.table.columns.map((c) => c.header), ["Agency", "Violent crime per 100,000", "Property crime per 100,000"]);
  assert.equal(rr.delivered.text[0], "A and B Violent and Property Crime Rate by Agency, 2024");
  // Different places in the two answers, a different source, every cell blank: null.
  assert.equal(composeBoth(v, ans("t", [AGENCY, stat("p", "x")], [["A", 1], ["C", 2]])), null);
  assert.equal(composeBoth(v, ans("A and B Property Crimes by Agency, 2024", [AGENCY, stat("p", "x")], [["A", 1], ["B", 2]], [], "Source: NIBRS.")), null);
  assert.equal(composeBoth(ans("A and B Violent Crimes by Agency, 2024", [AGENCY, stat("v", "x")], [["A", null]]), ans("t", [AGENCY, stat("p", "x")], [["A", null]])), null);
}
// A series of several places side by side becomes long: Place, Year, violent, property.
{
  const cols = (w: string) => [YEAR, stat(`A: ${w}`, "x.0"), stat(`B: ${w}`, "x.1")];
  const withAgencies = (a: PartAnswer) => ({ ...a, question: { agencies: [{ name: "A" }, { name: "B" }] } }) as PartAnswer;
  const v = withAgencies(ans("A and B Violent Crimes Per Year, 2023-2024", cols("violent crimes"), [["2023", 1, 2], ["2024", 3, 4]]));
  const p = withAgencies(ans("A and B Property Crimes Per Year, 2023-2024", cols("property crimes"), [["2023", 10, 20], ["2024", 30, null]]));
  const r = composeBoth(v, p)!;
  assert.deepEqual(r.delivered.table.columns.map((c) => c.header), ["Place", "Year", "Violent crime", "Property crime"]);
  assert.deepEqual(r.delivered.table.rows, [["A", "2023", 1, 10], ["A", "2024", 3, 30], ["B", "2023", 2, 20], ["B", "2024", 4, null]]);
  assert.equal(r.delivered.text[0], "A and B Violent and Property Crime Per Year, 2023-2024");
  // One place is not this composer's (the crime-over-time composite has it).
  assert.equal(composeBoth(ans("A Violent Crimes Per Year", [YEAR, stat("v", "x")], [["2023", 1]]), ans("A Property Crimes Per Year", [YEAR, stat("p", "x")], [["2023", 1]])), null);
}
console.log("test-crime-both: ok");
