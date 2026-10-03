#!/usr/bin/env node
/**
 * Monthly SHR data updater: a SAFE refresh (owner-approved SHR repair, 2026-10-02).
 *
 * Downloads the latest SHR master file for each requested year from the FBI CDE bucket, validates it in
 * full, builds a complete replacement database beside the live one, checks it, and only then activates it
 * through SQLite's backup API, keeping a snapshot to restore if the read-back disagrees. A failure at any
 * stage before activation leaves the live database exactly as it was. See main() for the stages.
 *
 *   node /opt/nibrs/current/scripts/ops/shr-auto-update.js [--no-activate]
 *
 * --no-activate (or SHR_REFRESH_NO_ACTIVATE=1) stops after the candidate is built and checked: nothing live
 * changes, and the candidate and snapshot are kept for inspection.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const https = require('https');
const http = require('http');

const dataDir = "/opt/nibrs/data";
const dbPath = "/opt/nibrs/shr.db";
const nibrsPath = "/opt/nibrs/nibrs.db";
const rtciPath = "/opt/nibrs/shared/crime_data.db";
const postImport = require('./shr-post-import-runtime');
const backupDir = "/opt/nibrs/backups";
const refreshStatusPath = process.env.SHR_REFRESH_STATUS_PATH || "/opt/nibrs/shr-refresh-status.json";
const postStatusPath = process.env.SHR_UPDATE_STATUS_PATH || "/opt/nibrs/shr-update-status.json";
/** Archive size cap for curl and the size check. */
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
/** Unreadable lines, or records for another year, tolerated before a file is refused (at least 5 / 10). */
const MAX_REJECT_FRACTION = 0.01;
/** A refreshed year may not shrink below this share of the incidents already loaded (SHR_ALLOW_SHRINK=1 overrides). */
const MIN_RETAIN_FRACTION = 0.95;
const ALLOW_SHRINK = process.env.SHR_ALLOW_SHRINK === "1";
/**
 * Activation is admitted only with ACTIVATION_RESERVE_MS left. Activation and its whole read-back never spend the
 * last RECOVERY_RESERVE_MS; recovery's snapshot restore never spends the last RECOVERY_VERIFY_MS, which its own
 * read-back uses (Codex SRF-1).
 */
const ACTIVATION_RESERVE_MS = 10 * 60 * 1000;
const RECOVERY_RESERVE_MS = 5 * 60 * 1000;
const RECOVERY_VERIFY_MS = 2 * 60 * 1000;
const SNAPSHOTS_KEPT = 2;

// Import the parser's lookup tables
const STATE_CODES = {
  '50':'AK','01':'AL','03':'AR','54':'AS','02':'AZ',
  '04':'CA','05':'CO','06':'CT','52':'CZ','08':'DC',
  '07':'DE','09':'FL','10':'GA','55':'GU','51':'HI',
  '14':'IA','11':'ID','12':'IL','13':'IN','15':'KS',
  '16':'KY','17':'LA','20':'MA','19':'MD','18':'ME',
  '21':'MI','22':'MN','24':'MO','23':'MS','25':'MT',
  '32':'NC','33':'ND','26':'NE','28':'NH','29':'NJ',
  '30':'NM','27':'NV','31':'NY','34':'OH','35':'OK',
  '36':'OR','37':'PA','53':'PR','38':'RI','39':'SC',
  '40':'SD','41':'TN','42':'TX','43':'UT','62':'VI',
  '45':'VA','44':'VT','46':'WA','48':'WI','47':'WV',
  '49':'WY'
};

const WEAPON_CODES = {
  '11':'Firearm (type not stated)','12':'Handgun','13':'Rifle',
  '14':'Shotgun','15':'Other Gun','20':'Knife/Cutting Instrument',
  '30':'Blunt Object','40':'Personal Weapons','50':'Poison',
  '55':'Pushed/Thrown Out Window','60':'Explosives','65':'Fire',
  '70':'Narcotics/Drugs','75':'Drowning','80':'Strangulation/Hanging',
  '85':'Asphyxiation','90':'Other/Unknown'
};

const WEAPON_GROUPS = {
  '11':'Firearm','12':'Firearm','13':'Firearm','14':'Firearm','15':'Firearm',
  '20':'Knife/Cutting','30':'Blunt Object','40':'Personal Weapons',
  '50':'Poison','55':'Other','60':'Other','65':'Fire',
  '70':'Narcotics/Drugs','75':'Other','80':'Strangulation','85':'Asphyxiation',
  '90':'Other'
};

