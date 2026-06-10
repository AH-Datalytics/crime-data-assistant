import Database from "better-sqlite3";
import path from "node:path";
import {
  agencySearchKey,
  buildShrAgencyIdentity,
  type ShrAgencyIdentityInput,
} from "../lib/shr-agency-normalization";

interface SourceAgencyRow {
  ori: string;
  state: string;
  agency: string | null;
  agency_type: string | null;
  c: number;
  first_year: number;
  last_year: number;
}

interface NibrsAgencyRow {
  city: string | null;
  agency_type: string | null;
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : null;
}

function defaultShrPath(): string {
  return process.env.SHR_DB_PATH || path.join(process.cwd(), "shr.db");
}

function defaultNibrsPath(): string {
  return process.env.NIBRS_DB_PATH || path.join(process.cwd(), "nibrs.db");
}

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(table));
}

function columnExists(db: Database.Database, table: string, column: string): boolean {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((row) => (row as { name: string }).name === column);
}

function openReadonly(file: string): Database.Database | null {
  try {
    return new Database(file, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

function latestNibrsAgency(db: Database.Database | null, ori: string, state: string): NibrsAgencyRow | null {
  if (!db || !tableExists(db, "agencies")) return null;
  try {
    return db.prepare(`
      SELECT city, agency_type
      FROM agencies
      WHERE ori = ? AND state = ?
      ORDER BY year DESC
      LIMIT 1
    `).get(ori, state) as NibrsAgencyRow | undefined || null;
  } catch {
    return null;
  }
}

function createTables(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS shr_agency_alias;
    DROP TABLE IF EXISTS shr_agency_identity;

    CREATE TABLE shr_agency_identity (
      ori TEXT NOT NULL,
      state TEXT NOT NULL,
      canonical_agency TEXT NOT NULL,
      agency_type TEXT NOT NULL,
      search_key TEXT NOT NULL,
      source_agency_names TEXT NOT NULL,
      source_agency_types TEXT NOT NULL,
      nibrs_city TEXT,
      nibrs_agency_type TEXT,
      incident_count INTEGER NOT NULL,
      first_year INTEGER NOT NULL,
      last_year INTEGER NOT NULL,
      PRIMARY KEY (ori, state)
    );

    CREATE TABLE shr_agency_alias (
      alias TEXT NOT NULL,
      alias_key TEXT NOT NULL,
      ori TEXT NOT NULL,
      state TEXT NOT NULL,
      canonical_agency TEXT NOT NULL,
      agency_type TEXT NOT NULL,
      source TEXT NOT NULL,
      PRIMARY KEY (alias_key, ori, state)
    );
  `);
}

function createIndexes(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_shr_agency_identity_state_key
      ON shr_agency_identity(state, search_key);
    CREATE INDEX IF NOT EXISTS idx_shr_agency_alias_state_key
      ON shr_agency_alias(state, alias_key);
    CREATE INDEX IF NOT EXISTS idx_shr_agency_alias_ori_state
      ON shr_agency_alias(ori, state);
  `);
}

function main(): void {
  const apply = process.argv.includes("--apply");
  const shrPath = argValue("--shr") || defaultShrPath();
  const nibrsPath = argValue("--nibrs") || defaultNibrsPath();
  const shr = new Database(shrPath);
  const nibrs = openReadonly(nibrsPath);

  if (!tableExists(shr, "incidents")) {
    throw new Error(`No incidents table found in ${shrPath}`);
  }
  const hasAgencyType = columnExists(shr, "incidents", "agency_type");
  const agencyTypeExpr = hasAgencyType ? "COALESCE(agency_type, '')" : "''";

  const sourceRows = shr.prepare(`
    SELECT
      ori,
      state,
      agency,
      ${agencyTypeExpr} AS agency_type,
      COUNT(*) AS c,
      MIN(year) AS first_year,
      MAX(year) AS last_year
    FROM incidents
    WHERE ori IS NOT NULL AND ori <> '' AND state IS NOT NULL AND state <> ''
    GROUP BY ori, state, agency, ${agencyTypeExpr}
    ORDER BY ori, state, c DESC, last_year DESC
  `).all() as SourceAgencyRow[];

  const grouped = new Map<string, ShrAgencyIdentityInput & {
    sourceNameCounts: Map<string, number>;
    sourceTypeCounts: Map<string, number>;
  }>();

  for (const row of sourceRows) {
    const key = `${row.ori}|${row.state}`;
    let group = grouped.get(key);
    if (!group) {
      const nibrsRow = latestNibrsAgency(nibrs, row.ori, row.state);
      group = {
        ori: row.ori,
        state: row.state,
        sourceNames: [],
        sourceTypes: [],
        nibrsCity: nibrsRow?.city || null,
        nibrsAgencyType: nibrsRow?.agency_type || null,
        incidentCount: 0,
        firstYear: row.first_year,
        lastYear: row.last_year,
        sourceNameCounts: new Map(),
        sourceTypeCounts: new Map(),
      };
      grouped.set(key, group);
    }
    group.incidentCount += row.c;
    group.firstYear = Math.min(group.firstYear, row.first_year);
    group.lastYear = Math.max(group.lastYear, row.last_year);
    if (row.agency) group.sourceNameCounts.set(row.agency, (group.sourceNameCounts.get(row.agency) || 0) + row.c);
    group.sourceTypeCounts.set(row.agency_type || "", (group.sourceTypeCounts.get(row.agency_type || "") || 0) + row.c);
  }

  const identities = [...grouped.values()].map((group) => {
    group.sourceNames = [...group.sourceNameCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    group.sourceTypes = [...group.sourceTypeCounts.entries()].sort((a, b) => b[1] - a[1]).map(([type]) => type);
    return { group, identity: buildShrAgencyIdentity(group) };
  });

  const fillableIdentityKeys = new Set(
    identities
      .filter(({ group, identity }) =>
        identity.agencyType === "County" ||
        group.nibrsAgencyType === "City" ||
        group.nibrsAgencyType === "County" ||
        group.sourceTypes.includes("City") ||
        group.sourceTypes.includes("County")
      )
      .map(({ identity }) => `${identity.ori}|${identity.state}`)
  );
  const blankBefore = hasAgencyType
    ? shr.prepare("SELECT COUNT(*) AS c FROM incidents WHERE agency_type IS NULL OR agency_type = ''").get() as { c: number }
    : { c: sourceRows.reduce((sum, row) => sum + row.c, 0) };
  const fillableBefore = sourceRows.reduce((sum, row) => {
    const key = `${row.ori}|${row.state}`;
    return fillableIdentityKeys.has(key) && !row.agency_type ? sum + row.c : sum;
  }, 0);

  if (apply) {
    shr.transaction(() => {
      if (!hasAgencyType) {
        shr.exec("ALTER TABLE incidents ADD COLUMN agency_type TEXT");
      }
      createTables(shr);
      const insertIdentity = shr.prepare(`
        INSERT INTO shr_agency_identity (
          ori, state, canonical_agency, agency_type, search_key,
          source_agency_names, source_agency_types, nibrs_city, nibrs_agency_type,
          incident_count, first_year, last_year
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertAlias = shr.prepare(`
        INSERT OR IGNORE INTO shr_agency_alias (
          alias, alias_key, ori, state, canonical_agency, agency_type, source
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const { group, identity } of identities) {
        insertIdentity.run(
          identity.ori,
          identity.state,
          identity.canonicalAgency,
          identity.agencyType,
          identity.searchKey,
          JSON.stringify(group.sourceNames),
          JSON.stringify(group.sourceTypes),
          group.nibrsCity || null,
          group.nibrsAgencyType || null,
          group.incidentCount,
          group.firstYear,
          group.lastYear,
        );
        for (const alias of identity.aliases) {
          insertAlias.run(
            alias,
            agencySearchKey(alias),
            identity.ori,
            identity.state,
            identity.canonicalAgency,
            identity.agencyType,
            alias === identity.canonicalAgency ? "canonical" : "source",
          );
        }
      }
      createIndexes(shr);
      shr.exec(`
        UPDATE incidents
        SET agency_type = (
          SELECT agency_type
          FROM shr_agency_identity sai
          WHERE sai.ori = incidents.ori AND sai.state = incidents.state
        )
        WHERE (agency_type IS NULL OR agency_type = '')
          AND EXISTS (
            SELECT 1
            FROM shr_agency_identity sai
            WHERE sai.ori = incidents.ori
              AND sai.state = incidents.state
              AND (
                sai.agency_type = 'County'
                OR sai.nibrs_agency_type IN ('City', 'County')
                OR sai.source_agency_types LIKE '%"City"%'
                OR sai.source_agency_types LIKE '%"County"%'
              )
          )
      `);
    })();
  }

  const blankAfter = columnExists(shr, "incidents", "agency_type")
    ? shr.prepare("SELECT COUNT(*) AS c FROM incidents WHERE agency_type IS NULL OR agency_type = ''").get() as { c: number }
    : blankBefore;
  const aliasCount = apply && tableExists(shr, "shr_agency_alias")
    ? (shr.prepare("SELECT COUNT(*) AS c FROM shr_agency_alias").get() as { c: number }).c
    : identities.reduce((sum, { identity }) => sum + identity.aliases.length, 0);

  console.log(JSON.stringify({
    applied: apply,
    shrPath,
    nibrsPath: nibrs ? nibrsPath : null,
    identities: identities.length,
    aliases: aliasCount,
    blankAgencyTypeBefore: blankBefore.c,
    blankAgencyTypesFillable: fillableBefore,
    blankAgencyTypeAfter: blankAfter.c,
    blankAgencyTypesFilled: Math.max(0, blankBefore.c - blankAfter.c),
    sample: identities.slice(0, 5).map(({ identity }) => ({
      ori: identity.ori,
      state: identity.state,
      canonicalAgency: identity.canonicalAgency,
      agencyType: identity.agencyType,
      aliases: identity.aliases.slice(0, 4),
    })),
  }, null, 2));

  nibrs?.close();
  shr.close();
}

main();
