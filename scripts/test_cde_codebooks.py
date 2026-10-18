"""Every code -> label table in the app and its importers, checked against the FBI Crime Data Explorer's own codebooks
(scripts/fixtures/cde/, see SOURCES.md). Plan: docs/superpowers/plans/2026-10-13-cde-codebook-fixes.md (r2 + Codex
clarifications). Written BEFORE the fixes (preregistered in audit/cde-codebook-fixes-2026-10-13/).

For each table:
  - MEANING: a code we have that CDE has must mean the same thing. Same meaning = equal after normalizing case and
    punctuation; or every significant word of one label is in the other (generic words such as "other", "unknown",
    "victim", "was" are not significant, so "Other" never matches "Structure/ Other residence"); or a listed ALIAS.
  - COMPLETE: every CDE code must be in the table, unless listed in that table's ALLOWED_MISSING with a reason.
Plus three semantic checks on the NIBRS prompt: the intimate-partner and family code sets equal the split used by
summary_domestic_violence (CF family, CS intimate partner; server check 2026-10-13), in both the definitions and the
example SQL. No network, no database. Run: python scripts/test_cde_codebooks.py
"""
import csv
import importlib.util
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FIX = os.path.join(HERE, "fixtures", "cde")
sys.path.insert(0, HERE)
failures = 0
checks = 0


def check(ok, label):
    global failures, checks
    checks += 1
    if not ok:
        failures += 1
        print(f"  FAIL  {label}")
    elif not os.environ.get("QUIET"):
        print(f"  PASS  {label}")


def cde(name, code, label, where=None):
    with open(os.path.join(FIX, name), encoding="utf-8-sig") as fh:
        return {r[code].strip(): r[label].strip() for r in csv.DictReader(fh) if (where is None or where(r))}


def src(rel):
    return open(os.path.join(ROOT, rel), encoding="utf-8").read()


def load(rel, name):
    spec = importlib.util.spec_from_file_location(name, os.path.join(ROOT, rel))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


GENERIC = {"other", "unknown", "victim", "was", "the", "and", "or", "of", "a", "an", "etc", "type", "not", "stated", "new", "used",
           "include", "s", "group"}


def norm(s):
    return re.sub(r"[^a-z0-9]+", " ", (s or "").lower().replace("—", " ").replace("–", " ")).strip()


def sig(s):
    return {w[:-1] if len(w) > 3 and w.endswith("s") else w for w in norm(s).split()} - GENERIC


# Wording that means the same thing but shares no significant word (each entry: code -> our label it accepts).
ALIAS = {
    "nibrs offense": {"11D": ["Forcible Fondling"], "11A": ["Forcible Rape"], "11B": ["Forcible Sodomy"], "40B": ["Assisting/Promoting Prostitution"], "26B": ["Credit Card/ATM Fraud"]},
    "hate crime offense": {"11D": ["Fondling"]},
    "shr circumstance": {"99": ["Unable to Determine"], "26": ["Other Felony"], "70": ["All Suspected Felony"],
                         "30": ["Human Trafficking/Commercial Sex Acts"]},  # amendment 1: CDE spells it "Commersical"
    "shr weapon": {"15": ["Other Gun"], "90": ["Other/Unknown"]},
    "shr relationship": {"SD": ["Stepdaughter"]},  # CDE's own data spells it "Stepdaugther"
    "nibrs race": {"I": ["American Indian"]},
}
# Amendment 3: the drug lists. CDE misspells K ("Hallucingens"); L and X are worded differently with the same meaning.
DRUG_ALIAS = {"K": ["Other Hallucinogens"], "L": ["Amphetamines/Methamphetamine"], "X": ["More Than 3 Drug Types"]}
for _t in ("nibrs prompt drug list", "nibrs prompt drug CASE", "nibrs prompt drug_category list", "nibrs compiler DRUG_LABEL"):
    ALIAS[_t] = DRUG_ALIAS


def same(table, code, ours, theirs):
    if norm(ours) == norm(theirs):
        return True
    if ours in ALIAS.get(table, {}).get(code, []):
        return True
    if set(re.findall(r"\d+", norm(ours))) != set(re.findall(r"\d+", norm(theirs))):
        return False  # amendment 4: different numbers, different meaning ("Over 3 Drug Types" is not "Other Drugs")
    a, b = sig(ours), sig(theirs)
    if not a or not b:
        return False
    return a <= b or b <= a