const RELATIONSHIP_CODES = {
  'HU':'Husband','WI':'Wife','CH':'Common-Law Husband','CW':'Common-Law Wife',
  'MO':'Mother','FA':'Father','SO':'Son','DA':'Daughter',
  'BR':'Brother','SI':'Sister','IL':'In-Law',
  'SF':'Stepfather','SM':'Stepmother','SS':'Stepson','SD':'Stepdaughter',
  'OF':'Other Family',
  'NE':'Neighbor','AQ':'Acquaintance','BF':'Boyfriend','GF':'Girlfriend',
  'XH':'Ex-Husband','XW':'Ex-Wife','EE':'Employee','ER':'Employer',
  'FR':'Friend','HO':'Homosexual Relationship','OK':'Other Known',
  'ST':'Stranger','UN':'Unknown'
};

const RELATIONSHIP_GROUPS = {};
['HU','WI','CH','CW','MO','FA','SO','DA','BR','SI','IL','SF','SM','SS','SD','OF'].forEach(c => RELATIONSHIP_GROUPS[c] = 'Family');
['NE','AQ','BF','GF','XH','XW','EE','ER','FR','HO','OK'].forEach(c => RELATIONSHIP_GROUPS[c] = 'Known');
RELATIONSHIP_GROUPS['ST'] = 'Stranger';
RELATIONSHIP_GROUPS['UN'] = 'Unknown';

const CIRCUMSTANCE_CODES = {
  '02':'Rape','03':'Robbery','05':'Burglary','06':'Larceny',
  '07':'Motor Vehicle Theft','09':'Arson','10':'Prostitution',
  '17':'Other Sex Offenses','32':'Abortion','18':'Narcotic Drug Laws',
  '19':'Gambling','26':'Other Felony',
  '40':"Lover's Triangle",'41':'Child Killed by Babysitter',
  '42':'Brawl (Alcohol)','43':'Brawl (Narcotics)',
  '44':'Argument Over Money/Property','45':'Other Arguments',
  '46':'Gangland Killings','47':'Juvenile Gang Killings',
  '48':'Institutional Killings','49':'Sniper Attack','60':'Other',
  '70':'All Suspected Felony',
  '80':'Felon Killed by Private Citizen','81':'Felon Killed by Police',
  '99':'Unable to Determine',
  '50':'Hunting Accident','51':'Gun-Cleaning Death',
  '52':'Children Playing With Gun','53':'Other Negligent Gun Handling',
  '59':'Other Manslaughter by Negligence'
};

const CIRCUMSTANCE_GROUPS = {};
['02','03','05','06','07','09','10','17','32','18','19','26','70'].forEach(c => CIRCUMSTANCE_GROUPS[c] = 'Felony Type');
['40','41','42','43','44','45','46','47','48','49','60'].forEach(c => CIRCUMSTANCE_GROUPS[c] = 'Other Than Felony');
['80','81'].forEach(c => CIRCUMSTANCE_GROUPS[c] = 'Justifiable Homicide');
CIRCUMSTANCE_GROUPS['99'] = 'Undetermined';
['50','51','52','53','59'].forEach(c => CIRCUMSTANCE_GROUPS[c] = 'Manslaughter by Negligence');

const RACE_CODES = { 'W':'White','B':'Black','I':'American Indian','A':'Asian/Pacific Islander','U':'Unknown' };
const SEX_CODES = { 'M':'Male','F':'Female','U':'Unknown' };
const ETHNICITY_CODES = { 'H':'Hispanic','N':'Not Hispanic','U':'Unknown' };
const HOMICIDE_TYPES = { 'A':'Murder','B':'Manslaughter' };
const SITUATION_CODES = {
  'A':'Single Victim/Single Offender','B':'Single Victim/Unknown Offender',
  'C':'Single Victim/Multiple Offenders','D':'Multiple Victims/Single Offender',
  'E':'Multiple Victims/Multiple Offenders','F':'Multiple Victims/Unknown Offender'
};

function parseRecord(line) {
  if (line.length < 92) return null;
  if (line[0] !== '6') return null;
  const stateCode = line.substring(1, 3);
  const stateAbbr = STATE_CODES[stateCode];
  if (!stateAbbr) return null;
  return {
    stateCode, stateAbbr,
    ori: line.substring(3, 10).trim(),
    group: line.substring(10, 12).trim(),
    division: line[12],
    yearRaw: line.substring(13, 15),
    population: parseInt(line.substring(15, 24)) || 0,
    agency: line.substring(31, 55).trim(),
    stateName: line.substring(55, 61).trim(),
    month: parseInt(line.substring(61, 63)) || 0,
    actionType: line[69],
    homicideType: line[70],
    incidentNum: line.substring(71, 74).trim(),
    situation: line[74],
    v1Age: line.substring(75, 77).trim(),
    v1Sex: line[77],
    v1Race: line[78],
    v1Ethnicity: line[79],
    o1Age: line.substring(80, 82).trim(),
    o1Sex: line[82],
    o1Race: line[83],
    o1Ethnicity: line[84],
    weapon: line.substring(85, 87).trim(),
    relationship: line.substring(87, 89).trim(),
    circumstance: line.substring(89, 91).trim(),
    subCircumstance: line[91] || '',
    addlVictimCount: parseInt(line.substring(92, 95)) || 0,
  };
}

