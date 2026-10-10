/*
 * Carjacking hotfix (plan docs/superpowers/plans/2026-10-10-carjacking-contract-hotfix.md r1.1): carjacking is not
 * human trafficking. The query contract gives carjacking no NIBRS code (it is robbery 120 with a stolen vehicle; 64A/64B
 * are human trafficking), the named incident scope no longer maps it, and every code-only builder declines a request
 * naming a code-less family (carjacking, domestic violence), even beside a coded offense. No database, no route.
 */
import assert from "node:assert/strict";
import scopes from "../lib/nibrs-incident-offense-scopes.json";
import { buildQueryContract, hasCodelessFamily } from "../lib/query-contract";
import { buildNibrsJuvenileArrestsByRaceQuery, buildNibrsNationalArrestQuery } from "../lib/nibrs-rollup-deterministic";
import { buildNibrsJuvenileOffenderIncidentQuery } from "../lib/nibrs-deterministic-queries";

let checks = 0;
const check = (ok: boolean, label: string) => { checks += 1; assert.ok(ok, label); if (!process.env.QUIET) console.log(`  PASS  ${label}`); };
const contract = (q: string) => buildQueryContract(q, "nibrs")!;

const cj = contract("carjackings in Chicago in 2024");
check(cj.metric.topic === "carjacking" && cj.metric.offenseCodes.length === 0, "carjacking has no offense code in the contract");
check(!JSON.stringify(cj.metric).includes("64A") && !JSON.stringify(cj.metric).includes("64B"), "carjacking never carries the human-trafficking codes 64A/64B");
check(!("carjacking" in (scopes as Record<string, string[]>)), "the named incident scopes do not map carjacking");
check(hasCodelessFamily(cj), "a carjacking request names a code-less family");
check(hasCodelessFamily(contract("carjackings and robberies in Chicago in 2024")) && hasCodelessFamily(contract("robberies and carjackings in Chicago in 2024")), "a mixed carjacking/robbery request still names a code-less family, in either order");
check(hasCodelessFamily(contract("domestic violence arrests nationally in 2024")), "domestic violence is a code-less family too");
check(!hasCodelessFamily(contract("robberies in Chicago in 2024")), "a coded offense alone is not a code-less family");

// Both arrest builders: decline a code-less family; unrestricted and coded arrest questions build as before.
check(buildNibrsNationalArrestQuery("national carjacking arrests in 2024", true) === null, "national arrests: carjacking is declined, not answered as all arrests");
check(buildNibrsNationalArrestQuery("carjacking and robbery arrests nationally in 2024", true) === null, "national arrests: carjacking and robbery is declined, not answered as robbery alone");
check(buildNibrsNationalArrestQuery("domestic violence arrests nationally in 2024", true) === null, "national arrests: domestic violence is declined, not answered as all arrests");
const all = buildNibrsNationalArrestQuery("How many arrests each year in the united states?", true);
check(Boolean(all) && !/ucr_arrest_offense/.test(all!.sql), "national arrests: an unrestricted arrest question still builds, unrestricted");
const rob = buildNibrsNationalArrestQuery("national robbery arrests in 2024", true);
check(Boolean(rob) && /ucr_arrest_offense IN \('120'\)/.test(rob!.sql), "national arrests: a coded offense still builds with its code");
check(buildNibrsJuvenileArrestsByRaceQuery("juvenile carjacking arrests by race nationally in 2024", true) === null, "juvenile arrests by race: carjacking is declined");
check(buildNibrsJuvenileArrestsByRaceQuery("juvenile domestic violence arrests by race nationally in 2024", true) === null, "juvenile arrests by race: domestic violence is declined");
check(Boolean(buildNibrsJuvenileArrestsByRaceQuery("juvenile arrests by race nationally", true)), "juvenile arrests by race: the unrestricted question still builds");

// The juvenile-offender incident path (its named scope used to map carjacking to 64A/64B).
check(buildNibrsJuvenileOffenderIncidentQuery("how many carjacking incidents had offenders under 18 in Chicago in 2024?") === null, "juvenile-offender incidents: carjacking is declined before scope selection");
const robInc = buildNibrsJuvenileOffenderIncidentQuery("how many robbery incidents had offenders under 18 in Illinois in 2024?");
check(robInc === null || !/offense_scope\s*=\s*'carjacking'/.test(robInc.sql), "juvenile-offender incidents: a robbery question never reads the carjacking scope");

console.log(`\n${checks}/${checks} passed`);