def audit(table, ours, theirs, allowed_missing=None):
    allowed_missing = allowed_missing or {}
    wrong = [(c, ours[c], theirs[c]) for c in sorted(ours) if c in theirs and not same(table, c, ours[c], theirs[c])]
    missing = [(c, theirs[c]) for c in sorted(theirs) if c not in ours and c not in allowed_missing]
    check(not wrong, f"{table}: every code means what CDE says ({wrong[:4]})")
    check(not missing, f"{table}: every CDE code is present ({missing[:6]})")


def ts_object(text, name):
    m = re.search(r"(?:export\s+)?const\s+" + name + r"\b[^=]*=\s*\{(.*?)\n?\};", text, re.S)
    if not m:
        return None
    return dict(re.findall(r"[\"']?([0-9A-Z*]{1,3})[\"']?\s*:\s*\"([^\"]*)\"", m.group(1)))


def js_object(text, name):
    m = re.search(r"const " + name + r" = \{(.*?)\};", text, re.S)
    return dict(re.findall(r"'([0-9A-Z]+)'\s*:\s*[\"']([^\"']*)[\"']", m.group(1))) if m else None


def prompt_list(text, field):
    line = next((l for l in text.split("\n") if f"{field}:" in l and re.search(r"'[0-9A-Z]{1,3}'=", l)), None)
    if line is None:
        line = next((l for l in text.split("\n") if f"{field} values:" in l), "")
    return dict((k, v.strip()) for k, v in re.findall(r"'([0-9A-Z]{1,3})'=([^,]+?)(?=, '|$|\.$)", line))


OFFENSE = cde("NIBRS_OFFENSE_TYPE.csv", "offense_code", "offense_name")
LOCATION = cde("NIBRS_LOCATION_TYPE.csv", "location_code", "location_name")
PROPERTY = cde("NIBRS_PROP_DESC_TYPE.csv", "prop_desc_code", "prop_desc_name")
WEAPON = cde("NIBRS_WEAPON_TYPE.csv", "weapon_code", "weapon_name")
RELATION = cde("NIBRS_RELATIONSHIP.csv", "relationship_code", "relationship_name")
DRUG = cde("NIBRS_SUSPECTED_DRUG_TYPE.csv", "suspected_drug_code", "suspected_drug_name")
BIAS = cde("NIBRS_BIAS_LIST.csv", "bias_code", "bias_desc")
RACE = cde("REF_RACE.csv", "race_code", "race_desc")
ETH = cde("NIBRS_ETHNICITY.csv", "ethnicity_code", "ethnicity_name")
LOSS = cde("NIBRS_PROP_LOSS_TYPE.csv", "prop_loss_id", "prop_loss_name")
VTYPE = cde("NIBRS_VICTIM_TYPE.csv", "victim_type_code", "victim_type_name")
CLEAR = cde("NIBRS_CLEARED_EXCEPT.csv", "cleared_except_code", "cleared_except_name")
STATE = cde("REF_STATE.csv", "state_code", "state_postal_abbr")  # the postal column: CDE's state_abbr keeps legacy forms (NB, GM)
SHR = json.load(open(os.path.join(FIX, "shr-codebook.json"), encoding="utf-8"))
NOT_SPECIFIED = {"00": "a CDE placeholder for a blank value", "NS": "a CDE placeholder for a blank value", "X": "a CDE placeholder for a blank value"}
LEGACY_RACE = {"C": "Chinese: a pre-2013 legacy CDE code, not in NIBRS submissions", "J": "Japanese: a pre-2013 legacy CDE code", "O": "Other: a pre-2013 legacy CDE code", "AP": "a combined pre-2013 CDE code"}

# ---------------------------------------------------------------- NIBRS: the lookup tables written into nibrs.db
brt = load("scripts/build_reference_tables.py", "brt")
pairs = lambda rows: {str(r[0]).strip(): str(r[1]).strip() for r in rows}
audit("nibrs location (build_reference_tables)", pairs(brt.LOCATION_TYPES), LOCATION, NOT_SPECIFIED)
audit("nibrs property (build_reference_tables)", pairs(brt.PROPERTY_DESCRIPTIONS), PROPERTY)
audit("nibrs weapon (build_reference_tables)", pairs(brt.WEAPON_CODES), WEAPON)
audit("nibrs race (build_reference_tables)", pairs(brt.RACE_CODES), RACE, {**NOT_SPECIFIED, **LEGACY_RACE})
audit("nibrs ethnicity (build_reference_tables)", pairs(brt.ETHNICITY_CODES), ETH, NOT_SPECIFIED)
audit("nibrs exceptional clearance (build_reference_tables)", pairs(brt.CLEARANCE_CODES), {**CLEAR, "N": "Not Cleared"})

