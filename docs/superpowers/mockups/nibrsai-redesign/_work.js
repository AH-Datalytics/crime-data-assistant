// The workspace: ask bar, then the rail (the conversation) and the stage (the active answer). Mockup only.
import { app, SOURCES, sourceSelect } from "./_app.js";
import { BALTIMORE_MVT, barChart, lineChart, table } from "./mock.js";

const yearly = () => {
  const y = {}; for (const r of BALTIMORE_MVT) if (r.x < "2026") y[r.x.slice(0, 4)] = (y[r.x.slice(0, 4)] ?? 0) + r.y;
  return Object.entries(y).map(([x, v]) => ({ x, y: v }));
};

// The conversation so far. `q` is the engine's standalone question (P69); `typed` is what the user wrote, shown only
// when it differs. `notes` are the answer's lines that do not restate the table; the source line is always last.
export const EXCHANGES = [
  { src: "nibrs", typed: "Car thefts in Baltimore by month since 2022", q: "Motor vehicle theft offenses in Baltimore, Maryland, by month, January 2022 through June 2026",
    notes: ["\"Car thefts\" read as motor vehicle theft (NIBRS offense 240), completed and attempted.", "Source: FBI NIBRS."] },
  { src: "nibrs", typed: "by year", q: "Motor vehicle theft offenses in Baltimore, Maryland, by year, 2022 to 2025",
    notes: ["Source: FBI NIBRS."] },
];

export function work({ screen, exchanges, active, stage, bar = "" }) {
  app({ screen, footer: false });
  const src = SOURCES[exchanges[active].src];
  document.body.insertAdjacentHTML("beforeend", `
  <div class="Bar"><div class="BarInner">
    <a class="home" href="10-landing.html" title="Start"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 8l6-5 6 5v7H3z"/></svg></a>
    <input placeholder="Ask a new question" value="${bar}">
    ${sourceSelect("Auto")}
    <button class="Btn Btn-dark">Ask</button>
    <button class="Btn Btn-outlined tut" style="height:2.75rem">Tutorial</button>
  </div></div>
  <div class="Work" style="--src:${src.color}">
    <aside class="Rail">
      <div class="RailList">${exchanges.map((e, i) => `
        <div class="Ex ${i === active ? "on" : "past"}" style="--src:${SOURCES[e.src].color}">
          <span class="overline dot">${SOURCES[e.src].name}</span>
          ${e.typed && e.typed !== e.q ? `<p class="typed">You asked: ${e.typed}</p>` : ""}
          <p class="q">${e.q}${e.notes && i === active ? `<a class="edit" href="#">Edit</a>` : ""}</p>
          ${e.wait ? `<div class="wait">${e.wait}</div>` : `<div class="a">${(e.notes ?? []).map((n) => `<p>${n}</p>`).join("")}</div>`}
        </div>`).join("")}
      </div>
      <div class="RailFoot">
        <span class="overline">Follow up</span>
        <div class="in"><input placeholder="Same for Dallas, make it a rate, by year"><button class="Btn Btn-dark" style="background:var(--src)">Ask</button></div>
        <button class="clear">Clear history</button>
      </div>
    </aside>
    <section class="Stage" id="stage">${stage}</section>
  </div>`);
}

/** The answer stage: title, chart and table toggles, downloads, chart beside table, the disclaimer. */
export function answerStage(kind) {
  return `
    <div class="StageHead">
      <div><span class="overline dot">NIBRS</span><h2>${kind === "year" ? "Motor Vehicle Theft Offenses by Year, 2022 to 2025" : "Motor Vehicle Theft Offenses by Month, Jan 2022 - Jun 2026"}</h2><div class="d">Baltimore Police Department</div></div>
      <div class="StageTools"><span class="Toggle"><button class="on">Chart</button><button class="on">Table</button></span>Download <button class="Btn Btn-outlined">Data</button><button class="Btn Btn-outlined">Image</button></div>
    </div>
    <div class="Answer"><div class="AnswerChart"><div class="Chart" id="chart"></div></div><div class="AnswerTable"><div class="TableScroll" id="table"></div></div></div>
    <p class="Disc">Answers are generated from the data by a language model and can be wrong. Check important figures against the FBI Crime Data Explorer.</p>`;
}
export function drawAnswer(kind) {
  if (kind === "year") {
    const rows = yearly();
    barChart(document.getElementById("chart"), rows, "Motor vehicle theft offenses", "Baltimore, Maryland", 620);
    table(document.getElementById("table"), ["Year", "Motor vehicle theft offenses"], rows.map((r) => [r.x, r.y]));
  } else {
    lineChart(document.getElementById("chart"), BALTIMORE_MVT, "Motor vehicle theft offenses", "Baltimore, Maryland", 620);
    table(document.getElementById("table"), ["Month", "Motor vehicle theft offenses"], BALTIMORE_MVT.map((r) => [r.x, r.y]));
  }
}
