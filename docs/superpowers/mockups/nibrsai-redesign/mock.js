// Mockup charts in Crime Index's Timeline style (ECharts there; plain SVG here): no gridlines, y axis line #CCC,
// year labels, a 1.5px line in the explorer color with a gradient area, a crosshair and the dark tooltip.
const fmt = (n) => n.toLocaleString("en-US");
const MONTHS = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const monthName = (ym) => `${MONTHS[Number(ym.slice(5, 7)) - 1]} ${ym.slice(0, 4)}`;

function defs() {
  return `<defs>
    <linearGradient id="tl" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#9C7CCB" stop-opacity=".55"/><stop offset="1" stop-color="#6B3FA0" stop-opacity=".08"/>
    </linearGradient>
    <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="6" height="6" fill="#D9CCEE"/><line x1="0" y1="0" x2="0" y2="6" stroke="#6B3FA0" stroke-width="1.5"/>
    </pattern></defs>`;
}
function yTicks(max) {
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000, 2000, 5000].find((s) => max / s <= 5) ?? 10000;
  const out = []; for (let v = 0; v <= max + step - 1; v += step) out.push(v); return out;
}
function tooltipHtml(title, sub, rows) {
  return `<div class="head"><div class="t">${title}</div><div class="s">${sub}</div></div><div class="body">${rows.map(([l, v]) => `<div class="row"><span class="l">${l}</span><span class="v">${v}</span></div>`).join("")}</div>`;
}

/**
 * rows: [{x: "2022-01" | "2023", y: number|null}]. Drawn at the container's real pixel width (as Crime Index's
 * ECharts timeline is), so labels stay 14px. Returns { highlight(i) } for linking to the table; onHover(i|null) and
 * onPick(row, event) are optional.
 */
