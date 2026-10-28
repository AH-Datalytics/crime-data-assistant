// Writes docs/policy/nibrsai-answer-policy.docx from docs/policy/nibrsai-answer-policy.csv, for the owner's review:
// each open decision as a block with space for the answer, then the decided rules as a table.
//   node scripts/build-answer-policy-docx.js
const fs = require("fs");
const path = require("path");
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle } = require("docx");

const DIR = path.join(__dirname, "..", "docs", "policy");

/** RFC 4180 CSV (quoted fields, doubled quotes, embedded commas). */
function parseCsv(text) {
  const rows = []; let row = []; let f = ""; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { f += '"'; i++; } else if (c === '"') q = false; else f += c; continue; }
    if (c === '"') q = true; else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; } else if (c !== "\r") f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const [, ...rows] = parseCsv(fs.readFileSync(path.join(DIR, "nibrsai-answer-policy.csv"), "utf8").replace(/^﻿/, ""));
const open = rows.filter((r) => r[6] === "Needs Jeff");
const decided = rows.filter((r) => r[6] !== "Needs Jeff");

const FONT = "Calibri";
const p = (text, opts = {}) => new Paragraph({ spacing: { after: 80 }, ...opts, children: [new TextRun({ text, font: FONT, size: 21, ...(opts.run || {}) })] });
const labelled = (label, text) => new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: `${label}: `, bold: true, font: FONT, size: 21 }), new TextRun({ text, font: FONT, size: 21 })] });
const rule = () => new Paragraph({ spacing: { after: 160 }, border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: "BBBBBB", space: 1 } }, children: [] });

const body = [
  new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: "NIBRSAI answer policy", font: FONT })] }),
  p(`Draft for review, 28 October 2026. ${open.length} decisions need you; ${decided.length} are already decided and are listed at the end for reference. The same content is in nibrsai-answer-policy.csv.`),
  p("Each decision says what the app does today, what is proposed, and the exact default or choices a user would see. Write your answer under each one: agree, change it, or a different rule."),
  new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: "Decisions that need you (most consequential first)", font: FONT })] }),
];
for (const [id, situation, today, proposed, choices, why, , tests] of open) {
  body.push(
    new Paragraph({ heading: HeadingLevel.HEADING_2, keepNext: true, children: [new TextRun({ text: `${id}. ${situation}`, font: FONT })] }),
    labelled("Today", today),
    labelled("Proposed", proposed),
    ...(choices && choices !== "Not applicable." ? [labelled("Default or choices", choices)] : []),
    labelled("Why", why),
    labelled("Test cases", tests),
    new Paragraph({ spacing: { before: 60, after: 60 }, children: [new TextRun({ text: "Your decision:", bold: true, font: FONT, size: 21, color: "1F4E79" })] }),
    p(" "),
    rule(),
  );
}

// Decided rules: a compact table. US Letter portrait, 1-inch margins: 9360 DXA wide.
const W = [800, 2900, 3960, 1700];
const cell = (text, w, head = false) => new TableCell({
  width: { size: w, type: WidthType.DXA },
  shading: head ? { type: ShadingType.CLEAR, color: "auto", fill: "E7E6E6" } : undefined,
  margins: { top: 60, bottom: 60, left: 80, right: 80 },
  children: [new Paragraph({ children: [new TextRun({ text, bold: head, font: FONT, size: 18 })] })],
});
body.push(
  new Paragraph({ heading: HeadingLevel.HEADING_1, pageBreakBefore: true, children: [new TextRun({ text: "Already decided (for reference)", font: FONT })] }),
  new Table({
    width: { size: W.reduce((a, b) => a + b, 0), type: WidthType.DXA },
    columnWidths: W,
    rows: [
      new TableRow({ tableHeader: true, children: ["Id", "Situation", "Rule", "Decided"].map((t, i) => cell(t, W[i], true)) }),
      ...decided.map((r) => new TableRow({ cantSplit: true, children: [r[0], r[1], r[3] === "Keep." ? r[2] : r[3], r[6].replace(/^Decided /, "")].map((t, i) => cell(t, W[i])) })),
    ],
  }),
);

const doc = new Document({
  styles: { default: { document: { run: { font: FONT, size: 21 } } } },
  sections: [{ properties: { page: { size: { width: 12240, height: 15840 }, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } }, children: body }],
});
Packer.toBuffer(doc).then((b) => { fs.writeFileSync(path.join(DIR, "nibrsai-answer-policy.docx"), b); console.log(`${open.length} open, ${decided.length} decided`); });