# ---------------------------------------------------------------- NIBRS: the app's own label tables
codes_ts = src("lib/nibrs-codes.ts")
audit("nibrs offense", ts_object(codes_ts, "UCR_CODES") or {}, OFFENSE, {c: "offense outside this app's NIBRS summaries" for c in OFFENSE if c in {"101", "103", "360", "521", "522", "526", "620", "23*"}})
audit("nibrs location (nibrs-codes.ts)", ts_object(codes_ts, "LOCATION_TYPES") or {}, LOCATION, NOT_SPECIFIED)
audit("nibrs weapon (nibrs-codes.ts)", ts_object(codes_ts, "WEAPON_TYPES") or {}, WEAPON)
audit("nibrs race", ts_object(codes_ts, "RACE_CODES") or {}, RACE, {**NOT_SPECIFIED, **LEGACY_RACE})
audit("nibrs ethnicity (nibrs-codes.ts)", ts_object(codes_ts, "ETHNICITY_CODES") or {}, ETH, NOT_SPECIFIED)
audit("nibrs property loss", ts_object(codes_ts, "PROPERTY_LOSS_TYPES") or {}, LOSS)
audit("nibrs victim type", ts_object(codes_ts, "VICTIM_TYPES") or {}, VTYPE)

# ---------------------------------------------------------------- NIBRS: the prompt
prompt = src("lib/nibrs-claude.ts")
audit("nibrs prompt property list", prompt_list(prompt, "property_description"), PROPERTY)
audit("nibrs prompt relationship list", prompt_list(prompt, "relationship_code"), RELATION)
INTIMATE = {"SE", "CS", "BG", "XS", "XR", "HR"}
FAMILY = {"CH", "PA", "SB", "OF", "SC", "SP", "GP", "GC", "IL", "CF", "BE"}
ip_def = re.search(r"\*\*Intimate partner\*\* = relationship_code IN \(([^)]*)\)", prompt)
fam_def = re.search(r"\*\*Family\*\* = relationship_code IN \(([^)]*)\)", prompt)
sets = lambda m: set(re.findall(r"'([A-Z]{2})'", m.group(1))) if m else set()
check(sets(ip_def) == INTIMATE, f"nibrs prompt: the intimate-partner definition is the summary_domestic_violence split ({sorted(sets(ip_def))})")
check(sets(fam_def) == FAMILY, f"nibrs prompt: the family definition is the summary_domestic_violence split ({sorted(sets(fam_def))})")
ip_case = [set(re.findall(r"'([A-Z]{2})'", m)) for m in re.findall(r"relationship_code IN \(([^)]*)\) THEN 'Intimate Partner'", prompt)]
fam_case = [set(re.findall(r"'([A-Z]{2})'", m)) for m in re.findall(r"relationship_code IN \(([^)]*)\) THEN 'Family'", prompt)]
check(ip_case and all(s == INTIMATE for s in ip_case) and fam_case and all(s == FAMILY for s in fam_case), "nibrs prompt: the example SQL uses the same two sets")
# Amendment 3: the drug codes (the first character of suspected_drug_type / drug_category).
eq_list = lambda line: dict((k, v.strip()) for k, v in re.findall(r"(?:^|, )([A-Z0-9])=([^,]+)", (line or "").strip()))
PROMPT_LINES = prompt.splitlines()
audit("nibrs prompt drug list", eq_list(next((l for l in PROMPT_LINES if l.strip().startswith("A=Crack Cocaine")), "")), DRUG)
cases = re.findall(r"CASE SUBSTR\(suspected_drug_type, ?1, ?1\)(.*?) END", prompt)
check(len(cases) >= 2, f"nibrs prompt drug CASE: the CASE examples are found ({len(cases)})")
for _case in cases:
    audit("nibrs prompt drug CASE", dict(re.findall(r"WHEN '([A-Z0-9])' THEN '([^']*)'", _case)), DRUG)
