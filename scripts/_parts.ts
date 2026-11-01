import { readQuestion } from "../lib/nibrs-shadow/reading";
for (const q of process.argv.slice(2)) console.log(q, "=>", readQuestion(q, 2026, "2026-09").ledger.parts.filter((p) => p.clause === 0).map((p) => `${p.concept}/${p.state}=${p.value}`).join(" | "));
