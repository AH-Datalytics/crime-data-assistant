"use client";

import { ReactNode } from "react";
import { enabledSourceIds, type SourceId } from "@/lib/sources";

type TabId = SourceId;

interface GettingStartedProps {
  onSelectTab: (tab: TabId) => void;
  onAsk?: (question: string) => void;
  renderInputBar?: () => ReactNode;
}

const TAB_CARDS: {
  id: TabId;
  title: string;
  color: string;
  lightBg: string;
  borderColor: string;
  icon: string;
  stat: string;
  statLabel: string;
  subtitle: string;
  description: string;
}[] = [
  {
    id: "current",
    title: "Current Trends",
    color: "#475EC7",
    lightBg: "#eef1fb",
    borderColor: "#c5cdf0",
    icon: "M3 12l2-2 3 3 5-6 4 4",
    stat: "500+",
    statLabel: "agencies reporting monthly",
    subtitle: "Monthly \u00b7 2017\u2013present",
    description:
      "Track what\u2019s happening now. Monthly crime counts from hundreds of police departments, updated on a rolling basis.",
  },
  {
    id: "historical",
    title: "Historical Library",
    color: "#8B5E3C",
    lightBg: "#f5f0eb",
    borderColor: "#ddd0c2",
    icon: "M4 14h3v3H4zm5-4h3v7H9zm5-6h3v13h-3z",
    stat: "~100 yrs",
    statLabel: "of annual FBI crime data",
    subtitle: "Annual \u00b7 1930\u20132024",
    description:
      "Annual agency, state, and nationwide data going back decades",
  },
  {
    id: "nibrs",
    title: "NIBRS",
    color: "#2d8659",
    lightBg: "#ecf5f0",
    borderColor: "#b8dcc8",
    icon: "M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3zM13.5 13.5L17 17",
    stat: "1 Billion+",
    statLabel: "incident-level records",
    subtitle: "Incident-level \u00b7 1991\u2013present",
    description:
      "Incident-level detail, 1991 - present",
  },
  {
    id: "shr",
    title: "Homicide Reports",
    color: "#B8860B",
    lightBg: "#fdf8e8",
    borderColor: "#e8d48b",
    icon: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z",
    stat: "890K+",
    statLabel: "homicide victims since 1976",
    subtitle: "Incident-level \u00b7 1976\u2013present",
    description:
      "Victim/offender demographics, weapon, circumstance, and relationship data for every reported homicide.",
  },
  {
    id: "hate_crime",
    title: "Hate Crime",
    color: "#4A4A4A",
    lightBg: "#f2f2f2",
    borderColor: "#d0d0d0",
    icon: "M12 2L2 7v6c0 5.55 4.27 10.74 10 12 5.73-1.26 10-6.45 10-12V7l-10-5z",
    stat: "285K+",
    statLabel: "hate crime incidents since 1991",
    subtitle: "Incident-level \u00b7 1991\u2013present",
    description:
      "FBI hate crime statistics with bias motivation, offender demographics, and agency participation data.",
  },
];

