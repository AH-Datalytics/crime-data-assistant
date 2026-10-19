/*
 * Request accounting correction r1: a requested period is applied only when the statement constrains
 * exactly that period at the requested grain (Codex findings 2, 3, 6). Pure: parsing only.
 */
import { accountShrRequest } from "../lib/shr-request-accounting";
import { periodsApplied } from "../lib/shr-period-proof";

let checks = 0;
let failures = 0;
function check(ok: boolean, label: string): void {
  checks += 1;
  if (!ok) { failures += 1; console.log(`  FAIL  ${label}`); } else console.log(`  PASS  ${label}`);
}
const applied = (q: string, sql: string) => periodsApplied(accountShrRequest(q).parts, sql);
const yes = (q: string, sql: string, label: string) => check(applied(q, sql), `applied: ${label}`);
const no = (q: string, sql: string, label: string) => check(!applied(q, sql), `NOT applied: ${label}`);

yes("murders in Texas in 2025", "SELECT COUNT(*) FROM incidents WHERE year = 2025", "single year");
no("murders in Texas since 2025", "SELECT COUNT(*) FROM incidents WHERE year = 2025", "since 2025 is not = 2025 (Codex)");
yes("murders in Texas since 2015", "SELECT COUNT(*) FROM incidents WHERE i.year >= 2015", "since as >=");
no("murders in Chicago since 2015", "SELECT COUNT(*) FROM incidents i WHERE i.year = 2015 AND i.month BETWEEN 1 AND 12", "since 2015 read as 2015 only");
yes("murders in Texas from 2019 to 2022", "SELECT year, COUNT(*) FROM incidents WHERE year BETWEEN 2019 AND 2022 GROUP BY year", "range");
no("fatal shootings in Chicago in 2025 and 2024", "SELECT COUNT(*) FROM incidents i WHERE i.year = 2025", "two years read as one (Codex)");
yes("fatal shootings in Chicago in 2025 and 2024", "SELECT year, COUNT(*) FROM incidents i WHERE i.year IN (2024, 2025) GROUP BY year", "two years as IN");
no("female murder victims in Texas in January 2025", "SELECT COUNT(*) FROM incidents i WHERE i.year = 2025 AND i.month = 5", "January vs month 5 (Codex)");
yes("female murder victims in Texas in January 2025", "SELECT COUNT(*) FROM incidents i WHERE i.year = 2025 AND i.month = 1", "January as month 1");
no("murders until July in Chicago in 2025", "SELECT COUNT(*) FROM incidents i WHERE i.year = 2025 AND i.month BETWEEN 1 AND 12", "until July with a full year (Codex)");
yes("murders as of July in Chicago in 2025", "SELECT COUNT(*) FROM incidents i WHERE i.year = 2025 AND i.month BETWEEN 1 AND 7", "as of July as Jan-Jul (Codex regression)");
no("fatal shootings in Chicago in January 2025", "SELECT year, COUNT(*) FROM incidents i WHERE i.year = 2025 GROUP BY i.year", "January with no month restriction (Codex)");
no("murders each month in Chicago in 2025", "SELECT COUNT(*) FROM incidents i WHERE i.year = 2025 AND i.month BETWEEN 1 AND 12", "each month with an annual total (Codex)");
yes("monthly murders in Chicago in 2025", "WITH RECURSIVE months(month) AS (SELECT 1 UNION ALL SELECT month + 1 FROM months WHERE month < 12) SELECT printf('%04d-%02d', 2025, m.month) AS month, COUNT(*) FROM months m JOIN incidents i ON i.month = m.month WHERE i.year = 2025 AND i.month BETWEEN 1 AND 12 GROUP BY m.month", "the murder plan's monthly shape (generator ignored)");
yes("monthly murders in Chicago in 2025 through July", "WITH RECURSIVE months(month) AS (SELECT 1 UNION ALL SELECT month + 1 FROM months WHERE month < 7) SELECT printf('%04d-%02d', 2025, m.month) AS month, COUNT(*) FROM months m JOIN incidents i ON i.month = m.month WHERE i.year = 2025 AND i.month BETWEEN 1 AND 7 GROUP BY m.month", "monthly through July");
no("murders in Texas in summer 2025", "SELECT COUNT(*) FROM incidents WHERE year = 2025 AND month BETWEEN 6 AND 8", "a season is not provable here");
yes("murders in Texas in Q2 2025", "SELECT COUNT(*) FROM incidents WHERE year = 2025 AND month BETWEEN 4 AND 6", "a quarter");
yes("murders in Texas by year since 2015", "SELECT year, COUNT(*) FROM incidents WHERE year >= 2015 GROUP BY year", "by year");
no("murders in Texas by year since 2015", "SELECT COUNT(*) FROM incidents WHERE year >= 2015", "by year without grouping");
no("murders in Texas in 2025", "SELECT COUNT(*) FROM incidents WHERE year = 2025 AND month = 3", "a month restriction the request did not ask for");
yes("murders in Texas in the last five years", "SELECT COUNT(*) FROM incidents WHERE year >= 2021", "relative wording needs some year constraint");
no("murders in Texas in the last five years", "SELECT COUNT(*) FROM incidents", "relative wording with no year constraint");

yes("fatal shootings in Chicago since 2015", "SELECT i.year, COUNT(*) FROM incidents i WHERE i.year >= 2015 AND (((i.ori = 'ILCPD00' AND i.year BETWEEN 1976 AND 2026))) GROUP BY i.year", "an ORI validity window is not the requested period");
yes("murders in Texas since 2015", "SELECT year, COUNT(*) FROM incidents WHERE year BETWEEN 2015 AND 2026 GROUP BY year", "since 2015 capped at the latest data year");
no("murders in Texas since 2015", "SELECT year, COUNT(*) FROM incidents WHERE year BETWEEN 2015 AND 2019 GROUP BY year", "since 2015 cut off early");
no("murders in Texas from 2015 to 2020", "SELECT year, COUNT(*) FROM incidents WHERE year >= 2015 GROUP BY year", "a closed range is not open-ended");
console.log(`\n${checks - failures}/${checks} passed`);
if (failures > 0) process.exit(1);