dc_line = next((l for l in PROMPT_LINES if "- drug_category: same codes" in l), "")
audit("nibrs prompt drug_category list", eq_list(dc_line[dc_line.find("A=Crack"):] if "A=Crack" in dc_line else ""), DRUG)

# ---------------------------------------------------------------- the stack's compiler maps (present only on the stack)
comp_path = os.path.join(ROOT, "lib", "nibrs-question-compiler.ts")
if os.path.exists(comp_path):
    comp = open(comp_path, encoding="utf-8").read()
    audit("nibrs compiler RELATIONSHIP_LABEL", ts_object(comp, "RELATIONSHIP_LABEL") or {}, RELATION)
    audit("nibrs compiler BIAS_LABEL", ts_object(comp, "BIAS_LABEL") or {}, BIAS)
    audit("nibrs compiler DRUG_LABEL", ts_object(comp, "DRUG_LABEL") or {}, DRUG)

# ---------------------------------------------------------------- Hate Crime importer
hci = load("scripts/import-hate-crime.py", "import_hate_crime")
import hate_crime_bias as hcb  # noqa: E402

audit("hate crime location", dict(hci.LOCATION_CODES), LOCATION, NOT_SPECIFIED)
# Amendment 5: the location values the Hate Crime prompt names are values the re-decoded data holds.
hc_loc_line = next((l for l in src("lib/hc-claude.ts").splitlines() if l.startswith("| location | TEXT |")), "")
hc_named = [v.strip() for v in re.search(r"Common values: (.*?)\.(?: |$)", hc_loc_line).group(1).split(", ")] if "Common values: " in hc_loc_line else []
hc_unknown = [v for v in hc_named if v not in set(LOCATION.values()) | {"Location not confirmed"}]
check(hc_named and not hc_unknown, f"hate crime prompt: every location value named is a CDE location name ({hc_unknown})")

# ---------------------------------------------------------------- Historical prompt (historical national rape fix, prereg 2026-10-13)
# The region codes historical_agency holds in production (audit/cde-codebook-audit-2026-10-13/historical-server-check.txt).
HISTORICAL_REGIONS = {"nst", "mdn", "sth", "wst"}
claude_ts = src("lib/claude.ts")
region_line = next((l for l in claude_ts.splitlines() if l.startswith("- region TEXT")), "")
named_regions = set(re.findall(r"'([a-z]+)'", region_line))
check(named_regions == HISTORICAL_REGIONS, f"historical prompt: the region codes named are the codes the data holds ({sorted(named_regions)})")
division_line = next((l for l in claude_ts.splitlines() if l.startswith("- division TEXT")), "")
check(bool(re.search(r"\bempty\b", division_line, re.I)), f"historical prompt: the division column is described as empty ({division_line[:80]})")
audit("hate crime bias (modern)", dict(hcb.MODERN), {**BIAS, "88": "None", "99": "Unknown"})
audit("hate crime offense", dict(hci.OFFENSE_CODES), OFFENSE, {c: "not a hate crime offense in CDE (hc_flag f)" for c in cde("NIBRS_OFFENSE_TYPE.csv", "offense_code", "hc_flag") if cde("NIBRS_OFFENSE_TYPE.csv", "offense_code", "hc_flag")[c] != "t"})
audit("hate crime state", dict(hci.STATES), STATE, {"99": "CDE 'Other', not used in hate crime files"})
audit("hate crime offender race", dict(hci.RACE_CODES), RACE, {**NOT_SPECIFIED, **LEGACY_RACE})
audit("hate crime offender ethnicity", dict(hci.ETH_CODES), ETH, NOT_SPECIFIED)

# ---------------------------------------------------------------- SHR importer
shr_js = src("scripts/ops/shr-auto-update.js")
audit("shr weapon", js_object(shr_js, "WEAPON_CODES") or {}, SHR["weapon"])
audit("shr relationship", js_object(shr_js, "RELATIONSHIP_CODES") or {}, SHR["relationship"])
audit("shr circumstance", js_object(shr_js, "CIRCUMSTANCE_CODES") or {}, SHR["circumstance"])

print(f"\n{checks - failures}/{checks} passed")
sys.exit(1 if failures else 0)