function parseAge(ageStr) {
  if (!ageStr || ageStr === '00') return { age: 'Unknown', ageNum: null };
  if (ageStr === 'NB') return { age: 'Newborn', ageNum: 0 };
  if (ageStr === 'BB') return { age: 'Baby', ageNum: 0 };
  if (ageStr === '99') return { age: '99+', ageNum: 99 };
  const n = parseInt(ageStr);
  if (!isNaN(n) && n >= 1 && n <= 98) return { age: String(n), ageNum: n };
  return { age: 'Unknown', ageNum: null };
}

function resolveYear(yearRaw, fileYear) {
  const yr2 = parseInt(yearRaw);
  if (isNaN(yr2)) return fileYear;
  const century = Math.floor(fileYear / 100) * 100;
  let year = century + yr2;
  if (year > fileYear + 1) year -= 100;
  return year;
}

// Download a file from a URL (follows redirects)
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(dest);
    proto.get(url, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlinkSync(dest);
        return downloadFile(response.headers.location, dest).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlinkSync(dest);
        return reject(new Error(`HTTP ${response.statusCode} for ${url}`));
      }
      response.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', (err) => {
      fs.unlinkSync(dest);
      reject(err);
    });
  });
}

/** A refusal of the refresh itself (download, validation, candidate, activation): nothing live was changed by it. */
class RefreshRefusal extends Error {
  constructor(stage, reasons) {
    super(`SHR refresh ${stage} refused: ${reasons.join('; ')}`);
    this.name = 'RefreshRefusal';
    this.stage = stage;
    this.reasons = reasons;
  }
}

