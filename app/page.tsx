import { getDb } from "@/lib/db";
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

export default function Home() {
  const { rows, agencyCount, population } = getHeroData();
  return (
    <ChatInterface
      heroData={rows}
      heroAgencyCount={agencyCount}
      heroPopulation={population}
    />
  );
}
