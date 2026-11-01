"use client";
/**
 * The start page (approved spec 2026-10-31, mockup 20-start.html): the teal band, the ask box, the sources table, example
 * questions and Tips and Disclaimers. In this preview only NIBRS is in the new engine; the other sources are marked
 * "Coming" and their dots are open (recorded, not answered here yet). Every filled dot and every example is a question
 * the engine answered when this page was built (checked against the local preview, 2026-11-01).
 */
import type { ReactNode } from "react";

type SourceId = "current" | "historical" | "nibrs" | "shr" | "hate";
const SOURCES: Record<SourceId, { name: string; color: string }> = {
  current: { name: "Current Trends", color: "#485EC9" },
  historical: { name: "Historical", color: "#BC4704" },
  nibrs: { name: "NIBRS", color: "#6B3FA0" },
  shr: { name: "Homicide Reports", color: "#A87A12" },
  hate: { name: "Hate Crime", color: "#575757" },
};
const LIVE: SourceId[] = ["nibrs"];

const GROUPS: [string, [string, string][]][] = [
  ["Geography", [["nation", "Nation"], ["state", "State"], ["agency", "Agency"]]],
  ["People", [["victim", "Victims"], ["offender", "Offenders"], ["arr", "Arrestees"]]],
  ["Incident detail", [["weapon", "Weapon"], ["rel", "Relationship"], ["loc", "Location"], ["circ", "Circumstances"], ["prop", "Property"], ["bias", "Bias"]]],
  ["Outcomes", [["clr", "Clearances"], ["staff", "Staffing"]]],
];
// Years and details per source (spec; the generated sources file replaces these before launch).
const ROWS: [SourceId, number, number, string, string][] = [
  ["nibrs", 2017, 2026, "Incident, 2017 to Sep 2026", "nation state agency victim offender arr weapon rel loc circ prop clr"],
  ["current", 2017, 2026, "Monthly, 2017 to Aug 2026", "nation state agency clr"],
  ["historical", 1930, 2025, "Annual, 1930 to 2025", "nation state agency clr staff"],
  ["shr", 1976, 2026, "Incident, 1976 to Sep 2026", "nation state agency victim offender weapon rel circ"],
  ["hate", 1991, 2026, "Incident, 1991 to Sep 2026", "nation state agency offender loc bias"],
];
// A NIBRS dot puts one of these in the box; a detail without one (circumstances, property) isn't answered yet.
const STARTER: Record<string, string> = {
  nation: "Carjacking offenses in the United States by year from 2021 to 2025",
  state: "Carjacking offenses in Tennessee by year from 2021 to 2025",
  agency: "Carjacking offenses in Memphis by month in 2024",
  victim: "Aggravated assault victims in Nashville by sex in 2024",
  offender: "Robbery offenders in Houston by age in 2024",
  arr: "Robbery arrestees in Houston by age in 2024",
  weapon: "Robberies in Houston by weapon in 2024",
  rel: "Murder victims in Houston by relationship to the offender in 2024",
  loc: "Robberies in Houston by location type in 2024",
  clr: "Carjacking offenses in Memphis by clearance status in 2024",
};
const EXAMPLES = [
  ["Shoplifting in Memphis by month and clearance status in 2024", "Houston murders by clearance type and year since 2019"],
  ["Aggravated assault victims in Nashville by sex in 2024", "Robberies in Houston by weapon in 2024"],
  ["Carjacking offenses in Tennessee by year from 2021 to 2025", "Murder victims in Houston by relationship to the offender in 2024"],
];
const WIDE: Record<string, string> = { circ: "7.5rem", rel: "6.75rem", offender: "6rem", clr: "6rem" };

