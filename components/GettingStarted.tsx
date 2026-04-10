"use client";

type TabId = "current" | "historical" | "nibrs";

interface GettingStartedProps {
  onSelectTab: (tab: TabId) => void;
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
      "Track what\u2019s happening now. Monthly crime counts from hundreds of police departments, updated on a rolling basis. Recent data is preliminary.",
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
      "Explore nearly 100 years of crime data. The longest-running standardized crime data in the U.S., from more than 10,000 agencies.",
  },
  {
    id: "nibrs",
    title: "NIBRS Explorer",
    color: "#2d8659",
    lightBg: "#ecf5f0",
    borderColor: "#b8dcc8",
    icon: "M9 3a6 6 0 1 0 0 12A6 6 0 0 0 9 3zM13.5 13.5L17 17",
    stat: "1 Billion+",
    statLabel: "incident-level records",
    subtitle: "Incident-level \u00b7 1991\u2013present",
    description:
      "The deepest dive available. Every reported incident with details of offense, victim, offender, weapon, and more. Not all agencies have reported every year to NIBRS.",
  },
];

/* ── sample queries per tab ─────────────────────────────────────── */
const SAMPLE_QUERIES: Record<TabId, { q: string; why: string }[]> = {
  current: [
    { q: "How have murders trended nationally since 2020?", why: "Uses the national sample to show a rolling monthly trend." },
    { q: "Compare robbery in Chicago and Houston, 2022 to 2024", why: "Side-by-side city comparison with a chart." },
    { q: "Which cities had the highest murder rate per 100K in 2024?", why: "Ranking query using population-adjusted rates." },
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
};

export default function GettingStarted({ onSelectTab }: GettingStartedProps) {
  const showTutorial = true;

  return (
    <div className="flex-1 overflow-y-auto" style={{ background: "linear-gradient(180deg, #ffffff 0%, var(--surface) 300px)" }}>
      <div className="max-w-5xl mx-auto px-4 md:px-8 pt-10 md:pt-16 pb-12">

        {/* Hero */}
        <div className="text-center mb-12">
          <h1
            className="text-3xl md:text-[42px] font-bold text-[var(--foreground)] mb-4 leading-tight"
          >
            Ask a question about<br />crime in the United States
          </h1>
          <p className="text-[15px] text-[var(--muted)] max-w-2xl mx-auto leading-relaxed">
            Nearly a century of crime data history. Choose a data source to start or read the guide below.
          </p>
        </div>

        {/* Tab cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5 mb-10">
          {TAB_CARDS.map((card) => (
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
                className="h-1.5 w-full"
                style={{ backgroundColor: card.color }}
              />
              <div className="p-5 pb-5 flex flex-col flex-1">
                {/* Icon + title row */}
                <div className="flex items-center gap-3 mb-3">
                  <div
                    className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0"
                    style={{ backgroundColor: card.color }}
                  >
                    <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d={card.icon} />
                    </svg>
                  </div>
                  <div>
                    <h3 className="text-[15px] font-bold text-[var(--foreground)] leading-tight">
                      {card.title}
                    </h3>
                    <p className="text-[11px] text-[var(--muted)] tracking-wide">
                      {card.subtitle}
                    </p>
                  </div>
                </div>

                {/* Big stat */}
                <div className="mb-3">
                  <span
                    className={`${card.stat.length > 6 ? "text-[22px]" : "text-[28px]"} font-extrabold leading-none`}
                    style={{ color: card.color }}
                  >
                    {card.stat}
                  </span>
                  <span className="text-xs text-[var(--muted)] ml-1.5">{card.statLabel}</span>
                </div>

                {/* Description */}
                <p className="text-[13px] text-[var(--muted)] leading-relaxed mb-4 flex-1">
                  {card.description}
                </p>

                {/* CTA */}
                <div
                  className="inline-flex items-center gap-1.5 text-[13px] font-semibold transition-all group-hover:gap-2.5"
                  style={{ color: card.color }}
                >
                  Start asking questions
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M5 3l5 5-5 5" />
                  </svg>
                </div>
              </div>
            </button>
          ))}
        </div>

        {/* Divider */}
        <div className="flex items-center mb-8">
          <div className="flex-1 h-px bg-[var(--border)]" />
        </div>

        {/* Tutorial content */}
        {showTutorial && (
          <div className="space-y-8 animate-[fadeIn_0.3s_ease]">

            {/* What is this — feature card */}
            <section className="bg-white rounded-2xl border border-[var(--border)] p-6 md:p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-4 text-[var(--foreground)]">What is the Crime Data Assistant?</h2>
              <p className="text-sm text-[var(--muted)] leading-relaxed mb-3">
                The Crime Data Assistant is an AI-powered research tool that lets you ask questions about crime in the United States using plain English. Instead of downloading spreadsheets or navigating government websites, you type a question like <em>&ldquo;How have murders trended in Chicago since 2020?&rdquo;</em> and get back an interactive chart, a data table, and an explanation &mdash; all generated in real time.
              </p>
              <p className="text-sm text-[var(--muted)] leading-relaxed">
                Under the hood, an AI model translates your question into a database query, runs it against real crime data, and formats the results. Always remember &ndash; I am a bot and may make mistakes from time to time. Verify findings with official sources such as the <a href="https://cde.ucr.cjis.gov/LATEST/webapp/#" target="_blank" rel="noopener noreferrer" className="underline text-[var(--foreground)]">Crime Data Explorer</a>.
              </p>
            </section>

            {/* How to read results */}
            <section className="bg-white rounded-2xl border border-[var(--border)] p-6 md:p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-5 text-[var(--foreground)]">How to Read Results</h2>
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

            {/* Three data sources comparison */}
            <section className="bg-white rounded-2xl border border-[var(--border)] p-6 md:p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-2 text-[var(--foreground)]">The Three Data Sources</h2>
              <p className="text-sm text-[var(--muted)] mb-6">
                Each database covers different time periods, detail levels, and collection methods. Choosing the right one depends on your question.
              </p>
              <div className="overflow-x-auto -mx-2">
                <table className="w-full text-[13px] border-collapse min-w-[600px]">
                  <thead>
                    <tr>
                      <th className="text-left py-2.5 px-3 font-semibold text-[var(--muted)] text-[11px] uppercase tracking-wider border-b-2 border-[var(--border)]"></th>
                      <th className="text-left py-2.5 px-3 font-bold text-[11px] uppercase tracking-wider border-b-2" style={{ color: "#475EC7", borderColor: "#475EC7" }}>Current Trends</th>
                      <th className="text-left py-2.5 px-3 font-bold text-[11px] uppercase tracking-wider border-b-2" style={{ color: "#8B5E3C", borderColor: "#8B5E3C" }}>Historical Library</th>
                      <th className="text-left py-2.5 px-3 font-bold text-[11px] uppercase tracking-wider border-b-2" style={{ color: "#2d8659", borderColor: "#2d8659" }}>NIBRS Explorer</th>
                    </tr>
                  </thead>
                  <tbody className="text-[var(--muted)]">
                    {[
                      ["Source", "Agency Data Collected by AH Datalytics", "FBI Uniform Crime Reports", "FBI NIBRS Master Files"],
                      ["Time Range", "2017\u2013present", "1930\u20132024", "1991\u2013present"],
                      ["Granularity", "Monthly", "Annual", "Per-incident"],
                      ["Coverage", "Hundreds of agencies (curated sample)", "10,000+ agencies", "Varies by year but growing (~87% of U.S. pop. by 2024)"],
                      ["Crime Types", "Part I UCR (7 offenses)", "Part I UCR + staffing", "52+ NIBRS offense codes"],
                      ["Detail Level", "Crime counts + clearance rates", "Crime counts + clearance rates + staffing", "Demographics, weapons, drugs, property"],
                      ["Best For", "Recent trends, what\u2019s happening now", "Long-term trends, historical context", "Deep analysis, demographics, specific offenses"],
                    ].map(([label, ...cells], i) => (
                      <tr key={i} className="border-b border-[var(--border)]">
                        <td className="py-2.5 px-3 font-semibold text-[var(--foreground)] whitespace-nowrap">{label}</td>
                        {cells.map((cell, j) => (
                          <td key={j} className="py-2.5 px-3">{cell}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>

            {/* Detailed source explanations */}
            <section className="bg-white rounded-2xl border border-[var(--border)] p-6 md:p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-5 text-[var(--foreground)]">Understanding Each Data Source</h2>

              {/* Current Trends */}
              <div className="mb-6 pb-6 border-b border-[var(--border)]">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1 h-5 rounded-full" style={{ backgroundColor: "#475EC7" }} />
                  <h3 className="text-base font-bold text-[var(--foreground)]">
                    Current Trends
                  </h3>
                </div>
                <div className="pl-3.5 text-sm text-[var(--muted)] leading-relaxed space-y-2.5">
                  <p>
                    This data comes from <strong className="text-[var(--foreground)]">The Crime Index</strong>, a project by AH Datalytics that collects monthly crime data directly from police department websites, the FBI&apos;s Crime Data Explorer, and public records requests. It covers the 7 traditional Part I UCR crime categories: violent crimes (murder, rape, robbery, and aggravated assault) and property crimes (burglary, theft, and motor vehicle theft). Note that some reported data may be preliminary, subject to change, and may not precisely match figures that will eventually be formally reported to the FBI.
                  </p>
                  <p>
                    <strong className="text-[var(--foreground)]">Why it exists:</strong> The FBI publishes annual crime estimates with a delay. This dataset fills the gap by providing near real-time monthly data from hundreds of the largest police departments to establish local, statewide, and national crime trends. It&apos;s the best source for answering &ldquo;what&apos;s happening right now?&rdquo;
                  </p>
                  <p>
                    <strong className="text-[var(--foreground)]">What &ldquo;national sample&rdquo; means:</strong> Several hundred agencies report consistently every month. When you ask for &ldquo;national&rdquo; trends, the assistant uses only this consistent sample so that month-to-month changes reflect actual crime changes, not agencies dropping in and out of the data.
                  </p>
                </div>
              </div>

              {/* Historical */}
              <div className="mb-6 pb-6 border-b border-[var(--border)]">
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1 h-5 rounded-full" style={{ backgroundColor: "#8B5E3C" }} />
                  <h3 className="text-base font-bold text-[var(--foreground)]">
                    Historical Library (FBI Uniform Crime Reports)
                  </h3>
                </div>
                <div className="pl-3.5 text-sm text-[var(--muted)] leading-relaxed space-y-2.5">
                  <p>
                    The Uniform Crime Reporting (UCR) program is the longest-running crime data collection in the U.S., dating back to 1930. The FBI collects annual crime counts from law enforcement agencies nationwide and publishes them as annual reports.
                  </p>
                  <p>
                    <strong className="text-[var(--foreground)]">Why it exists:</strong> This is the gold standard for historical crime analysis. If you want to know how crime has changed over decades &mdash; or compare a city&apos;s crime rate in 1990 vs. 2020 &mdash; this is the dataset to use.
                  </p>
                  <p>
                    <strong className="text-[var(--foreground)]">Key caveat:</strong> The data you see here reflects what agencies submitted to the FBI though not all agencies have reported in all years, especially before 1960. Additionally, not every crime is reported to law enforcement every year.
                  </p>
                </div>
              </div>

              {/* NIBRS */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <div className="w-1 h-5 rounded-full" style={{ backgroundColor: "#2d8659" }} />
                  <h3 className="text-base font-bold text-[var(--foreground)]">
                    NIBRS Explorer (National Incident-Based Reporting System)
                  </h3>
                </div>
                <div className="pl-3.5 text-sm text-[var(--muted)] leading-relaxed space-y-2.5">
                  <p>
                    NIBRS is the FBI&apos;s modern, incident-level crime reporting system. Instead of just reporting annual totals, agencies submit detailed records for every individual crime incident &mdash; including information about victims, offenders, weapons, drugs, property, injuries, and how the case was resolved.
                  </p>
                  <p>
                    <strong className="text-[var(--foreground)]">Why it exists:</strong> The older Summary Reporting System only captured aggregate offense counts. NIBRS captures a fuller story of each incident. This makes it easy to answer questions like &ldquo;how many vehicle burglaries were there in Texas last year?&rdquo; or &ldquo;what percentage of carjacking victims are male?&rdquo;
                  </p>
                  <p>
                    <strong className="text-[var(--foreground)]">Key caveat:</strong> NIBRS participation has grown slowly. In the early 1990s, only a handful of states reported. By 2021, the FBI required all agencies to switch to NIBRS, and coverage is nearly 90% of the U.S. population. When looking at trends over time, always consider whether an increase reflects more crime or simply more agencies reporting. An agency reporting an increase in crimes from one year to the next may have simply started reporting via NIBRS in the middle of a year.
                  </p>
                  <p>
                    <strong className="text-[var(--foreground)]">What it can&apos;t do:</strong> The database has total jurisdiction population but <strong>not</strong> population broken down by race, gender, or age. This means you can calculate per-capita crime rates for a city or state, but you cannot calculate rates like &ldquo;murders per 100K females&rdquo; because the female population isn&apos;t available.
                  </p>
                </div>
              </div>
            </section>

            {/* Sample queries */}
            <section className="bg-white rounded-2xl border border-[var(--border)] p-6 md:p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-2 text-[var(--foreground)]">Sample Queries</h2>
              <p className="text-sm text-[var(--muted)] mb-5">
                Example questions you can copy and paste.
              </p>

              <div className="space-y-5">
                {(["current", "historical", "nibrs"] as TabId[]).map((tabId) => {
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
                            className="flex items-start gap-3 py-2.5 px-3 rounded-lg bg-[#fafafa]"
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
            <section className="bg-white rounded-2xl border border-[var(--border)] p-6 md:p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-2 text-[var(--foreground)]">Common Pitfalls</h2>
              <p className="text-sm text-[var(--muted)] mb-5">
                Crime data is nuanced. Additionally, I am a bot and may sometimes make mistakes. Keep these in mind when interpreting results and always verify findings with official sources if you&apos;re uncertain.
              </p>

              <ul className="space-y-1.5 pl-3.5">
                {[
                  "Data is preliminary and collected directly from police departments \u2014 it has not been validated by the FBI and is subject to revision.",
                  "National figures use a fixed \u201cnational sample\u201d of several hundred agencies. This tracks trends but does not represent a national total.",
                  "An agency not appearing in the data may simply not be in the sample \u2014 it doesn\u2019t mean they have zero crime.",
                  "Crime categories follow the traditional UCR Part I structure (murder, rape, robbery, aggravated assault, burglary, larceny, and motor vehicle theft).",
                  "Reporting is voluntary \u2014 not all agencies reported in all years, especially before 1960.",
                  "The FBI changed the definition of rape in 2013 (from \u201cforcible\u201d to a broader definition). Comparing rape rates across that break requires caution.",
                  "Data reflects only crimes reported to police. Unreported crimes are not captured.",
                  "NIBRS participation varied wildly by state and year, especially before 2021. An increase in crime counts may reflect more agencies reporting, not more crime.",
                  "The database has total jurisdiction population only \u2014 not population by race, gender, or age. Per-capita rates by demographic group cannot be calculated.",
                  "Queries on raw tables (100M+ rows) can be slow. The assistant uses pre-built summary tables when possible, but very specific queries may take longer or time out completely.",
                ].map((p, i) => (
                  <li key={i} className="flex items-start gap-2 text-[13px] text-[var(--muted)] leading-relaxed">
                    <span className="text-[var(--border)] mt-1.5 shrink-0">&bull;</span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </section>

            {/* Tips */}
            <section className="bg-white rounded-2xl border border-[var(--border)] p-6 md:p-8 shadow-sm">
              <h2 className="text-xl font-bold mb-5 text-[var(--foreground)]">Tips for Better Results</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4">
                {[
                  { title: "Be specific", desc: "\u201CMurder rate in Houston 2020\u20132024\u201D beats \u201Ccrime in Texas.\u201D" },
                  { title: "Try different tabs", desc: "Each tab draws from a different database. If one can\u2019t answer your question, another might." },
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
        )}
      </div>
    </div>
  );
}
