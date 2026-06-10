import { normalizeHistoryForTab } from "../lib/chat-history";

let pass = 0;
let fail = 0;

function assert(name: string, condition: boolean, detail = "") {
  if (condition) {
    pass++;
    return;
  }
  fail++;
  console.error(`FAIL: ${name}${detail ? ` - ${detail}` : ""}`);
}

const history = [
  { role: "user", content: "show crime in Pennsylvania", source: "current" },
  { role: "assistant", content: "Current answer\n[SQL: SELECT * FROM agency_monthly]", source: "current" },
  { role: "user", content: "show crime in Pennsylvania", source: "nibrs" },
  { role: "assistant", content: "NIBRS answer\n[SQL: SELECT * FROM summary_state_monthly]", source: "nibrs" },
  { role: "user", content: "legacy untagged follow-up" },
  { role: "assistant", content: "legacy answer" },
  { role: "system", content: "bad role", source: "nibrs" },
  { role: "user", content: "", source: "nibrs" },
];

const nibrs = normalizeHistoryForTab(history, "nibrs");
assert("keeps nibrs user entry", nibrs.some((h) => h.content.includes("show crime in Pennsylvania")));
assert("keeps nibrs assistant SQL", nibrs.some((h) => h.content.includes("summary_state_monthly")));
assert("drops current table leakage", !nibrs.some((h) => h.content.includes("agency_monthly")));
assert("keeps legacy untagged entries", nibrs.some((h) => h.content === "legacy untagged follow-up"));
assert("drops invalid roles and empty content", !nibrs.some((h) => h.content === "bad role"));

const limited = normalizeHistoryForTab(
  Array.from({ length: 10 }, (_, idx) => ({ role: "user", content: `q${idx}`, source: "shr" })),
  "shr",
  3,
);
assert("limits after filtering", limited.length === 3, `length=${limited.length}`);
assert("keeps newest entries", limited[0]?.content === "q7" && limited[2]?.content === "q9");

console.log(`chat-history tests: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