export function StartPage({ form, onAsk, onFill }: { form: ReactNode; onAsk: (q: string) => void; onFill: (q: string) => void }) {
  const cols = GROUPS.flatMap(([, c]) => c);
  return (
    <div className="Start">
      <section className="Hero"><div className="HeroInner"><h1>Crime Data Assistant</h1></div></section>
      <div className="AskBand"><div className="AskBandInner">
        <p>Questions about U.S. crime data, answered with a chart, a table and the source.</p>
        {form}
      </div></div>

      <section className="Sec">
        <h2 className="SecTitle">Data sources</h2>
        <p className="SecSub">A dot marks a detail the source records. Click a filled dot to start a question; open dots are not answered here yet.</p>
        <div className="MxScroll">
          <table className="Mx">
            <colgroup><col style={{ width: "13rem" }} />{cols.map(([k]) => <col key={k} style={WIDE[k] ? { width: WIDE[k] } : undefined} />)}</colgroup>
            <thead>
              <tr className="grp"><th className="gap" />{GROUPS.map(([g, c], i) => <th key={g} colSpan={c.length} className={i ? "sep" : ""}>{g}</th>)}</tr>
              <tr><th className="l">Source</th>{GROUPS.map(([, c], i) => c.map(([k, n], j) => <th key={k} className={i && !j ? "sep" : ""}>{n}</th>))}</tr>
            </thead>
            <tbody>
              {ROWS.map(([id, a, b, years, has]) => {
                const { name, color } = SOURCES[id], set = has.split(" "), live = LIVE.includes(id);
                return (
                  <tr key={id}>
                    <td className="src">
                      <b style={{ color }}>{name}</b>
                      <span>{years}{live ? "" : <em>Coming</em>}</span>
                      <div className="tl"><i style={{ background: color, left: `${((a - 1930) / 97) * 100}%`, right: `${100 - ((b + 1 - 1930) / 97) * 100}%` }} /></div>
                    </td>
                    {GROUPS.map(([, c], i) => c.map(([k, n], j) => {
                      const q = live ? STARTER[k] : undefined;
                      return (
                        <td key={k} className={i && !j ? "sep" : ""}>
                          {!set.includes(k) ? <span className="no" />
                            : q ? <button type="button" className="m" style={{ background: color }} title={`Start a question: ${q}`} aria-label={`${name}: ${n}`} onClick={() => onFill(q)} />
                            : <span className="m open" style={{ borderColor: color }} title={`${name} records ${n.toLowerCase()}; not answered here yet`} />}
                        </td>
                      );
                    }))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section className="Sec">
        <h2 className="SecTitle">Example questions</h2>
        <p className="SecSub">Click one to ask it.</p>
        <table className="Q">
          <colgroup><col className="srcCol" /><col /><col /></colgroup>
          <tbody>
            {EXAMPLES.map((pair, i) => (
              <tr key={i}>
                <td style={{ color: SOURCES.nibrs.color }}>{i === 0 ? SOURCES.nibrs.name : ""}</td>
                {pair.map((q) => <td key={q}><button type="button" style={{ color: SOURCES.nibrs.color }} onClick={() => onAsk(q)}>{q}</button></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="Band"><div className="BandInner TwoCol">
        <div><h3>Tips</h3><hr /><dl>
          <dt>Name a crime, a place and a period</dt><dd>"Carjacking in Memphis by month in 2024" gets a better answer than "crime in Tennessee."</dd>
          <dt>Say the years</dt><dd>Say "2019 to 2024" instead of "recently."</dd>
          <dt>Ask a follow-up</dt><dd>"Same for 2023" or "as a bar chart" changes the last answer. A new crime and place starts a new question.</dd>
          <dt>Choose a source</dt><dd>Add "according to NIBRS" to the question. Each answer names its source and offers any other source that answers the same question.</dd>
          <dt>Downloads</dt><dd>PNG downloads the chart; CSV downloads the table.</dd>
        </dl></div>
        <div><h3>Disclaimers</h3><hr /><ul>
          <li>An agency missing from the data may not report; it does not mean zero crime. Months an agency did not report are shown blank, never zero.</li>
          <li>NIBRS participation varied widely by state and year before 2021. An increase may reflect more agencies reporting, not more crime.</li>
          <li>State and national NIBRS figures are sums of the agencies that reported, not estimates for everyone.</li>
          <li>The FBI changed the definition of rape in 2013. Compare rape figures across that change with care.</li>
          <li>Answers come from FBI data and can be wrong. Check important figures against the FBI Crime Data Explorer.</li>
        </ul></div>
      </div></section>
    </div>
  );
}
