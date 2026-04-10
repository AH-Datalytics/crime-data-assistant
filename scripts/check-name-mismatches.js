const Database = require("better-sqlite3");

const rtci = new Database("/opt/nibrs/crime_data.db", { readonly: true });
const nibrs = new Database("/opt/nibrs/nibrs.db", { readonly: true });

// RTCI agency names
const rtciAgencies = rtci.prepare("SELECT DISTINCT agency, state FROM agencies").all();

// Historical agency names (city type, active recently)
const histAgencies = rtci.prepare("SELECT DISTINCT agency, state FROM historical_agency WHERE type = 'city' AND end >= '2020-01'").all();

// NIBRS agency names (large, recent)
const nibrsAgencies = nibrs.prepare("SELECT DISTINCT city, state FROM agencies WHERE year = 2024 AND population > 100000").all();

// Check RTCI→NIBRS mismatches
const nibrsSet = new Set(nibrsAgencies.map(a => a.city + "|" + a.state));
console.log("=== RTCI agencies NOT matching NIBRS (by exact name) ===");
for (const a of rtciAgencies) {
  const key = a.agency.toUpperCase() + "|" + a.state;
  if (!nibrsSet.has(key)) {
    const partial = nibrsAgencies.filter(n =>
      n.state === a.state &&
      (n.city.includes(a.agency.toUpperCase()) || a.agency.toUpperCase().includes(n.city))
    );
    if (partial.length > 0) {
      console.log(`  RTCI: "${a.agency}", ${a.state} → NIBRS: ${partial.map(p => `"${p.city}"`).join(", ")}`);
    }
  }
}

// Check RTCI→Historical mismatches
const histSet = new Set(histAgencies.map(a => a.agency.toLowerCase() + "|" + a.state));
console.log("\n=== RTCI agencies NOT matching Historical (by exact name) ===");
for (const a of rtciAgencies) {
  const key = a.agency.toLowerCase() + "|" + a.state.toLowerCase();
  if (!histSet.has(key)) {
    const partial = histAgencies.filter(h =>
      h.state === a.state.toLowerCase() &&
      (h.agency.toLowerCase().includes(a.agency.toLowerCase()) || a.agency.toLowerCase().includes(h.agency.toLowerCase()))
    );
    if (partial.length > 0) {
      console.log(`  RTCI: "${a.agency}", ${a.state} → Historical: ${partial.map(p => `"${p.agency}"`).join(", ")}`);
    }
  }
}

rtci.close();
nibrs.close();
