import { readQuestion } from "../lib/nibrs-shadow/reading";
for (const q of ["Arrests in Denver in 2023 by arrestee ethnicity","Arrests in Denver in 2023 by arrestee race","by ethnicity","Year-over-year percent change in shoplifting in Memphis by month since 2020","can you show me the rate trend, not the incident trend","This is a count. Is it possible to show a rate?"]) {
  const l = readQuestion(q, 2026).ledger as any; console.log(q, "=>", JSON.stringify(l.people), l.parts.filter((p: any) => p.clause === 0 && p.state === "recognized").map((p: any) => `${p.concept}=${p.value}`).join(" | "));
}
