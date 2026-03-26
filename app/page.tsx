import { getDb } from "@/lib/rtci-db";
import ChatInterface from "@/components/ChatInterface";

function getHeroData() {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `WITH all_months AS (
          SELECT year, month, count, agency_count,
            SUM(count) OVER (ORDER BY year, month ROWS BETWEEN 11 PRECEDING AND CURRENT ROW) as rolling_12
          FROM national_monthly
          WHERE offense = 'Murder'
        )
        SELECT year, month, rolling_12, agency_count
        FROM all_months
        WHERE year >= 2018
        ORDER BY year, month`
      )
      .all() as { year: number; month: number; rolling_12: number; agency_count: number }[];

    // Use agency_count from the most recent completed month
    const lastRow = rows[rows.length - 1];
    const agencyCount = lastRow?.agency_count ?? 0;

    // Get population for the national sample
    const popRow = db
      .prepare(
        `SELECT SUM(p.population) as pop FROM agency_population p
         JOIN agencies a ON a.ori = p.ori AND a.national_sample = 1
         WHERE p.year = 2024`
      )
      .get() as { pop: number | null };

    return { rows, agencyCount, population: popRow?.pop ?? null };
  } catch (e) {
    console.error("Hero data query failed:", e);
    return { rows: [], agencyCount: 0, population: null };
  }
}

function getHistoricalHeroData() {
  try {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT hac.year, ROUND(hac.murder * 100000.0 / hap.population, 1) as murder_rate
         FROM historical_agency_crime hac
         JOIN historical_agency_population hap ON hap.ori = hac.ori AND hap.year = hac.year
         WHERE hac.ori = 'NY0303000'
           AND hac.murder > 0
           AND hap.population > 0
         ORDER BY hac.year`
      )
      .all() as { year: number; murder_rate: number }[];
    return rows;
  } catch (e) {
    console.error("Historical hero data query failed:", e);
    return [];
  }
}

function getHistoricalMaxYear() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT MAX(year) as y FROM historical_agency_crime").get() as { y: number };
    return row?.y ?? 2024;
  } catch {
    return 2024;
  }
}

export default function Home() {
  const { rows, agencyCount, population } = getHeroData();
  const historicalHeroData = getHistoricalHeroData();
  const historicalMaxYear = getHistoricalMaxYear();
  return (
    <ChatInterface
      heroData={rows}
      heroAgencyCount={agencyCount}
      heroPopulation={population}
      historicalHeroData={historicalHeroData}
      historicalMaxYear={historicalMaxYear}
    />
  );
}
