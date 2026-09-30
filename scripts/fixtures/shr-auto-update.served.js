#!/usr/bin/env node
/**
 * Monthly SHR data updater.
 *
 * Downloads the latest SHR master files from FBI CDE S3 bucket,
 * parses them, and updates the SQLite database.
 *
 * Run on the 15th of each month: node scripts/update-shr.js
 *
 * What it does:
 * 1. Downloads the current year + previous year SHR zip files
 * 2. Extracts and parses the fixed-width records
 * 3. Deletes existing records for those years from the DB
 * 4. Inserts the fresh records
 * 5. Rebuilds indexes
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');
const http = require('http');

const dataDir = "/opt/nibrs/data";
const dbPath = "/opt/nibrs/shr.db";

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

async function downloadSHR(year) {
  const dest = path.join(dataDir, `shr-${year}.zip`);
  console.log(`Downloading shr-${year}.zip...`);

  try {
    // Step 1: Get a signed URL from the CDE API
    const signedUrlEndpoint = `https://cde.ucr.cjis.gov/LATEST/s3/signedurl?key=master_files/shr/shr-${year}.zip`;
    const jsonStr = execSync(`curl -s "${signedUrlEndpoint}"`, { timeout: 30000 }).toString();
    const json = JSON.parse(jsonStr);
    const signedUrl = Object.values(json)[0];

    if (!signedUrl) throw new Error('No signed URL in response');

    // Step 2: Download using the signed URL
    execSync(`curl -sL -o "${dest}" "${signedUrl}"`, { timeout: 120000 });

    if (fs.existsSync(dest) && fs.statSync(dest).size > 1000) {
      console.log(`  Downloaded: ${dest} (${(fs.statSync(dest).size / 1024).toFixed(0)}KB)`);
      return dest;
    }
    throw new Error('Downloaded file too small');
  } catch (e) {
    console.log(`  Could not download shr-${year}.zip: ${e.message}`);
    console.log(`  Using existing file if available`);
    return fs.existsSync(dest) && fs.statSync(dest).size > 1000 ? dest : null;
  }
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

  console.log(`\n=== SHR Update: ${now.toISOString()} ===`);
  console.log(`Updating years: ${yearsToUpdate.join(', ')}\n`);

  // Download latest files
  for (const year of yearsToUpdate) {
    await downloadSHR(year);
  }

  // Open DB
  const Database = require('better-sqlite3');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = OFF');

// Build agency name normalization map from existing data
  // Newer SHR files use ALL CAPS; this maps them to the mixed-case form used historically
  const agencyNameMap = {};
  const existingAgencies = db.prepare(
    "SELECT DISTINCT agency, UPPER(agency) as upper_name FROM incidents WHERE agency != UPPER(agency)"
  ).all();
  for (const row of existingAgencies) {
    agencyNameMap[row.upper_name] = row.agency;
  }
  console.log("Agency name map loaded:", Object.keys(agencyNameMap).length, "entries");
  function normalizeAgency(name) { return agencyNameMap[name] || agencyNameMap[name.toUpperCase()] || name; }
  const insertIncident = db.prepare(`
    INSERT INTO incidents (year, month, state, ori, agency, population, situation,
      division, homicide_type, weapon, weapon_group,
      relationship, relationship_group, circumstance, circumstance_group,
      off_age, off_age_num, off_sex, off_race, off_ethnicity)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertVictim = db.prepare(`
    INSERT INTO victims (incident_id, victim_num, age, age_num, sex, race, ethnicity)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const year of yearsToUpdate) {
    const zipPath = path.join(dataDir, `shr-${year}.zip`);
    if (!fs.existsSync(zipPath) || fs.statSync(zipPath).size < 100) {
      console.log(`Skipping ${year} — no valid zip file`);
      continue;
    }

    // Delete existing records for this year
    const delResult = db.prepare('DELETE FROM victims WHERE incident_id IN (SELECT id FROM incidents WHERE year = ?)').run(year);
    const delInc = db.prepare('DELETE FROM incidents WHERE year = ?').run(year);
    console.log(`Deleted ${delInc.changes} incidents, ${delResult.changes} victims for ${year}`);

    // Extract and parse
    let content;
    try {
      content = execSync(`unzip -p "${zipPath}"`, { maxBuffer: 50 * 1024 * 1024 }).toString('latin1');
    } catch (e) {
      console.error(`Failed to unzip ${zipPath}: ${e.message}`);
      continue;
    }

    const lines = content.split(/\r?\n/);
    let fileRecords = 0;
    let fileVictims = 0;

    const insertMany = db.transaction(() => {
      for (const line of lines) {
        if (line.length < 92) continue;
        const rec = parseRecord(line);
        if (!rec) continue;

        const recYear = resolveYear(rec.yearRaw, year);
        if (recYear < 1960 || recYear > 2030) continue;

        // Parse offender demographics (positions 80-84)
        const o1 = parseAge(rec.o1Age);

        const result = insertIncident.run(
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
          ETHNICITY_CODES[rec.o1Ethnicity] || 'Unknown'
        );

        const incidentId = result.lastInsertRowid;
        const v1 = parseAge(rec.v1Age);
        insertVictim.run(incidentId, 1, v1.age, v1.ageNum,
          SEX_CODES[rec.v1Sex] || 'Unknown',
          RACE_CODES[rec.v1Race] || 'Unknown',
          ETHNICITY_CODES[rec.v1Ethnicity] || 'Unknown');

        // Parse additional victims (multi-victim incidents: situations D, E, F)
        const addlVicCount = rec.addlVictimCount || 0;
        if (addlVicCount > 0 && line.length > 98) {
          // Position 95-97 = additional offender count, 98+ = additional victim blocks (5 chars each)
          let vPos = 98;
          for (let av = 0; av < addlVicCount && av < 10 && vPos + 4 < line.length; av++) {
            const avAge = line.substring(vPos, vPos + 2).trim();
            const avSex = line[vPos + 2] || '';
            const avRace = line[vPos + 3] || '';
            const avEth = (vPos + 4 < line.length) ? line[vPos + 4] : '';
            const avParsed = parseAge(avAge);
            // Skip blank/padding entries (age=00 sex=0 means no data)
            if (avAge && avAge !== '00' && avSex && avSex !== '0' && avSex !== ' ') {
              insertVictim.run(incidentId, av + 2, avParsed.age, avParsed.ageNum,
                SEX_CODES[avSex] || 'Unknown',
                RACE_CODES[avRace] || 'Unknown',
                ETHNICITY_CODES[avEth] || 'Unknown');
              fileVictims++;
            }
            vPos += 5;
          }
        }
        fileVictims++;
        fileRecords++;
      }
    });

    insertMany();
    console.log(`${year}: ${fileRecords.toLocaleString()} incidents, ${fileVictims.toLocaleString()} victims inserted`);
  }

  // Verify totals
  const total = db.prepare('SELECT COUNT(*) as n FROM incidents').get();
  const vtotal = db.prepare('SELECT COUNT(*) as n FROM victims').get();
  console.log(`\nDB totals: ${total.n.toLocaleString()} incidents, ${vtotal.n.toLocaleString()} victims`);

  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();

  // Post-import: rebuild derived tables so prompt/allowlist dependencies persist
  // (shr_agency_identity, shr_agency_alias, state_population — see repo docs/query-audit-2026-06-09-proposals.md)
  console.log('\nRebuilding SHR derived tables...');
  execSync('cd /opt/nibrs/repo && SHR_DB_PATH=/opt/nibrs/shr.db NIBRS_DB_PATH=/opt/nibrs/nibrs.db npx tsx scripts/normalize-shr-agencies.ts --apply', { stdio: 'inherit', timeout: 600000 });
  execSync('cd /opt/nibrs/repo && SHR_DB_PATH=/opt/nibrs/shr.db RTCI_DB_PATH=/opt/nibrs/shared/crime_data.db npx tsx scripts/build-shr-state-population.ts --apply', { stdio: 'inherit', timeout: 600000 });
  // build-shr-state-population drops/rebuilds from historical data (ends ~currentYear-2);
  // extend with FBI CDE API figures so current-year rate queries keep working (F26)
  execSync('cd /opt/nibrs/repo && npx tsx scripts/extend-state-population-cde.ts --db=/opt/nibrs/shr.db --apply', { stdio: 'inherit', timeout: 600000 });
  // Refresh query-planner statistics — rebuilt tables lose their sqlite_stat1
  // rows and a statistics-less DB makes SQLite pick bad plans (2026-07-03
  // diagnosis: 34s vs 0.1s on nibrs.db). Sampled ANALYZE costs <1s.
  console.log('Refreshing query-planner statistics (ANALYZE)...');
  execSync('sqlite3 /opt/nibrs/shr.db "PRAGMA analysis_limit=1000; ANALYZE;"', { stdio: 'inherit', timeout: 120000 });
  console.log('Derived tables rebuilt.');

  console.log('\nUpdate complete!');
}

main().catch(e => { console.error(e); process.exit(1); });