const seconds = (ms) => String(Math.max(1, Math.floor(ms / 1000)));
/** A path that is safe inside a single-quoted sqlite3 dot-command argument. */
function sqlitePath(p) {
  if (/['\r\n]/.test(p)) throw new RefreshRefusal('candidate', [`unusable path for sqlite3: ${p}`]);
  return `'${p}'`;
}
/** One sqlite3 CLI command, admitted against the deadline and bounded by it; no shell. */
function sqlite(runtime, deadline, what, args, limitMs) {
  return execFileSync(runtime.sqliteBin, ['-bail', ...args], { timeout: postImport.admit(deadline, what, limitMs), maxBuffer: 1 << 20 }).toString().trim();
}

/**
 * Download one year to a TEMPORARY file and prove it is a readable archive. The previous archive is not
 * touched here: it is replaced only after the content has also been validated (`acceptArchive`). curl runs
 * with --fail (an HTTP error is an error, not a saved body), a size cap, a time cap and https only.
 */
function downloadSHR(year, deadline) {
  const dest = path.join(dataDir, `shr-${year}.zip`);
  const tmp = `${dest}.download-${process.pid}`;
  console.log(`Downloading shr-${year}.zip...`);
  fs.rmSync(tmp, { force: true });
  try {
    const signedUrlEndpoint = `https://cde.ucr.cjis.gov/LATEST/s3/signedurl?key=master_files/shr/shr-${year}.zip`;
    const t1 = postImport.admit(deadline, 'signed-URL curl', 30000);
    const jsonStr = execFileSync('curl', ['--fail', '-sS', '--proto', '=https', '--max-time', seconds(t1), signedUrlEndpoint], { timeout: t1 }).toString();
    const signedUrl = Object.values(JSON.parse(jsonStr))[0];
    if (typeof signedUrl !== 'string' || !signedUrl.startsWith('https://')) throw new Error('no https signed URL in the response');
    const t2 = postImport.admit(deadline, 'download curl', 300000);
    execFileSync('curl', ['--fail', '-sS', '-L', '--proto', '=https', '--max-time', seconds(t2), '--max-filesize', String(MAX_ARCHIVE_BYTES), '-o', tmp, signedUrl], { timeout: t2 });
    const size = fs.existsSync(tmp) ? fs.statSync(tmp).size : 0;
    if (size < 1000 || size > MAX_ARCHIVE_BYTES) throw new Error(`downloaded archive has an unusable size (${size} bytes)`);
    execFileSync('unzip', ['-tqq', tmp], { timeout: postImport.admit(deadline, `archive test ${year}`, 120000) });
    const entries = execFileSync('unzip', ['-Z1', tmp], { timeout: postImport.admit(deadline, `archive list ${year}`, 30000) }).toString().split(/\r?\n/).filter(Boolean);
    if (entries.length === 0) throw new Error('archive has no entries');
    console.log(`  Downloaded and tested: ${tmp} (${(size / 1024).toFixed(0)}KB; ${entries.length} entr${entries.length === 1 ? 'y' : 'ies'})`);
    return { year, tmp, dest, size, entries };
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    if (e instanceof postImport.PostImportRefusal) throw e;
    // No fallback import: the previous archive is preserved, and the live data is not refreshed from it.
    throw new RefreshRefusal('download', [`shr-${year}.zip: ${String(e.message).split('\n')[0]}`]);
  }
}

/** The incident and victim values exactly as the served importer inserted them (same expressions, same order). */
function incidentValues(rec, recYear, normalizeAgency) {
  const o1 = parseAge(rec.o1Age);
  return [
    recYear, rec.month, rec.stateAbbr, rec.ori, normalizeAgency(rec.agency),
    rec.population, SITUATION_CODES[rec.situation] || rec.situation || null, parseInt(rec.division) || 0,
    HOMICIDE_TYPES[rec.homicideType] || rec.homicideType,
    WEAPON_CODES[rec.weapon] || rec.weapon || 'Unknown',
    WEAPON_GROUPS[rec.weapon] || 'Other',
    RELATIONSHIP_CODES[rec.relationship] || rec.relationship || 'Unknown',
    RELATIONSHIP_GROUPS[rec.relationship] || 'Unknown',
    CIRCUMSTANCE_CODES[rec.circumstance] || rec.circumstance || 'Unknown',
    CIRCUMSTANCE_GROUPS[rec.circumstance] || 'Unknown',
    o1.age, o1.ageNum,
    SEX_CODES[rec.o1Sex] || 'Unknown',
    RACE_CODES[rec.o1Race] || 'Unknown',
    ETHNICITY_CODES[rec.o1Ethnicity] || 'Unknown',
  ];
}
function victimValues(rec, line) {
  const v1 = parseAge(rec.v1Age);
  const victims = [[1, v1.age, v1.ageNum, SEX_CODES[rec.v1Sex] || 'Unknown', RACE_CODES[rec.v1Race] || 'Unknown', ETHNICITY_CODES[rec.v1Ethnicity] || 'Unknown']];
  // Additional victims (multi-victim incidents: situations D, E, F), as the served importer read them.
  const addlVicCount = rec.addlVictimCount || 0;
  if (addlVicCount > 0 && line.length > 98) {
    let vPos = 98;
    for (let av = 0; av < addlVicCount && av < 10 && vPos + 4 < line.length; av++) {
      const avAge = line.substring(vPos, vPos + 2).trim();
      const avSex = line[vPos + 2] || '';
      const avRace = line[vPos + 3] || '';
      const avEth = (vPos + 4 < line.length) ? line[vPos + 4] : '';
      const avParsed = parseAge(avAge);
      if (avAge && avAge !== '00' && avSex && avSex !== '0' && avSex !== ' ') {
        victims.push([av + 2, avParsed.age, avParsed.ageNum, SEX_CODES[avSex] || 'Unknown', RACE_CODES[avRace] || 'Unknown', ETHNICITY_CODES[avEth] || 'Unknown']);
      }
      vPos += 5;
    }
  }
  return victims;
}

/**
 * Parse one year's file IN FULL before any database is touched. Every non-blank line is either a record for
 * the requested year or a counted rejection with its reason. A record for another year is never written (the
 * served importer inserted it while deleting only the requested year).
 */
function parseYearFile(content, year) {
  const rejected = { short: 0, 'not-a-record': 0, 'unknown-state': 0, 'year-out-of-range': 0, 'other-year': 0 };
  const records = [];
  let nonBlank = 0;
  let victims = 0;
  let maxMonth = 0;
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    nonBlank++;
    if (line.length < 92) { rejected.short++; continue; }
    if (line[0] !== '6') { rejected['not-a-record']++; continue; }
    const rec = parseRecord(line);
    if (!rec) { rejected['unknown-state']++; continue; }
    const recYear = resolveYear(rec.yearRaw, year);
    if (recYear < 1960 || recYear > 2030) { rejected['year-out-of-range']++; continue; }
    if (recYear !== year) { rejected['other-year']++; continue; }
    const v = victimValues(rec, line);
    victims += v.length;
    if (rec.month > maxMonth) maxMonth = rec.month;
    records.push({ rec, recYear, victims: v });
  }
  return { year, nonBlank, records, victims, maxMonth, rejected };
}

/** The content checks that decide whether this file may replace the year. Reasons are returned, not thrown. */
function contentProblems(parsed, live) {
  const problems = [];
  const structural = parsed.rejected.short + parsed.rejected['not-a-record'] + parsed.rejected['unknown-state'] + parsed.rejected['year-out-of-range'];
  const allowed = (n) => Math.max(5, Math.floor(parsed.nonBlank * MAX_REJECT_FRACTION), n);
  if (parsed.records.length === 0) problems.push(`no records for ${parsed.year}`);
  if (structural > allowed(0)) problems.push(`${structural} of ${parsed.nonBlank} lines are not readable records (${JSON.stringify(parsed.rejected)})`);
  if (parsed.rejected['other-year'] > allowed(10)) problems.push(`${parsed.rejected['other-year']} of ${parsed.nonBlank} records are for another year`);
  if (!ALLOW_SHRINK && live.incidents > 0) {
    if (parsed.records.length < Math.ceil(live.incidents * MIN_RETAIN_FRACTION)) {
      problems.push(`the file has ${parsed.records.length} incidents for ${parsed.year}, fewer than ${MIN_RETAIN_FRACTION * 100}% of the ${live.incidents} already loaded`);
    }
    if (parsed.maxMonth < live.maxMonth) problems.push(`the file ends at month ${parsed.maxMonth}, before the loaded month ${live.maxMonth}`);
  }
  return problems;
}

/** Incidents and victims per year, the reconciliation every stage is checked against. */
function yearCounts(Database, file) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    const inc = db.prepare('SELECT year, COUNT(*) AS n, MAX(month) AS m FROM incidents GROUP BY year ORDER BY year').all();
    const vic = new Map(db.prepare('SELECT i.year AS year, COUNT(*) AS n FROM victims v JOIN incidents i ON i.id = v.incident_id GROUP BY i.year').all().map((r) => [r.year, r.n]));
    return inc.map((r) => ({ year: r.year, incidents: r.n, victims: vic.get(r.year) || 0, maxMonth: r.m || 0 }));
  } finally { db.close(); }
}
const countsFor = (counts, year) => counts.find((c) => c.year === year) || { year, incidents: 0, victims: 0, maxMonth: 0 };
/** Agencies of the refreshed years that the evidence build did not assess (the ranking would call them unresolved). */
function unassessedAgencies(Database, file, years) {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shr_agency_type_binding'").get()) return -1;
    const q = db.prepare('SELECT COUNT(*) AS n FROM (SELECT DISTINCT ori, state FROM incidents WHERE year = ?) a LEFT JOIN shr_agency_type_binding b ON b.ori = a.ori AND b.state = a.state WHERE b.ori IS NULL');
    return years.reduce((sum, y) => sum + q.get(y).n, 0);
  } finally { db.close(); }
}
/**
 * Per-year incident/victim counts, last month, and the evidence ROW COUNT (not its values), as one text read by a
 * bounded sqlite3 child process. Used for the activation and rollback read-backs, which must not run in process.
 * Requires the evidence table, which every candidate and the production snapshot have.
 */