/* ── sample queries per tab ─────────────────────────────────────── */
const SAMPLE_QUERIES: Record<TabId, { q: string; why: string }[]> = {
  current: [
    { q: "How have murders trended nationally since 2020?", why: "Uses the national sample to show a rolling monthly trend." },
    { q: "Compare robbery in Chicago and Houston, 2022 to 2024", why: "Side-by-side city comparison with a chart." },
    { q: "Which big cities in Texas had the highest rate of carjackings in 2025?", why: "Ranking query using population-adjusted rates." },
    { q: "Show me aggravated assault trends in Phoenix over the last 3 years", why: "Single-city monthly time series." },
    { q: "What is the national clearance rate for motor vehicle theft by year?", why: "Uses clearance data to show how often cases are solved." },
  ],
  historical: [
    { q: "What was the murder rate in New York City from 1960 to 2024?", why: "Long-term single-city trend spanning 60+ years." },
    { q: "Compare the national murder rate in the 1990s vs. the 2010s", why: "Decade-level comparison using national aggregates." },
    { q: "Which cities had the most police officers per capita in 2023?", why: "Uses staffing data alongside crime counts." },
    { q: "Show me burglary trends in Los Angeles since 1985", why: "Tracks one crime type over decades for one city." },
    { q: "What were the top 10 cities by robbery rate in 2000?", why: "Historical ranking at a specific point in time." },
  ],
  nibrs: [
    { q: "What percentage of murder victims in Texas were female in 2023?", why: "Uses victim demographics data for a single state and year." },
    { q: "What are the most common weapons used in aggravated assault nationally?", why: "Breaks down weapon types across all NIBRS-reporting agencies." },
    { q: "How many carjackings were reported in California from 2019 to 2024?", why: "Uses the derived carjacking table (robbery + stolen vehicle)." },
    { q: "Show drug offense trends by drug type in Ohio", why: "Queries the drug summary table for suspected drug breakdowns." },
    { q: "What is the clearance rate for rape in Florida by year?", why: "Combines offense counts with arrest/clearance data." },
    { q: "Compare murder offender demographics in Chicago vs. Houston in 2023", why: "Uses offender demographics for a cross-city comparison." },
  ],
  shr: [
    { q: "What percentage of murders involved a firearm by year since 1990?", why: "Long-term weapon trend using SHR's 50-year dataset." },
    { q: "Break down homicide circumstances in Texas in 2023", why: "SHR-specific field showing felony vs argument vs other motives." },
    { q: "What share of homicides are intraracial since 2000?", why: "Cross-tabulates victim and offender race." },
    { q: "Show domestic homicide trends nationally since 1990", why: "Uses relationship_group to isolate family-related killings." },
    { q: "Victim age and sex breakdown for murders in California in 2022", why: "Demographic breakdown using victim table." },
  ],
  hate_crime: [
    { q: "How have reported hate crimes trended since 2015?", why: "National trend using distinct incident counts." },
    { q: "Show anti-Jewish hate crime incidents by year", why: "Filters by bias_desc for a specific bias category." },
    { q: "Which states reported the most hate crimes in 2023?", why: "State-level ranking using summary tables." },
    { q: "Break down hate crimes by bias category in 2023", why: "Uses the bias_category grouping for an overview." },
    { q: "What are the most common offenses in anti-Black hate crimes?", why: "Offense breakdown filtered by specific bias." },
  ],
};

