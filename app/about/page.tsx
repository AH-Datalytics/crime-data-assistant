import Link from "next/link";
import CrimeIndexLogo from "@/components/CrimeIndexLogo";

export const metadata = {
  title: "Explainer — Crime Data Assistant | The Crime Index",
};

export default function AboutPage() {
  return (
    <div className="min-h-screen flex flex-col bg-[var(--surface)]">
      <header className="bg-white border-b border-[var(--border)] shrink-0">
        {/* Top row: logo + desktop pills */}
        <div className="px-4 md:px-6 flex items-center justify-between" style={{ height: 56 }}>
          <div className="flex items-center gap-3 md:gap-6 min-w-0">
            <Link href="/" className="flex items-center gap-2 shrink-0 hover:opacity-80">
              <CrimeIndexLogo size={24} />
              <span
                className="text-xs md:text-sm font-medium tracking-widest uppercase text-[var(--foreground)]"
                style={{ letterSpacing: "2.5px" }}
              >
                Crime Index
              </span>
            </Link>
            <div className="h-5 w-px bg-[var(--border)] hidden md:block" />
            <span className="text-xs sm:text-sm text-[var(--foreground)] hidden md:block">
              Crime Data Assistant
            </span>
          </div>

          {/* Desktop tab pills */}
          <div className="hidden md:flex items-center gap-3 shrink-0">
            <div className="flex items-center gap-0 rounded-lg overflow-hidden border border-[var(--border)]">
              <Link
                href="/"
                className="text-sm font-medium px-4 py-1.5 bg-white text-[#666] hover:bg-[#f0f0f0] transition-colors"
              >
                Current Trends
              </Link>
              <Link
                href="/#historical"
                className="text-sm font-medium px-4 py-1.5 border-l border-[var(--border)] bg-white text-[#666] hover:bg-[#f0f0f0] transition-colors"
              >
                Historical Library
              </Link>
              <Link
                href="/#nibrs"
                className="text-sm font-medium px-4 py-1.5 border-l border-[var(--border)] bg-white text-[#666] hover:bg-[#f0f0f0] transition-colors"
              >
                NIBRS Explorer
              </Link>
              <span
                className="text-sm font-medium px-4 py-1.5 border-l border-[var(--border)] text-white flex items-center"
                style={{ backgroundColor: "#333" }}
              >
                Explainer
              </span>
            </div>
          </div>
        </div>

        {/* Mobile tab row */}
        <div className="md:hidden flex border-t border-[var(--border)]">
          <Link href="/" className="flex-1 text-xs font-medium py-2.5 text-center bg-white text-[#666]">
            Current
          </Link>
          <Link href="/#historical" className="flex-1 text-xs font-medium py-2.5 text-center border-l border-[var(--border)] bg-white text-[#666]">
            Historical
          </Link>
          <Link href="/#nibrs" className="flex-1 text-xs font-medium py-2.5 text-center border-l border-[var(--border)] bg-white text-[#666]">
            NIBRS
          </Link>
          <span
            className="flex-1 text-xs font-medium py-2.5 border-l border-[var(--border)] text-white text-center"
            style={{ backgroundColor: "#333" }}
          >
            Explainer
          </span>
        </div>
      </header>

      <main className="flex-1 max-w-3xl mx-auto px-6 py-8 text-sm leading-relaxed text-[var(--foreground)]">
        <h2 className="text-2xl font-bold mb-6">Crime Data Assistant — Explainer</h2>

        <p className="mb-4">
          The Crime Data Assistant is an AI-powered research tool that provides natural language access to three major crime data sources spanning nearly a century of American crime statistics. Ask questions in plain English and get interactive charts, sortable tables, and contextual analysis &mdash; all generated in real time by AI.
        </p>

        <p className="mb-4">
          Under the hood, the tool translates your questions into SQL queries against databases containing <strong>over 1 billion records</strong>. Every query is shown alongside results so you can verify exactly what was asked and how the data was retrieved.
        </p>

        <hr className="my-6 border-[var(--border)]" />

        {/* =============== DATA SOURCES =============== */}
        <h2 className="text-xl font-bold mb-4">Data Sources</h2>

        {/* Current Trends */}
        <h3 className="text-lg font-semibold mb-3">Current Trends (Real-Time Crime Index)</h3>
        <p className="mb-3">
          Monthly Part I UCR crime counts from <strong>~700 law enforcement agencies</strong> across 48 states, covering <strong>2017&ndash;2025</strong>. Data is collected by AH Datalytics from police department open data portals, CompStat reports, and public records requests on a rolling basis.
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            Agencies are selected for consistent, complete monthly reporting &mdash; this is a curated sample, not a census.
          </li>
          <li>
            National figures use a &ldquo;national sample&rdquo; of ~600 agencies reporting all months. This is useful for tracking trends but should not be interpreted as a national total.
          </li>
          <li>
            Rankings and totals reflect only agencies in this dataset. A city not in the rankings may simply not be in the sample.
          </li>
          <li>
            Crime categories follow the traditional UCR Part I structure: murder, rape, robbery, aggravated assault, burglary, larceny-theft, motor vehicle theft, and arson.
          </li>
        </ul>

        {/* Historical Library */}
        <h3 className="text-lg font-semibold mb-3">Historical Library (FBI Uniform Crime Reports)</h3>
        <p className="mb-3">
          Annual crime data from the FBI&apos;s Uniform Crime Reporting program, <strong>1930&ndash;2024</strong>. This is the longest-running standardized crime data collection in the United States.
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            Includes approximately 14,000 agencies plus state and national aggregates.
          </li>
          <li>
            Pre-calculated per-100,000 population rates are available for most agencies and years.
          </li>
          <li>
            Data before 1960 may be incomplete or inconsistent.
          </li>
          <li>
            Historical data is useful for long-term trend analysis but should be interpreted in the context of evolving reporting standards, population shifts, and changes in law enforcement practices.
          </li>
        </ul>

        {/* NIBRS Explorer */}
        <h3 className="text-lg font-semibold mb-3">NIBRS Explorer (National Incident-Based Reporting System)</h3>
        <p className="mb-3">
          The most detailed data source: incident-level records from the FBI&apos;s NIBRS bulk master files, <strong>1991&ndash;2026</strong>. This dataset contains <strong>over 1 billion records</strong> across 35 years of data, including every reported incident, offense, victim, offender, arrestee, and property record submitted by participating agencies.
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            <strong>172 million incidents</strong>, <strong>193 million offenses</strong>, <strong>192 million victims</strong>, <strong>195 million offenders</strong>, <strong>50 million arrestees</strong>, and <strong>198 million property records</strong>.
          </li>
          <li>
            NIBRS captures far more detail than the older Summary Reporting System: victim demographics, offender characteristics, weapon types, location types, property descriptions, injury types, victim-offender relationships, clearance status, and arrest details.
          </li>
          <li>
            Coverage has expanded dramatically over time. In the early 1990s, only a handful of states participated. By 2021, the FBI transitioned fully to NIBRS, and coverage now exceeds 90% of the U.S. population.
          </li>
          <li>
            This is <strong>NIBRS data only</strong>. Agencies that reported through the older Summary Reporting System (SRS) are not included. This means national totals &mdash; especially for years before 2021 &mdash; will be lower than published FBI figures.
          </li>
          <li>
            Pre-built summary tables provide fast access to offense trends, clearance rates, victim counts, victim demographics (weapon, race, sex, age), carjacking incidents, and drug offense breakdowns by type.
          </li>
        </ul>

        <hr className="my-6 border-[var(--border)]" />

        {/* =============== HOW IT WORKS =============== */}
        <h2 className="text-xl font-bold mb-4">How It Works</h2>

        <p className="mb-3">
          When you ask a question, an AI model (Claude by Anthropic) analyzes your query, determines which database to query, and generates SQL to retrieve the answer. The results are then formatted as interactive charts, tables, or narrative analysis depending on the question.
        </p>

        <h3 className="text-lg font-semibold mb-3">Database Architecture</h3>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            <strong>RTCI &amp; Historical data</strong> lives in a dedicated database with monthly crime counts, annual agency-level data, and pre-computed rates.
          </li>
          <li>
            <strong>NIBRS data</strong> lives in a 100+ GB SQLite database with 8 raw tables (agencies, incidents, offenses, property, victims, offenders, arrestees, group B arrests) plus 7 pre-aggregated summary tables for fast lookups.
          </li>
          <li>
            The NIBRS database is indexed on all major query patterns (agency ORI + year, offense codes, incident dates, state + year) to ensure responsive query times even on billion-row tables.
          </li>
          <li>
            All databases are hosted on a dedicated server with 250 GB of attached storage to accommodate the full dataset.
          </li>
        </ul>

        <h3 className="text-lg font-semibold mb-3">Summary Tables</h3>
        <p className="mb-3">
          To keep response times fast on common questions, NIBRS data is pre-aggregated into summary tables:
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            <strong>Offense counts</strong> &mdash; monthly offense counts by city and state, with clearance counts (arrests + exceptional clearances).
          </li>
          <li>
            <strong>Victim counts</strong> &mdash; monthly person-crime victim counts by city and state for crimes against persons (homicide, assault, rape, kidnapping, human trafficking, etc.).
          </li>
          <li>
            <strong>Victim demographics</strong> &mdash; breakdowns by weapon type, race, sex, and age group for person crimes.
          </li>
          <li>
            <strong>Carjacking</strong> &mdash; a derived crime type combining robbery offenses with stolen motor vehicle property records.
          </li>
          <li>
            <strong>Drug offenses</strong> &mdash; drug/narcotic violations and equipment offenses broken down by suspected drug type (cocaine, heroin, marijuana, methamphetamine, fentanyl, etc.).
          </li>
        </ul>

        <hr className="my-6 border-[var(--border)]" />

        {/* =============== NIBRS METHODOLOGY =============== */}
        <h2 className="text-xl font-bold mb-4">NIBRS Counting Methodology</h2>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            <strong>Crimes Against Persons</strong> (murder, assault, rape, kidnapping, etc.) are counted as <strong>one offense per victim</strong>.
          </li>
          <li>
            <strong>Crimes Against Property</strong> (burglary, theft, robbery, arson, etc.) are counted as <strong>one offense per distinct operation</strong>.
          </li>
          <li>
            <strong>Motor vehicle theft</strong> is counted as one offense per stolen vehicle.
          </li>
          <li>
            NIBRS categorizes <strong>Robbery as a property crime</strong>. Traditional UCR/SRS counted it as a violent crime. This means NIBRS &ldquo;violent crime&rdquo; totals may differ from legacy figures.
          </li>
          <li>
            <strong>Clearance</strong> means the incident resulted in an arrest or was cleared by exceptional means (death of offender, prosecution declined, etc.). Clearance rates are derived from arrest records and the exceptional clearance flag on incident records.
          </li>
          <li>
            <strong>Carjacking</strong> is not a standalone NIBRS offense code. It is derived by identifying robbery offenses (UCR code 120) where the associated property record indicates a stolen motor vehicle.
          </li>
        </ul>

        <hr className="my-6 border-[var(--border)]" />

        {/* =============== LIMITATIONS =============== */}
        <h2 className="text-xl font-bold mb-4">Important Limitations</h2>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            <strong>Crime data reflects only offenses reported to and recorded by law enforcement.</strong> Many crimes go unreported. The National Crime Victimization Survey consistently shows that fewer than half of all crimes are reported to police.
          </li>
          <li>
            <strong>Totals will not match published FBI statistics.</strong> The FBI applies additional adjustments, estimations for non-reporting agencies, and population weighting that this tool does not replicate.
          </li>
          <li>
            <strong>Year-over-year NIBRS comparisons require caution.</strong> Because NIBRS participation has grown steadily (especially 2017&ndash;2021), increases in crime counts may reflect more agencies reporting rather than more crime occurring. Always consider the number of reporting agencies when interpreting trends.
          </li>
          <li>
            <strong>City-level queries require care.</strong> Multiple agencies may serve the same city (e.g., city police, county sheriff, transit police, university police). NIBRS data is organized by agency (ORI code), not by city boundary.
          </li>
          <li>
            <strong>Population figures</strong> in the NIBRS agencies table reflect the jurisdiction population reported by each agency to the FBI. These may not match Census estimates and should be treated as approximate.
          </li>
          <li>
            <strong>Cross-agency comparisons</strong> should be interpreted with caution due to differences in reporting practices, staffing levels, departmental policies, and jurisdictional boundaries.
          </li>
          <li>
            <strong>2025&ndash;2026 data is preliminary</strong> and subject to revision as agencies continue to submit and correct records.
          </li>
          <li>
            <strong>Early years (1991&ndash;2000) have limited coverage.</strong> NIBRS was new and few states participated. Data from these years is useful for studying early adopters but should not be generalized nationally.
          </li>
        </ul>

        <h3 className="text-lg font-semibold mb-3">AI-Generated Queries</h3>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            Queries are generated by AI (Claude by Anthropic) that translates natural language into SQL. While extensively tested, the AI may occasionally misinterpret a question or generate an imprecise query. The SQL is always displayed alongside results for transparency.
          </li>
          <li>
            The AI has access to the full database schema and is instructed on NIBRS methodology, but it can make mistakes &mdash; particularly on edge cases involving complex joins, derived crime types, or multi-agency jurisdictions.
          </li>
          <li>
            Always verify critical findings against the{" "}
            <a href="https://cde.ucr.cjis.gov/" target="_blank" rel="noopener noreferrer" className="text-[var(--accent)] underline">
              FBI Crime Data Explorer
            </a>{" "}
            before using results for reporting, research, or policy decisions.
          </li>
        </ul>

        <hr className="my-6 border-[var(--border)]" />

        {/* =============== DATA PIPELINE =============== */}
        <h2 className="text-xl font-bold mb-4">Data Pipeline</h2>
        <p className="mb-3">
          The NIBRS database is built from the FBI&apos;s NIBRS National Master Files &mdash; fixed-width text files published annually by the FBI&apos;s Criminal Justice Information Services (CJIS) Division. Each annual file contains every incident reported to NIBRS that year, with segment types for agency headers, incidents, offenses, property, victims, offenders, and arrestees.
        </p>
        <ul className="list-disc pl-6 space-y-2 mb-6">
          <li>
            Raw master files from 1991 through 2026 are parsed and loaded into SQLite tables.
          </li>
          <li>
            Indexes are built on all major query dimensions (agency, year, date, offense code, state) to support fast analytical queries.
          </li>
          <li>
            Summary tables are pre-computed from the raw data to provide sub-second response times on common trend and comparison queries.
          </li>
          <li>
            The full pipeline (import + index + summarize) processes approximately 750 million lines of raw text into a 100+ GB database.
          </li>
        </ul>

        <hr className="my-6 border-[var(--border)]" />

        <p className="text-[var(--muted)] text-xs">
          Built by{" "}
          <a href="https://ahdatalytics.com" target="_blank" rel="noopener noreferrer" className="underline">
            AH Datalytics
          </a>
          . This tool is not affiliated with or endorsed by the FBI.
        </p>
      </main>
    </div>
  );
}