const SUMMARY_SQL = "WITH inc AS (SELECT year, COUNT(*) AS n, MAX(month) AS m FROM incidents GROUP BY year), " +
  "vic AS (SELECT i.year AS year, COUNT(*) AS v FROM victims v JOIN incidents i ON i.id = v.incident_id GROUP BY i.year) " +
  "SELECT 'year' AS k, inc.year AS year, inc.n AS incidents, COALESCE(vic.v, 0) AS victims, COALESCE(inc.m, 0) AS maxMonth FROM inc LEFT JOIN vic ON vic.year = inc.year " +
  "UNION ALL SELECT 'binding', NULL, (SELECT COUNT(*) FROM shr_agency_type_binding), NULL, NULL ORDER BY 1 DESC, 2;";
function summary(runtime, budget, what, file) {
  return sqlite(runtime, budget, what, ['-readonly', '-json', file, SUMMARY_SQL], 600000);
}

async function main() {
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  const defaultProtectedYears = currentMonth >= 6 ? String(currentYear - 1) : '';
  const defaultRequestedYears = currentMonth < 6 ? `${currentYear - 1},${currentYear}` : String(currentYear);
  const protectedYears = new Set((process.env.PROTECTED_UPDATE_YEARS ?? defaultProtectedYears)
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(Number.isFinite));
  const requestedYears = (process.env.SHR_UPDATE_YEARS || defaultRequestedYears)
    .split(',')
    .map(s => parseInt(s.trim(), 10))
    .filter(Number.isFinite);
  const yearsToUpdate = [...new Set(requestedYears)].sort();
  const blockedYears = yearsToUpdate.filter(y => protectedYears.has(y));
  if (blockedYears.length) {
    throw new Error(`Refusing to update protected SHR year(s): ${blockedYears.join(', ')}`);
  }
  const activate = !process.argv.includes('--no-activate') && process.env.SHR_REFRESH_NO_ACTIVATE !== '1';

  console.log(`\n=== SHR Update: ${now.toISOString()} ===`);
  console.log(`Updating years: ${yearsToUpdate.join(', ')}${activate ? '' : ' (validate only: --no-activate)'}\n`);

  /*
   * THE SAFE REFRESH (owner-approved SHR repair, 2026-10-02). The live database is never written until a
   * complete replacement has been built and checked beside it:
   *   1. preflight the pinned runtime (scripts/ops/shr-post-import-runtime.js) before any download;
   *   2. download each year to a temporary file, test the archive, parse and validate EVERY line; only then
   *      replace the previous archive (a failed download leaves it, and stops the run -- no fallback import);
   *   3. snapshot the live database with SQLite's online backup, and build a candidate from that snapshot;
   *   4. replace the year inside the candidate in ONE transaction, reconciled to the validated input;
   *   5. run the reviewed evidence builder and ANALYZE on the candidate (the old normalizer is not run: it
   *      writes derived types into incidents, which the classification policy forbids), then check it;
   *   6. activate by SQLite's backup API into the live file (`.restore`, never a rename), read back, and
   *      restore the snapshot the same way if the read-back disagrees.
   * Every child process and destructive step is admitted against one deadline, with time reserved for rollback.
   */
  const deadline = postImport.createDeadline(Number(process.env.SHR_UPDATE_DEADLINE_MS) || 60 * 60 * 1000);
  const runtime = postImport.resolveRuntime();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const pre = path.join(backupDir, `shr-pre-${stamp}.db`);
  const candidate = path.join(backupDir, `shr-candidate-${stamp}.db`);
  const lock = path.join(backupDir, 'shr-refresh.lock');
  const postSteps = postImport.shrTypeRecoverySteps({ shrDbPath: candidate, nibrsDbPath: nibrsPath, rtciDbPath: rtciPath });
  const status = { kind: 'shr-refresh', startedAt: now.toISOString(), years: yearsToUpdate, activate, release: runtime.release, node: process.version, stage: 'preflight', outcome: 'running', pre, candidate };
  const record = (patch) => { Object.assign(status, patch); postImport.writeStatus(refreshStatusPath, status); };
  record({});

  fs.mkdirSync(backupDir, { recursive: true });
  let lockFd = null;
  try { lockFd = fs.openSync(lock, 'wx'); } catch (e) {
    record({ outcome: 'refused', stage: 'lock', reason: `${lock} exists: another refresh is running, or a previous one stopped without releasing it` });
    throw new RefreshRefusal('lock', [`${lock} exists`]);
  }
  try {
    postImport.preflight(runtime, postSteps, deadline);
    console.log(`Post-import runtime: ${runtime.release} (Node ${process.version})`);
    const Database = require(runtime.betterSqlite3);   // the importer's own database module comes from the same release

    // Disk: a snapshot and a candidate beside the live file, each at most its size, plus the WAL a restore writes.
    const liveSize = fs.statSync(dbPath).size;
    const free = (() => { const s = fs.statfsSync(backupDir); return s.bavail * s.bsize; })();
    if (free < liveSize * 3.2) throw new RefreshRefusal('disk', [`${free} bytes free in ${backupDir}; need ${Math.ceil(liveSize * 3.2)}`]);

    // 2. Download, test, parse and validate every year before any database work.
    record({ stage: 'download' });
    const liveBefore = yearCounts(Database, dbPath);
    const files = [];
    for (const year of yearsToUpdate) {
      const archive = downloadSHR(year, deadline);
      let content;
      try {
        content = execFileSync('unzip', ['-p', archive.tmp], { maxBuffer: 200 * 1024 * 1024, timeout: postImport.admit(deadline, `unzip ${year}`) }).toString('latin1');
      } catch (e) {
        fs.rmSync(archive.tmp, { force: true });
        if (e instanceof postImport.PostImportRefusal) throw e;
        throw new RefreshRefusal('validation', [`shr-${year}.zip could not be extracted: ${String(e.message).split('\n')[0]}`]);
      }
      const parsed = parseYearFile(content, year);
      const problems = contentProblems(parsed, countsFor(liveBefore, year));
      const summary = { year, entries: archive.entries, nonBlank: parsed.nonBlank, records: parsed.records.length, victims: parsed.victims, maxMonth: parsed.maxMonth, rejected: parsed.rejected };
      console.log(`  ${year}: ${parsed.records.length} records, ${parsed.victims} victims, through month ${parsed.maxMonth}; rejected ${JSON.stringify(parsed.rejected)}`);
      if (problems.length > 0) {
        fs.rmSync(archive.tmp, { force: true });
        record({ stage: 'validation', outcome: 'refused', validation: [...(status.validation || []), summary], reasons: problems });
        throw new RefreshRefusal('validation', problems);
      }
      fs.renameSync(archive.tmp, archive.dest);   // the newly usable archive replaces the previous one only now
      files.push(parsed);
      record({ validation: [...(status.validation || []), summary] });
    }

    // 3. Snapshot (the rollback copy) and candidate, both through SQLite's online backup.
    record({ stage: 'candidate' });
    for (const old of fs.readdirSync(backupDir).filter((n) => /^shr-candidate-.*\.db(-wal|-shm|-journal)?$/.test(n))) fs.rmSync(path.join(backupDir, old), { force: true });
    sqlite(runtime, deadline, 'snapshot', [dbPath, `.backup ${sqlitePath(pre)}`], 600000);
    if (sqlite(runtime, deadline, 'snapshot check', [pre, 'PRAGMA quick_check;'], 600000) !== 'ok') throw new RefreshRefusal('candidate', ['the snapshot failed its integrity check']);
    sqlite(runtime, deadline, 'candidate copy', [pre, `.backup ${sqlitePath(candidate)}`], 600000);
    const baseline = yearCounts(Database, pre);

    // 4. Replace each year inside the candidate, in one transaction, reconciled before it commits.
    const cand = new Database(candidate, { fileMustExist: true });
    try {
      const agencyNameMap = {};
      for (const row of cand.prepare("SELECT DISTINCT agency, UPPER(agency) as upper_name FROM incidents WHERE agency != UPPER(agency)").all()) agencyNameMap[row.upper_name] = row.agency;
      const normalizeAgency = (name) => agencyNameMap[name] || agencyNameMap[name.toUpperCase()] || name;
      const insertIncident = cand.prepare(`
    INSERT INTO incidents (year, month, state, ori, agency, population, situation,
      division, homicide_type, weapon, weapon_group,
      relationship, relationship_group, circumstance, circumstance_group,
      off_age, off_age_num, off_sex, off_race, off_ethnicity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
      const insertVictim = cand.prepare(`
    INSERT INTO victims (incident_id, victim_num, age, age_num, sex, race, ethnicity)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
      const replace = cand.transaction(() => {
        for (const parsed of files) {
          const year = parsed.year;
          const delVic = cand.prepare('DELETE FROM victims WHERE incident_id IN (SELECT id FROM incidents WHERE year = ?)').run(year);
          const delInc = cand.prepare('DELETE FROM incidents WHERE year = ?').run(year);
          console.log(`  candidate: deleted ${delInc.changes} incidents, ${delVic.changes} victims for ${year}`);
          let n = 0;
          for (const { rec, recYear, victims } of parsed.records) {
            if (++n % 1000 === 0) postImport.admit(deadline, `replace ${year} (record ${n})`);
            const incidentId = insertIncident.run(...incidentValues(rec, recYear, normalizeAgency)).lastInsertRowid;
            for (const v of victims) insertVictim.run(incidentId, ...v);
          }
          const got = cand.prepare('SELECT COUNT(*) AS n FROM incidents WHERE year = ?').get(year).n;
          const gotV = cand.prepare('SELECT COUNT(*) AS n FROM victims WHERE incident_id IN (SELECT id FROM incidents WHERE year = ?)').get(year).n;
          if (got !== parsed.records.length || gotV !== parsed.victims) {
            throw new RefreshRefusal('candidate', [`${year} reconciles to ${got} incidents / ${gotV} victims, not the validated ${parsed.records.length} / ${parsed.victims}`]);
          }
        }
        postImport.admit(deadline, 'candidate commit');
      });
      replace();
    } finally { cand.close(); }

    // 5. The reviewed evidence builder and ANALYZE, on the candidate, through the pinned runtime.
    record({ stage: 'post-import' });
    postImport.runSteps(runtime, postSteps, deadline, { statusPath: postStatusPath });

    // Check the candidate: integrity, every untouched year exactly as before, refreshed years as validated,
    // and every agency of a refreshed year assessed by the evidence build.
    record({ stage: 'candidate-check' });
    const refreshed = new Set(files.map((f) => f.year));
    const candCounts = yearCounts(Database, candidate);
    const problems = [];
    if (sqlite(runtime, deadline, 'candidate check', [candidate, 'PRAGMA quick_check;'], 600000) !== 'ok') problems.push('the candidate failed its integrity check');
    for (const b of baseline) {
      if (refreshed.has(b.year)) continue;
      const c = countsFor(candCounts, b.year);
      if (c.incidents !== b.incidents || c.victims !== b.victims) problems.push(`${b.year} changed (${b.incidents}/${b.victims} -> ${c.incidents}/${c.victims})`);
    }
    for (const c of candCounts) if (!refreshed.has(c.year) && !baseline.some((b) => b.year === c.year)) problems.push(`unexpected year ${c.year} appeared`);
    for (const f of files) {
      const c = countsFor(candCounts, f.year);
      if (c.incidents !== f.records.length || c.victims !== f.victims) problems.push(`${f.year} is ${c.incidents}/${c.victims}, not the validated ${f.records.length}/${f.victims}`);
    }
    const unassessed = unassessedAgencies(Database, candidate, [...refreshed]);
    if (unassessed !== 0) problems.push(unassessed < 0 ? 'the candidate has no agency-type evidence' : `${unassessed} agencies of the refreshed year(s) were not assessed by the evidence build`);
    const before = Object.fromEntries(files.map((f) => [f.year, countsFor(baseline, f.year)]));
    record({ candidateCounts: files.map((f) => ({ year: f.year, before: before[f.year], after: countsFor(candCounts, f.year) })), unassessed });
    if (problems.length > 0) { record({ outcome: 'refused', reasons: problems }); throw new RefreshRefusal('candidate', problems); }

    if (!activate) {
      record({ stage: 'validated', outcome: 'validated-not-activated', finishedAt: new Date().toISOString() });
      console.log(`\nCandidate validated and NOT activated: ${candidate} (snapshot ${pre}).`);
      return;
    }

    // 6. Activate through the backup API. The deadline is split in two (Codex SRF-1): the WORK budget covers the
    // activation restore AND every read-back operation, and always leaves RECOVERY_RESERVE_MS untouched; recovery
    // spends that reserve on the snapshot restore (bounded so RECOVERY_VERIFY_MS remains) and then its own check.
    // Every read-back step is a bounded sqlite3 child process admitted against its budget -- none runs in process,
    // where a slow query could not be stopped and would spend time the rollback needs.
    record({ stage: 'activation' });
    // The expected summaries are read BEFORE activation, while a slow read can only delay, not endanger, the live file.
    const candSummary = summary(runtime, deadline, 'candidate summary', candidate);
    const preSummary = summary(runtime, deadline, 'snapshot summary', pre);
    if (deadline.remainingMs() < ACTIVATION_RESERVE_MS) {
      record({ outcome: 'refused', reasons: [`activation not admitted: ${deadline.remainingMs()} ms left, ${ACTIVATION_RESERVE_MS} reserved`] });
      throw new RefreshRefusal('activation', [`not admitted: ${deadline.remainingMs()} ms left`]);
    }
    const work = { remainingMs: () => deadline.remainingMs() - RECOVERY_RESERVE_MS };
    const recoveryRestore = { remainingMs: () => deadline.remainingMs() - RECOVERY_VERIFY_MS };
    const verifyLive = (budget, expected, label) => {
      const why = [];
      if (sqlite(runtime, budget, `${label} integrity check`, [dbPath, 'PRAGMA quick_check;'], 600000) !== 'ok') why.push('the live database failed its integrity check');
      if (summary(runtime, budget, `${label} counts`, dbPath) !== expected) why.push('the live year counts or agency-type evidence count differ from the expected database');
      return why;
    };
    let failure = [];
    try {
      sqlite(runtime, work, 'activation restore', [dbPath, `.restore ${sqlitePath(candidate)}`], 600000);
      failure = verifyLive(work, candSummary, 'live');
    } catch (e) {
      failure = [`activation failed: ${String(e.message).split('\n')[0]}`];
    }
    if (failure.length > 0) {
      record({ stage: 'rollback', reasons: failure });
      let rollback = [];
      try {
        sqlite(runtime, recoveryRestore, 'rollback restore', [dbPath, `.restore ${sqlitePath(pre)}`], 600000);
        rollback = verifyLive(deadline, preSummary, 'rollback');
      } catch (e) { rollback = [`rollback failed: ${String(e.message).split('\n')[0]}`]; }
      record({ outcome: rollback.length === 0 ? 'rolled-back' : 'rollback-failed', rollback, finishedAt: new Date().toISOString() });
      throw new RefreshRefusal('activation', [...failure, ...(rollback.length ? rollback : ['the snapshot was restored and verified'])]);
    }

    // Retention: the candidate now equals the live file; keep the two newest snapshots for rollback.
    for (const ext of ['', '-wal', '-shm', '-journal']) fs.rmSync(candidate + ext, { force: true });
    const snapshots = fs.readdirSync(backupDir).filter((n) => /^shr-pre-\d{8}T\d{6}Z\.db$/.test(n)).sort();
    for (const old of snapshots.slice(0, Math.max(0, snapshots.length - SNAPSHOTS_KEPT))) {
      for (const ext of ['', '-wal', '-shm', '-journal']) fs.rmSync(path.join(backupDir, old + ext), { force: true });   // a read-only open leaves side files
    }
    record({ stage: 'done', outcome: 'ok', liveCounts: files.map((f) => countsFor(candCounts, f.year)), finishedAt: new Date().toISOString() });
    console.log('\nUpdate complete!');
  } catch (e) {
    if (status.outcome === 'running') record({ outcome: 'failed', failedStage: status.stage, error: String(e && e.message || e).split('\n')[0], finishedAt: new Date().toISOString() });
    throw e;
  } finally {
    if (lockFd !== null) { fs.closeSync(lockFd); fs.rmSync(lock, { force: true }); }
  }
}

main().catch(e => { console.error(e); process.exit(1); });