export default function GettingStarted({ onSelectTab, onAsk, renderInputBar }: GettingStartedProps) {
  const enabled = enabledSourceIds();
  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "linear-gradient(180deg, #ffffff 0%, var(--surface) 300px)" }}>
      <div className="max-w-5xl mx-auto px-3 sm:px-4 md:px-8 pt-6 sm:pt-10 md:pt-16 pb-8 sm:pb-12">

        {/* Hero — short copy, input-first */}
        <div className="text-center mb-6 sm:mb-8">
          <h1
            className="text-2xl sm:text-3xl md:text-[42px] font-bold text-[var(--foreground)] mb-3 sm:mb-4 leading-tight"
          >
            Crime Data Assistant
          </h1>
          <p className="text-[13px] sm:text-[15px] text-[var(--muted)] max-w-2xl mx-auto leading-relaxed">
            Ask questions about U.S. crime data across {enabled.size} sources spanning nearly a century. Results are auto-routed to the best database.
          </p>
        </div>

        {/* Input bar — first actionable element */}
        {renderInputBar && (
          <div className="max-w-2xl mx-auto mb-8 sm:mb-10">
            {renderInputBar()}
          </div>
        )}

        {/* Tab cards — single column on mobile, 2 on sm, 5 on lg */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5 sm:gap-3 mb-8 sm:mb-10">
          {TAB_CARDS.filter(c => enabled.has(c.id)).map((card) => (
            <button
              key={card.id}
              onClick={() => onSelectTab(card.id)}
              className="relative text-left rounded-2xl overflow-hidden cursor-pointer group transition-all duration-200 hover:-translate-y-1 hover:shadow-lg flex flex-col"
              style={{
                backgroundColor: card.lightBg,
                border: `1.5px solid ${card.borderColor}`,
              }}
            >
              {/* Colored top accent bar */}
              <div
                className="h-1 sm:h-1.5 w-full"
                style={{ backgroundColor: card.color }}
              />
              <div className="p-3 sm:p-4 flex flex-col flex-1">
                {/* Title row */}
                <div className="mb-1.5 sm:mb-2">
                  <h3 className="text-[13px] sm:text-[14px] font-bold text-[var(--foreground)] leading-tight">
                    {card.title}
                  </h3>
                  <p className="text-[10px] text-[var(--muted)] tracking-wide mt-0.5">
                    {card.subtitle}
                  </p>
                </div>

                {/* Big stat */}
                <div className="mb-1.5 sm:mb-2">
                  <span
                    className={`${card.stat.length > 6 ? "text-[16px] sm:text-[20px]" : "text-[20px] sm:text-[24px]"} font-extrabold leading-none`}
                    style={{ color: card.color }}
                  >
                    {card.stat}
                  </span>
                  <span className="text-[9px] sm:text-[10px] text-[var(--muted)] ml-1">{card.statLabel}</span>
                </div>

                {/* Description — hidden on small mobile, visible sm+ */}
                <p className="hidden sm:block text-[12px] text-[var(--muted)] leading-relaxed mb-3 flex-1">
                  {card.description}
                </p>

                {/* CTA */}
                <div
                  className="inline-flex items-center gap-1 text-[11px] sm:text-[12px] font-semibold transition-all group-hover:gap-2 mt-auto"
                  style={{ color: card.color }}
                >
                  <span className="hidden sm:inline">Explore</span>
                  <span className="sm:hidden">Explore</span>
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 3l5 5-5 5" />
                  </svg>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Clickable example queries */}
        {onAsk && (
          <div className="mb-8 sm:mb-10">
            <h2 className="text-sm font-semibold text-[var(--muted)] mb-3 text-center">Try an example</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {[
                { q: "How have murders trended nationally since 2020?", color: "#475EC7" },
                { q: "What was the murder rate in NYC from 1960 to 2024?", color: "#8B5E3C" },
                { q: "What percentage of murder victims in Texas were female in 2023?", color: "#2d8659" },
                { q: "What share of homicides involved a firearm since 1990?", color: "#B8860B" },
                ...(enabled.has("hate_crime") ? [
                  { q: "Show anti-Jewish hate crime incidents by year", color: "#4A4A4A" },
                  { q: "Which states reported the most hate crimes in 2023?", color: "#4A4A4A" },
                ] : []),
              ].map((ex, i) => (
                <button
                  key={i}
                  onClick={() => onAsk(ex.q)}
                  className="text-left text-[13px] px-3 py-2.5 rounded-lg bg-white border border-[var(--border)] hover:border-[var(--muted)] hover:shadow-sm cursor-pointer transition-all"
                >
                  <span style={{ color: ex.color }}>&ldquo;{ex.q}&rdquo;</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Divider */}
        <div className="flex items-center mb-6 sm:mb-8">
          <div className="flex-1 h-px bg-[var(--border)]" />
          <span className="px-3 text-[11px] text-[var(--muted)] font-medium uppercase tracking-wider">About this tool &amp; the data sources</span>
          <div className="flex-1 h-px bg-[var(--border)]" />
        </div>

        {/* Tutorial content */}
        <div className="space-y-5 sm:space-y-8 animate-[fadeIn_0.3s_ease]">

          {/* What is this — feature card */}
          <section className="bg-white rounded-xl sm:rounded-2xl border border-[var(--border)] p-4 sm:p-6 md:p-8 shadow-sm">
            <h2 className="text-lg sm:text-xl font-bold mb-3 sm:mb-4 text-[var(--foreground)]">What is the Crime Data Assistant?</h2>
            <p className="text-sm text-[var(--muted)] leading-relaxed mb-3">
              An AI-powered research tool that translates plain-English questions into database queries against real FBI and agency-reported crime data. Type a question, get an interactive chart, data table, and explanation.
            </p>
            <p className="text-sm text-[var(--muted)] leading-relaxed">
              I am a bot and may make mistakes. Verify findings with the <a href="https://cde.ucr.cjis.gov/LATEST/webapp/#" target="_blank" rel="noopener noreferrer" className="underline text-[var(--foreground)]">Crime Data Explorer</a>.
            </p>
          </section>

          {/* How to read results */}
          <section className="bg-white rounded-xl sm:rounded-2xl border border-[var(--border)] p-4 sm:p-6 md:p-8 shadow-sm">
            <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-5 text-[var(--foreground)]">How to Read Results</h2>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-5">
              {[
                { num: "1", title: "Explanation", desc: "A plain-English summary of what the data shows, generated by AI with context about limitations.", color: "#475EC7" },
                { num: "2", title: "Chart", desc: "An interactive line, bar, or area chart. Hover over data points for exact values.", color: "#8B5E3C" },
                { num: "3", title: "Data Table", desc: "Sortable raw numbers. Click column headers to sort. Export as CSV.", color: "#2d8659" },
              ].map((item) => (
                <div key={item.num} className="flex gap-3">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-white text-sm font-bold shrink-0"
                    style={{ backgroundColor: item.color }}
                  >
                    {item.num}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)] mb-0.5">{item.title}</p>
                    <p className="text-xs text-[var(--muted)] leading-relaxed">{item.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Five data sources comparison */}
          <section className="bg-white rounded-xl sm:rounded-2xl border border-[var(--border)] p-4 sm:p-6 md:p-8 shadow-sm">
            <h2 className="text-lg sm:text-xl font-bold mb-2 text-[var(--foreground)]">The Data Sources</h2>
            <p className="text-sm text-[var(--muted)] mb-6">
              Each database covers different time periods, detail levels, and collection methods. Your question is automatically routed to the best source.
            </p>
            {(() => {
              const colDefs: { label: string; color: string; id: TabId }[] = [
                { label: "Current Trends", color: "#475EC7", id: "current" },
                { label: "Historical", color: "#8B5E3C", id: "historical" },
                { label: "NIBRS", color: "#2d8659", id: "nibrs" },
                { label: "Homicide", color: "#B8860B", id: "shr" },
                { label: "Hate Crime", color: "#4A4A4A", id: "hate_crime" },
              ];
              const activeCols = colDefs.filter(c => enabled.has(c.id));
              const rowDataFull: Record<TabId, string[]> = {
                current:    ["Agency Data",                    "2017\u2013present", "Monthly",        "Hundreds of agencies",          "Part I UCR (7 offenses)", "Recent trends"],
                historical: ["FBI Uniform Crime Report",       "1930\u20132024",    "Annual",         "10,000+ agencies",              "Part I UCR + staffing",   "Long-term trends"],
                nibrs:      ["FBI NIBRS Master Files",         "1991\u2013present", "Incident-level", "Varies by year",                "52+ NIBRS offenses",      "Deep analysis"],
                shr:        ["FBI Supplementary Homicide Report","1976\u2013present","Incident-level", "Varies by year",                "Homicides only",          "Homicide analysis"],
                hate_crime: ["FBI Hate Crime Statistics",      "1991\u2013present", "Incident-level", "~15,000 agencies (voluntary)",  "Bias-motivated crimes",   "Hate crime / bias trends"],
              };
              const rowLabels = ["Source", "Time Range", "Granularity", "Coverage", "Crime Types", "Best For"];
              return (
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-[13px] border-collapse min-w-[700px]">
                  <thead>
                    <tr>
                      <th className="text-left py-2.5 px-3 font-semibold text-[var(--muted)] text-[11px] uppercase tracking-wider border-b-2 border-[var(--border)]"></th>
                      {activeCols.map(c => (
                        <th key={c.id} className="text-left py-2.5 px-3 font-bold text-[11px] uppercase tracking-wider border-b-2" style={{ color: c.color, borderColor: c.color }}>{c.label}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="text-[var(--muted)]">
                    {rowLabels.map((label, ri) => (
                      <tr key={ri} className="border-b border-[var(--border)]">
                        <td className="py-2.5 px-3 font-semibold text-[var(--foreground)] whitespace-nowrap">{label}</td>
                        {activeCols.map(c => (
                          <td key={c.id} className="py-2.5 px-3">{rowDataFull[c.id][ri]}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              );
            })()}
          </section>

          {/* Detailed source explanations */}
          <section className="bg-white rounded-xl sm:rounded-2xl border border-[var(--border)] p-4 sm:p-6 md:p-8 shadow-sm">
            <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-5 text-[var(--foreground)]">Understanding Each Data Source</h2>

            {/* Current Trends */}
            <div className="mb-6 pb-6 border-b border-[var(--border)]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1 h-5 rounded-full" style={{ backgroundColor: "#475EC7" }} />
                <h3 className="text-base font-bold text-[var(--foreground)]">Current Trends</h3>
              </div>
              <div className="pl-3.5 text-sm text-[var(--muted)] leading-relaxed space-y-2.5">
                <p>Monthly crime data from <strong className="text-[var(--foreground)]">The Crime Index</strong>, a project by AH Datalytics. Covers the 7 traditional Part I UCR crime categories from hundreds of the largest police departments. Fills the gap between the FBI&apos;s delayed annual estimates and real-time trends.</p>
                <p><strong className="text-[var(--foreground)]">Key caveat:</strong> Data may be preliminary and subject to revision. The &ldquo;national sample&rdquo; uses only consistently-reporting agencies.</p>
              </div>
            </div>

            {/* Historical */}
            <div className="mb-6 pb-6 border-b border-[var(--border)]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1 h-5 rounded-full" style={{ backgroundColor: "#8B5E3C" }} />
                <h3 className="text-base font-bold text-[var(--foreground)]">Historical Library (FBI UCR)</h3>
              </div>
              <div className="pl-3.5 text-sm text-[var(--muted)] leading-relaxed space-y-2.5">
                <p>The longest-running crime data collection in the U.S., dating back to 1930. Annual crime counts from 10,000+ agencies.</p>
                <p><strong className="text-[var(--foreground)]">Key caveat:</strong> Not all agencies reported in all years, especially before 1960.</p>
              </div>
            </div>

            {/* NIBRS */}
            <div className="mb-6 pb-6 border-b border-[var(--border)]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1 h-5 rounded-full" style={{ backgroundColor: "#2d8659" }} />
                <h3 className="text-base font-bold text-[var(--foreground)]">NIBRS</h3>
              </div>
              <div className="pl-3.5 text-sm text-[var(--muted)] leading-relaxed space-y-2.5">
                <p>The FBI&apos;s modern, incident-level reporting system. Detailed records for every crime including victims, offenders, weapons, drugs, and property. Coverage is nearly 90% of the U.S. population as of 2021.</p>
                <p><strong className="text-[var(--foreground)]">Key caveat:</strong> Participation varied widely before 2021. Increases may reflect more agencies reporting, not more crime.</p>
              </div>
            </div>

            {/* SHR */}
            <div className="mb-6 pb-6 border-b border-[var(--border)]">
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1 h-5 rounded-full" style={{ backgroundColor: "#B8860B" }} />
                <h3 className="text-base font-bold text-[var(--foreground)]">Homicide Reports (FBI SHR)</h3>
              </div>
              <div className="pl-3.5 text-sm text-[var(--muted)] leading-relaxed space-y-2.5">
                <p>Specialized data on every reported murder and manslaughter since 1976, including victim/offender demographics, weapon, relationship, and circumstance.</p>
                <p><strong className="text-[var(--foreground)]">Key caveat:</strong> Florida did not submit SHR data for most years between 1997\u20132020. ~40% of incidents have no offender data.</p>
              </div>
            </div>

            {/* Hate Crime — only if enabled */}
            {enabled.has("hate_crime") && <div>
              <div className="flex items-center gap-2 mb-3">
                <div className="w-1 h-5 rounded-full" style={{ backgroundColor: "#4A4A4A" }} />
                <h3 className="text-base font-bold text-[var(--foreground)]">Hate Crime (FBI Hate Crime Statistics)</h3>
              </div>
              <div className="pl-3.5 text-sm text-[var(--muted)] leading-relaxed space-y-2.5">
                <p>FBI hate crime statistics from 1991 to present. Each incident includes the bias motivation (race, religion, sexual orientation, disability, gender, gender identity), offense type, location, offender demographics, and victim counts.</p>
                <p><strong className="text-[var(--foreground)]">Key caveats:</strong> Reporting is <strong>voluntary</strong> — zero does not mean zero hate crimes. The BJS estimates actual hate crime victimization is 2\u20134x higher than reported. The number of participating agencies has grown from ~2,700 in 1991 to 15,000+ today, so increases partly reflect expanded reporting. New bias categories (gender identity in 2013, Arab/Hindu/Sikh in 2015) create breaks in trend data.</p>
              </div>
            </div>}
          </section>

          {/* Sample queries */}
          <section className="bg-white rounded-xl sm:rounded-2xl border border-[var(--border)] p-4 sm:p-6 md:p-8 shadow-sm">
            <h2 className="text-lg sm:text-xl font-bold mb-2 text-[var(--foreground)]">Sample Queries</h2>
            <p className="text-sm text-[var(--muted)] mb-5">
              Example questions you can copy and paste.
            </p>

            <div className="space-y-5">
              {(["current", "historical", "nibrs", "shr", "hate_crime"] as TabId[]).filter(id => enabled.has(id)).map((tabId) => {
                const card = TAB_CARDS.find((c) => c.id === tabId)!;
                return (
                  <div key={tabId}>
                    <div
                      className="flex items-center gap-2.5 py-3 px-4 rounded-xl"
                      style={{
                        backgroundColor: card.lightBg,
                        border: `1.5px solid ${card.borderColor}`,
                      }}
                    >
                      <div
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: card.color }}
                      />
                      <span className="text-sm font-semibold text-[var(--foreground)]">
                        {card.title}
                      </span>
                      <span className="text-[11px] text-[var(--muted)]">
                        {SAMPLE_QUERIES[tabId].length} examples
                      </span>
                    </div>
                    <div className="mt-2 space-y-2 pl-2">
                      {SAMPLE_QUERIES[tabId].map((sq, i) => (
                        <div
                          key={i}
                          className={`flex items-start gap-3 py-2.5 px-3 rounded-lg bg-[#fafafa] ${onAsk ? "cursor-pointer hover:bg-[#f5f5f5]" : ""}`}
                          onClick={onAsk ? () => onAsk(sq.q) : undefined}
                        >
                          <span
                            className="text-[11px] font-bold mt-0.5 shrink-0 w-5 h-5 rounded flex items-center justify-center"
                            style={{ backgroundColor: card.lightBg, color: card.color }}
                          >
                            {i + 1}
                          </span>
                          <div>
                            <p className="text-sm font-medium text-[var(--foreground)] mb-0.5">
                              &ldquo;{sq.q}&rdquo;
                            </p>
                            <p className="text-xs text-[var(--muted)]">{sq.why}</p>
                          </div>
                        </div>
                      ))}
                      <button
                        onClick={() => onSelectTab(tabId)}
                        className="text-xs font-semibold mt-1 ml-3 cursor-pointer hover:underline"
                        style={{ color: card.color }}
                      >
                        Try these in {card.title} &rarr;
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Pitfalls */}
          <section className="bg-white rounded-xl sm:rounded-2xl border border-[var(--border)] p-4 sm:p-6 md:p-8 shadow-sm">
            <h2 className="text-lg sm:text-xl font-bold mb-2 text-[var(--foreground)]">Common Pitfalls</h2>
            <p className="text-sm text-[var(--muted)] mb-5">
              Crime data is nuanced. I am a bot and may sometimes make mistakes. Verify findings with official sources.
            </p>

            <ul className="space-y-1.5 pl-3.5">
              {[
                "Data is preliminary and collected directly from police departments \u2014 it has not been validated by the FBI and is subject to revision.",
                "National figures use a fixed \u201cnational sample\u201d of several hundred agencies. This tracks trends but does not represent a national total.",
                "An agency not appearing in the data may simply not be in the sample \u2014 it doesn\u2019t mean they have zero crime.",
                "Reporting is voluntary \u2014 not all agencies reported in all years, especially before 1960.",
                "The FBI changed the definition of rape in 2013. Comparing rape rates across that break requires caution.",
                "NIBRS participation varied wildly by state and year before 2021. Increases may reflect more agencies reporting.",
                "Hate crime reporting is voluntary. Zero does not mean zero hate crimes \u2014 it means the agency didn\u2019t report.",
                "The BJS estimates actual hate crime victimization is 2\u20134x higher than FBI data.",
                "The database has total jurisdiction population only \u2014 not population by race, gender, or age. Per-capita demographic rates cannot be calculated.",
              ].map((p, i) => (
                <li key={i} className="flex items-start gap-2 text-[13px] text-[var(--muted)] leading-relaxed">
                  <span className="text-[var(--border)] mt-1.5 shrink-0">&bull;</span>
                  <span>{p}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* Tips */}
          <section className="bg-white rounded-xl sm:rounded-2xl border border-[var(--border)] p-4 sm:p-6 md:p-8 shadow-sm">
            <h2 className="text-lg sm:text-xl font-bold mb-4 sm:mb-5 text-[var(--foreground)]">Tips for Better Results</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
              {[
                { title: "Be specific", desc: "\u201CMurder rate in Houston 2020\u20132024\u201D beats \u201Ccrime in Texas.\u201D" },
                { title: "Auto-routing works", desc: "Just ask your question \u2014 the system picks the right data source automatically." },
                { title: "Specify a time range", desc: "Say \u201C2019 to 2024\u201D instead of \u201Crecently\u201D for more relevant results." },
                { title: "Ask follow-ups", desc: "The assistant remembers context. Try \u201Cnow show that as a rate per 100K.\u201D" },
              ].map((tip, i) => (
                <div key={i} className="flex items-start gap-3">
                  <div className="w-6 h-6 rounded-md bg-[var(--surface)] border border-[var(--border)] flex items-center justify-center shrink-0">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M3 8l4 4 6-7" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-[var(--foreground)] mb-0.5">{tip.title}</p>
                    <p className="text-xs text-[var(--muted)] leading-relaxed">{tip.desc}</p>
                  </div>
                </div>
              ))}
            </div>
          </section>

          {/* Footer */}
          <p className="text-center text-xs text-[var(--muted)] pt-2">
            Built by{" "}
            <a href="https://ahdatalytics.com" target="_blank" rel="noopener noreferrer" className="underline">
              AH Datalytics
            </a>
            . Data is provided as-is for research purposes. Always verify critical findings against the{" "}
            <a href="https://cde.ucr.cjis.gov/" target="_blank" rel="noopener noreferrer" className="underline">
              FBI Crime Data Explorer
            </a>
            . Not affiliated with or endorsed by the FBI.
          </p>
        </div>
      </div>
    </div>
  );
}