function chart(kind, el, rows, series, sub, H = 360, onPick = null, onHover = null) {
  const W = Math.max(320, el.clientWidth || 920), L = 65, R = 8, T = 24, B = 32;
  const vals = rows.map((r) => r.y).filter((v) => v !== null);
  const ticks = yTicks(Math.max(...vals)); const yMax = ticks[ticks.length - 1];
  const y = (v) => T + (1 - v / yMax) * (H - T - B);
  const n = rows.length, slot = (W - L - R) / n, bw = Math.min(slot / 1.5, 64);
  const x = kind === "bar" ? (i) => L + slot * (i + 0.5) : (i) => L + (i / (n - 1)) * (W - L - R);
  let marks = "", xlab = "";
  if (kind === "bar") {
    marks = rows.map((r, i) => r.y === null ? `<text x="${x(i)}" y="${y(0) - 8}" text-anchor="middle" fill="#ABABAB" font-size="12">no total</text>`
      : `<rect class="bar" data-i="${i}" x="${x(i) - bw / 2}" y="${y(r.y)}" width="${bw}" height="${y(0) - y(r.y)}" rx="2"/>`).join("");
    xlab = rows.map((r, i) => `<text x="${x(i)}" y="${H - B + 22}" text-anchor="middle">${r.x}</text>`).join("");
  } else {
    const segs = []; let cur = [];
    rows.forEach((r, i) => { if (r.y === null) { if (cur.length) segs.push(cur); cur = []; } else cur.push([x(i), y(r.y)]); });
    if (cur.length) segs.push(cur);
    marks = segs.map((sg) => `<path class="area" d="M${sg[0][0]},${y(0)} L${sg.map((p) => p.join(",")).join("L")} L${sg[sg.length - 1][0]},${y(0)} Z"/>`).join("")
      + `<path class="series" d="${segs.map((sg) => "M" + sg.map((p) => p.join(",")).join("L")).join(" ")}"/>`;
    const yearIdx = rows.map((r, i) => (r.x.endsWith("-01") ? i : -1)).filter((i) => i >= 0);
    xlab = yearIdx.map((i) => `<line x1="${x(i)}" y1="${H - B}" x2="${x(i)}" y2="${H - B + 8}"/><text x="${x(Math.min(i + 5, n - 1))}" y="${H - B + 22}" text-anchor="middle">${rows[i].x.slice(0, 4)}</text>`).join("");
  }
  el.innerHTML = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${series}">${defs()}
    <g class="axis">${ticks.map((t) => `<text x="${L - 10}" y="${y(t) + 5}" text-anchor="end">${fmt(t)}</text><line x1="${L - 6}" y1="${y(t)}" x2="${L}" y2="${y(t)}"/>`).join("")}
      <line x1="${L}" y1="${T}" x2="${L}" y2="${H - B}"/>${xlab}</g>
    ${marks}<line class="ptr" x1="0" y1="${T}" x2="0" y2="${H - B}"/><circle class="dot" r="5"/>
    <rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg><div class="Tip"></div>`;
  const svg = el.querySelector("svg"), ptr = svg.querySelector(".ptr"), dot = svg.querySelector(".dot"), tip = el.querySelector(".Tip");
  const at = (e) => { const r = svg.getBoundingClientRect(), px = e.clientX - r.left;
    return Math.max(0, Math.min(n - 1, kind === "bar" ? Math.floor((px - L) / slot) : Math.round(((px - L) / (W - L - R)) * (n - 1)))); };
  const highlight = (i, e = null) => {
    if (i === null) { ptr.style.opacity = 0; dot.style.opacity = 0; tip.style.opacity = 0; svg.querySelectorAll(".bar").forEach((b) => b.classList.remove("dim", "on")); return; }
    const r = rows[i];
    if (kind === "bar") svg.querySelectorAll(".bar").forEach((b) => { b.classList.toggle("on", Number(b.dataset.i) === i); b.classList.toggle("dim", Number(b.dataset.i) !== i); });
    else { ptr.setAttribute("x1", x(i)); ptr.setAttribute("x2", x(i)); ptr.style.opacity = 1;
      if (r.y !== null) { dot.setAttribute("cx", x(i)); dot.setAttribute("cy", y(r.y)); dot.style.opacity = 1; } else dot.style.opacity = 0; }
    tip.innerHTML = tooltipHtml(r.x.length === 7 ? monthName(r.x) : r.x, sub, [[series, r.y === null ? "No report" : fmt(r.y)]]);
    const px = x(i); tip.style.left = `${px + 16 + 288 > W ? px - 304 : px + 16}px`; tip.style.top = `${e ? Math.max(0, e.clientY - svg.getBoundingClientRect().top - 20) : T}px`; tip.style.opacity = 1;
  };
  const hit = svg.querySelector(".hit");
  hit.addEventListener("mousemove", (e) => { const i = at(e); highlight(i, e); onHover?.(i); });
  hit.addEventListener("mouseleave", () => { highlight(null); onHover?.(null); });
  if (onPick) { hit.style.cursor = "pointer"; hit.addEventListener("click", (e) => { tip.style.opacity = 0; onPick(rows[at(e)], e, at(e)); }); }
  return { highlight };
}
export const lineChart = (el, rows, series, sub, H, onPick, onHover) => chart("line", el, rows, series, sub, H === undefined || H > 600 ? 360 : H, onPick, onHover);
export const barChart = (el, rows, series, sub, H, onPick, onHover) => chart("bar", el, rows, series, sub, H === undefined || H > 600 ? 360 : H, onPick, onHover);

export function table(el, columns, rows) {
  el.innerHTML = `<table class="T"><thead><tr>${columns.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r, ri) => `<tr data-i="${ri}">${r.map((v, j) => {
    if (v === null) return `<td class="blank"></td>`;
    if (typeof v === "number") return `<td>${Number.isInteger(v) ? fmt(v) : v.toFixed(1)}</td>`;
    return `<td>${j === 0 && /^\d{4}-\d{2}$/.test(v) ? monthName(v) : v}</td>`;
  }).join("")}</tr>`).join("")}</tbody></table>`;
}

// N3 (scripts/fixtures/nibrs-correctness/expected): Baltimore Police Department motor vehicle theft offenses by month.
export const BALTIMORE_MVT = [["2022-01",322],["2022-02",220],["2022-03",227],["2022-04",217],["2022-05",204],["2022-06",279],["2022-07",313],["2022-08",341],["2022-09",327],["2022-10",383],["2022-11",354],["2022-12",370],["2023-01",349],["2023-02",428],["2023-03",543],["2023-04",562],["2023-05",984],["2023-06",1124],["2023-07",1571],["2023-08",1412],["2023-09",1205],["2023-10",1175],["2023-11",659],["2023-12",444],["2024-01",712],["2024-02",664],["2024-03",551],["2024-04",450],["2024-05",447],["2024-06",498],["2024-07",562],["2024-08",440],["2024-09",515],["2024-10",421],["2024-11",366],["2024-12",360],["2025-01",336],["2025-02",338],["2025-03",407],["2025-04",429],["2025-05",395],["2025-06",341],["2025-07",318],["2025-08",403],["2025-09",374],["2025-10",362],["2025-11",361],["2025-12",354],["2026-01",283],["2026-02",257],["2026-03",374],["2026-04",443],["2026-05",428],["2026-06",500]].map(([x, y]) => ({ x, y }));

// The question as editable slots. Click a slot: a searchable dropdown of that slot's vocabulary. Mock: picking an option
// rewrites the slot's words; a real page would run the new question.
export const VOCAB = {
  crime: { ph: "a crime", items: [["Aggravated assault", "victims"], ["Arson", "offenses"], ["Burglary", "offenses"], ["Carjacking", "offenses"], ["Drug possession", "offenses"], ["Fraud", "offenses"], ["Kidnapping", "victims"], ["Larceny", "offenses"], ["Motor vehicle theft", "offenses"], ["Murder", "victims"], ["Rape", "victims"], ["Robbery", "offenses"], ["Shoplifting", "offenses"], ["Simple assault", "victims"], ["Vandalism", "offenses"], ["Weapon law violation", "offenses"]], foot: "NIBRS Group A offenses. Crimes against people count victims; property crimes count offenses." },
  place: { ph: "a place", groups: [["Nation", [["The United States", "sum of reporting agencies"]]], ["States", [["Maryland", "state"], ["Massachusetts", "state"], ["Michigan", "state"]]], ["Cities and agencies", [["Baltimore, Maryland", "pop. 562,811"], ["Baltimore County, Maryland", "county police, pop. 849,486"], ["Baton Rouge, Louisiana", "pop. 221,453"], ["Bakersfield, California", "pop. 413,381"]]]], foot: "23,739 agencies. Type to search." },
  period: { ph: "a period", items: [["2025", "latest complete year"], ["2024", ""], ["2023", ""], ["This year so far", "January through September 2026"], ["The last 12 months", "October 2025 through September 2026"], ["2017 to 2025", "every complete year"], ["A range of months", "pick start and end"]], foot: "The data runs January 2017 through September 2026." },
  by: { ph: "a grouping", items: [["In total", "one number"], ["By month", ""], ["By quarter", ""], ["By year", ""], ["By victim sex", ""], ["By victim race", ""], ["By victim age", ""], ["By offender sex", ""], ["By weapon", ""], ["By location type", ""], ["By relationship to offender", ""], ["By clearance", ""]], foot: "" },
  source: { ph: "a source", items: [["FBI NIBRS", "incidents, 2017 to September 2026"], ["Crime Index monthly", "700 large agencies, 2017 to August 2026"], ["FBI annual (SRS)", "agencies, states, nation, 1960 to 2025"], ["Supplementary Homicide Reports", "each homicide, 1976 to 2024"]], foot: "A typed question picks the source that answers it." },
  stat: { ph: "a statistic", items: [["Count", ""], ["Rate per 100,000", ""], ["Share of the total", "percent"], ["Change from the year before", ""], ["Share cleared", "percent"]], foot: "" },
  filter: { ph: "add a condition", items: [["With a firearm", ""], ["With a knife or cutting instrument", ""], ["By a stranger", ""], ["Female victims", ""], ["Victims under 18", ""], ["Cleared by arrest", ""], ["At a residence", ""]], foot: "" },
};
export function slots(root) {
  let open = null;
  const close = () => { if (open) { open.el.classList.remove("open"); open.drop.remove(); open = null; } };
  document.addEventListener("click", (e) => { if (open && !open.drop.contains(e.target) && e.target !== open.el) close(); });
  root.querySelectorAll("[data-slot]").forEach((el) => el.addEventListener("click", (e) => {
    e.stopPropagation(); if (open && open.el === el) return close(); close();
    const v = VOCAB[el.dataset.slot]; const drop = document.createElement("div"); drop.className = "Drop";
    const rows = (items) => items.map(([n, k]) => `<li data-v="${n}"><span>${n}</span><span class="k">${k}</span></li>`).join("");
    drop.innerHTML = `<input placeholder="Search ${v.ph}"><ul>${v.groups ? v.groups.map(([g, it]) => `<li class="grp">${g}</li>${rows(it)}`).join("") : rows(v.items)}</ul>${v.foot ? `<div class="foot">${v.foot}</div>` : ""}`;
    el.appendChild(drop); el.classList.add("open"); open = { el, drop };
    const input = drop.querySelector("input"); input.focus();
    input.addEventListener("input", () => drop.querySelectorAll("li[data-v]").forEach((li) => (li.style.display = li.dataset.v.toLowerCase().includes(input.value.toLowerCase()) ? "" : "none")));
    drop.querySelectorAll("li[data-v]").forEach((li) => li.addEventListener("click", (ev) => {
      ev.stopPropagation(); const n = li.dataset.v; const cur = el.querySelector(".val") ?? el.firstChild;
      cur.textContent = el.classList.contains("add") ? n : (el.dataset.lower ? n[0].toLowerCase() + n.slice(1) : n);
      el.classList.remove("empty"); if (el.classList.contains("add")) { el.classList.remove("add"); el.classList.add("filter"); }
      close();
    }));
    drop.querySelectorAll("input,ul,.foot").forEach((x) => x.addEventListener("click", (ev) => ev.stopPropagation()));
  }));
}
