"""
Rebuilding the two Historical core tables from their sources, reproducibly.

WHY THIS MODULE EXISTS
----------------------
Both importers that fed `historical_agency_crime` performed the same rewrite: when every
crime measure for an agency-year was zero, all of them were overwritten with NULL and the
row was labelled "non-reporting". Measured against `historical_crime_1930_2024.csv`, that
erased 56,562 agency-years whose source explicitly said zero, and left them indistinguishable
from the 296,229 agency-years whose source was genuinely blank. Metlakatla Tribal reported
zero across every measure in 2024 and Seldovia reported nothing at all; the database said the
same thing about both. Lipscomb, Alabama filed twelve months of 2025 with zero murders and
the database called that missing too.

Nothing downstream can tell a reported zero from a missing value while that rewrite stands,
so it is gone. Blank arrives as NULL, zero arrives as zero, and reporting status is read from
the field that carries it rather than inferred from the totals.

DETERMINISM
-----------
The annual importer this replaces chose among ORIs with an unordered
`SUBSTR(ori, 1, 7) = ? LIMIT 1`. 431 seven-character prefixes match more than one nine-character
ORI, so which agency a year of crime attached to could depend on SQLite's row order, and about
a hundred agencies collapsed into each other silently. Resolution here is exact-mapping first,
then the canonical `+00` form, then a unique prefix, and an ambiguous prefix is reported rather
than guessed. Two source rows that resolve to one agency are excluded and named, never merged.

ORDER
-----
Base sources, then the annual year, then consolidations. That order has a trap in it: Pontiac's
predecessor ORI is still present when the annual year loads, so a prefix match would attach 2025
to the ORI that the consolidation step then deletes, and the year would vanish. The exact mapping
must win first, which is why mappings are validated against the source agency and state before
any of this runs.
"""

import hashlib
import json
import os
import re
import sqlite3


SCHEMA_VERSION = 1
TOOL_VERSION = "historical_core/1"

CRIME_MEASURES = (
    "violent", "murder", "rape", "robbery", "assault",
    "property", "burglary", "theft", "motor_vehicle_theft",
)

#: Columns in historical_crime_1930_2024.csv, in the order CRIME_MEASURES expects.
BASE_MEASURE_COLUMNS = (
    "violent_total", "murder_total", "rape_total", "robbery_total", "assault_total",
    "property_total", "burglary_total", "theft_total", "motor_total",
)

#: The seven counts the annual RETA file supplies. Violent and property are sums of these.
ANNUAL_MEASURE_COLUMNS = (
    "Actual_Murder", "Actual_Rape_Total", "Actual_Robbery_Total", "Actual_Aggravated_Assault",
    "Actual_Burglary_Total", "Actual_Larceny_Total", "Actual_MV_Theft_Total",
)
_ANNUAL_TO_MEASURE = {
    "Actual_Murder": "murder",
    "Actual_Rape_Total": "rape",
    "Actual_Robbery_Total": "robbery",
    "Actual_Aggravated_Assault": "assault",
    "Actual_Burglary_Total": "burglary",
    "Actual_Larceny_Total": "theft",
    "Actual_MV_Theft_Total": "motor_vehicle_theft",
}
#: Everything an agency-year record carries. Population is part of the record, not context:
#: leaving it out of the overlap comparison let Franklin and Broomfield merge while losing 25
#: and 23 differing predecessor populations -- 20,752 against 40,098 for Broomfield in 2002.
RECORD_FIELDS = ("population",) + CRIME_MEASURES

_VIOLENT_PARTS = ("murder", "rape", "robbery", "assault")
_PROPERTY_PARTS = ("burglary", "theft", "motor_vehicle_theft")

AGENCY_COLUMNS = ("ori", "agency", "state", "type", "region", "division", "size",
                  "latitude", "longitude", "start", "end")

#: The nine clearance columns, in the order the table declares them.
CLEARANCE_MEASURES = ("murder", "rape", "robbery", "assault", "burglary", "theft",
                      "motor_vehicle_theft", "violent", "property")
CLEARANCE_COLUMNS = tuple(f"{measure}_clr" for measure in CLEARANCE_MEASURES)

#: Each clearance measure's (offences, cleared) pair in historical_clearance_1960_2024.csv.
CLEARANCE_SOURCE_PAIRS = {
    "murder": ("murder_all_total", "murder_cleared_total"),
    "rape": ("rape_all_total", "rape_cleared_total"),
    "robbery": ("robbery_all_total", "robbery_cleared_total"),
    "assault": ("assault_all_total", "assault_cleared_total"),
    "burglary": ("burglary_all_total", "burglary_cleared_total"),
    "theft": ("theft_all_total", "theft_cleared_total"),
    "motor_vehicle_theft": ("motor_all_total", "motor_cleared_total"),
    "violent": ("violent_all_total", "violent_cleared_total"),
    "property": ("property_all_total", "property_cleared_total"),
}

#: The cleared counterpart of each annual actual-offence column.
_ANNUAL_CLEARED_COLUMNS = {
    "murder": "Cleared_Murder",
    "rape": "Cleared_Rape_Total",
    "robbery": "Cleared_Robbery_Total",
    "assault": "Cleared_Aggravated_Assault",
    "burglary": "Cleared_Burglary_Total",
    "theft": "Cleared_Larceny_Total",
    "motor_vehicle_theft": "Cleared_MV_Theft_Total",
}

STAFFING_MEASURES = ("all_total", "officer_total", "civilian_total")

#: Every ORI-keyed table this pipeline builds, with the fields that make up one record.
#: Consolidation compares all of them: a predecessor whose staffing disagrees with the
#: survivor is no more absorbable than one whose crime disagrees.
RECORD_FIELDS_BY_TABLE = {
    "historical_agency_crime": RECORD_FIELDS,
    "historical_agency_population": ("population",),
    "historical_agency_clearance": CLEARANCE_COLUMNS,
    "historical_staffing": STAFFING_MEASURES,
}

RESOLVED_EXACT = "exact_mapping"
RESOLVED_PADDED = "canonical_padded"
RESOLVED_PREFIX = "unique_prefix"
RESOLVED_NEW = "new_agency"
RESOLVED_NAME = "directory_name_match"
RESOLVED_PADDED_UNVERIFIED = "canonical_padded_name_unconfirmed"

#: The three states the annual file and Historical spell differently. Named one at a time,
#: not a general loosening of the state check: each entry is a spelling the sources
#: themselves show, never a guess about what a code might mean.
#:
#:   NE -> NB  Nebraska. Read as a contradiction it rejected Omaha, Lincoln, Douglas County
#:             and Sarpy County outright. The application already carries this pair in
#:             lib/query-contract.ts.
#:   GU -> GM  Guam. Same, and it rejected the Guam Police Department.
#:   AS -> AM  American Samoa. The annual row is filed under State `AS`, but its own ORI is
#:             `AM00101` and geographies.csv holds exactly one agency in `AM`,
#:             `AM0010100 dept of public safety, p` -- the same department. Both sources
#:             agree on the identity and disagree only on how the territory is abbreviated.
#:
#: Anything not listed here is left alone. A two-letter code the directory does not use is
#: reported as unknown rather than mapped onto whatever looks closest.
STATE_ALIASES = {"NE": "NB", "GU": "GM", "AS": "AM"}

SCOPE_CRIME_TRANSITION = "crime_transition"
SCOPE_IDENTITY_DUPLICATE = "identity_duplicate"

#: Destinations this pipeline must never open. It builds copies, never the real thing.
_FORBIDDEN_BASENAMES = {"crime_data.db", "nibrs.db", "shr.db", "query_log.db", "nibrs_rollups.db"}
_FORBIDDEN_FRAGMENTS = ("/opt/nibrs", "\\opt\\nibrs")


class BuildError(Exception):
    """The build cannot continue truthfully."""


class AmbiguousOri(BuildError):
    """A source ORI matches more than one agency and nothing may choose between them."""


class OriMapping:
    """One hand-authored ORI equivalence, carrying the evidence it will be checked against."""

    __slots__ = ("source", "target", "agency", "state")

    def __init__(self, source, target, agency, state):
        self.source = source.strip()
        self.target = target.strip()
        self.agency = agency.strip()
        self.state = state.strip()

    @classmethod
    def from_dict(cls, raw):
        try:
            return cls(raw["source_ori"], raw["target_ori"], raw["agency"], raw["state"])
        except KeyError as missing:
            raise BuildError(f"ORI mapping is missing {missing}") from None

    def __repr__(self):
        return f"OriMapping({self.source!r} -> {self.target!r}, {self.agency!r}, {self.state!r})"


class Consolidation:
    """One agency identity absorbed into another, with the source evidence for it."""

    __slots__ = ("predecessor", "survivor", "name", "state", "scope", "evidence")

    def __init__(self, predecessor, survivor, name, state, scope, evidence):
        self.predecessor = predecessor
        self.survivor = survivor
        self.name = name
        self.state = state
        self.scope = scope
        self.evidence = evidence

    @classmethod
    def from_dict(cls, raw):
        try:
            entry = cls(raw["predecessor"], raw["survivor"], raw["name"],
                        raw["state"], raw["scope"], raw["evidence"])
        except KeyError as missing:
            raise BuildError(f"consolidation entry is missing {missing}") from None
        if entry.scope not in (SCOPE_CRIME_TRANSITION, SCOPE_IDENTITY_DUPLICATE):
            raise BuildError(f"{entry.predecessor}: unknown consolidation scope {entry.scope!r}")
        if entry.predecessor == entry.survivor:
            raise BuildError(f"{entry.predecessor}: predecessor and survivor are the same agency")
        return entry


# ── source values ────────────────────────────────────────────────────────────────────

_MISSING_TOKENS = {"", "na", "n/a", "null", "none", "nan"}


def parse_measure(raw):
    """Blank stays missing. A number stays a number, including zero.

    This is the whole correction in one function: nothing here inspects the other measures
    on the row, so an agency-year of zeroes cannot be reinterpreted as an absence.
    """
    if raw is None:
        return None
    text = str(raw).strip()
    if text.lower() in _MISSING_TOKENS:
        return None
    try:
        value = float(text)
    except ValueError:
        raise BuildError(f"measure value {raw!r} is neither blank nor a number")
    if value != int(value):
        raise BuildError(f"measure value {raw!r} is not a whole number")
    return int(value)


def normalize_state(code):
    """One spelling for a state, whichever source it came from."""
    upper = (code or "").strip().upper()
    return STATE_ALIASES.get(upper, upper)


def _normalize_name(value):
    return re.sub(r"[^a-z0-9]+", " ", (value or "").strip().lower()).strip()


def _names_compatible(left, right):
    left, right = _normalize_name(left), _normalize_name(right)
    if not left or not right:
        return False
    return left == right or left.startswith(right) or right.startswith(left)


# ── schema ───────────────────────────────────────────────────────────────────────────

def create_core_tables(conn):
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS historical_agency (
            ori       TEXT PRIMARY KEY,
            agency    TEXT,
            state     TEXT,
            type      TEXT,
            region    TEXT,
            division  TEXT,
            size      TEXT,
            latitude  REAL,
            longitude REAL,
            start     TEXT,
            end       TEXT
        );
        CREATE TABLE IF NOT EXISTS historical_agency_crime (
            ori                  TEXT,
            year                 INTEGER,
            population           INTEGER,
            violent              INTEGER,
            murder               INTEGER,
            rape                 INTEGER,
            robbery              INTEGER,
            assault              INTEGER,
            property             INTEGER,
            burglary             INTEGER,
            theft                INTEGER,
            motor_vehicle_theft  INTEGER,
            PRIMARY KEY (ori, year)
        );
        CREATE TABLE IF NOT EXISTS historical_agency_population (
            ori        TEXT,
            year       INTEGER,
            population INTEGER,
            PRIMARY KEY (ori, year)
        );
        CREATE TABLE IF NOT EXISTS historical_agency_clearance (
            ori                    TEXT,
            year                   INTEGER,
            murder_clr             REAL,
            rape_clr               REAL,
            robbery_clr            REAL,
            assault_clr            REAL,
            burglary_clr           REAL,
            theft_clr              REAL,
            motor_vehicle_theft_clr REAL,
            violent_clr            REAL,
            property_clr           REAL,
            PRIMARY KEY (ori, year)
        );
        CREATE TABLE IF NOT EXISTS historical_staffing (
            ori            TEXT,
            year           INTEGER,
            all_total      INTEGER,
            officer_total  INTEGER,
            civilian_total INTEGER,
            PRIMARY KEY (ori, year)
        );
        """
    )


def assert_not_canonical(path):
    """Refuse any destination that could be a real database.

    Checked before anything opens a connection, because sqlite3.connect creates the file it
    was pointed at: a refusal that happens afterwards has already done damage.
    """
    if not path:
        raise BuildError("a destination path is required")
    normalized = str(path).replace("\\", "/").lower()
    if os.path.basename(normalized) in _FORBIDDEN_BASENAMES:
        raise BuildError(f"refusing to open a canonical database: {path}")
    for fragment in _FORBIDDEN_FRAGMENTS:
        if fragment.replace("\\", "/") in normalized:
            raise BuildError(f"refusing to open a production path: {path}")
    return path


def assert_safe_destination(path):
    """As above, and the file must not exist yet.

    The offline build produces evidence, so it always writes somewhere new. Importers that
    legitimately rebuild a copy in place use `assert_not_canonical` instead.
    """
    assert_not_canonical(path)
    if os.path.exists(path):
        raise BuildError(f"destination already exists; choose a new file: {path}")
    return path


def assert_distinct_outputs(inputs, outputs):
    """No output may be one of the inputs. Overwriting a source destroys the evidence."""
    resolve = lambda p: os.path.normcase(os.path.realpath(os.path.abspath(p)))
    claimed = {resolve(p) for p in inputs if p}
    for out in outputs:
        if out and resolve(out) in claimed:
            raise BuildError(f"refusing to write output over an input: {out}")
    seen = set()
    for out in outputs:
        if not out:
            continue
        resolved = resolve(out)
        if resolved in seen:
            raise BuildError(f"two outputs point at the same file: {out}")
        seen.add(resolved)


# ── base era ─────────────────────────────────────────────────────────────────────────

def is_pseudo_directory_row(row):
    """True for a directory row that names a state or the nation rather than an agency.

    `geographies.csv` carries 53 of these -- `us United States` typed `nation`, and 52
    two-letter rows like `ak Alaska` typed `state`. All 53 share the same three marks: an
    identifier that is not nine characters, no state, and a type of `state` or `nation`.
    Requiring all three means a real agency with an odd identifier is not swept up by
    accident, and an unfamiliar short identifier stops the build instead of being assumed
    to be a state.
    """
    ori = (row.get("id") or row.get("ori") or "").strip()
    state = (row.get("state") or "").strip()
    kind = (row.get("type") or "").strip().lower()
    return len(ori) != 9 and not state and kind in ("state", "nation")


def load_agencies(conn, rows):
    """Load the agency directory, keeping agencies and setting the pseudo-rows aside.

    Returns the count written and the identifiers that were withheld, because every other
    table has to withhold the same ones or the five tables stop describing the same world.

    Names arrive exactly as the source spells them. The importer this replaces rewrote
    3,151 county names -- turning `Jefferson` into `Jefferson County` and
    `Baltimore County Police Department` into `Baltimore County` -- so the database held
    names no source ever stated. Whether the application can still find a county by name is
    a question about the application, not a licence to edit the data.
    """
    payload = []
    seen = {}
    pseudo = {}
    for row in rows:
        ori = (row.get("id") or row.get("ori") or "").strip()
        if not ori:
            continue
        if is_pseudo_directory_row(row):
            pseudo[ori] = (row.get("name") or row.get("agency") or "").strip()
            continue
        record = (
            ori,
            (row.get("name") or row.get("agency") or "").strip() or None,
            (row.get("state") or "").strip() or None,
            (row.get("type") or "").strip() or None,
            (row.get("region") or "").strip() or None,
            (row.get("division") or "").strip() or None,
            (row.get("size") or "").strip() or None,
            _optional_float(row.get("latitude")),
            _optional_float(row.get("longitude")),
            (row.get("start") or "").strip() or None,
            (row.get("end") or "").strip() or None,
        )
        if ori in seen and seen[ori] != record:
            raise BuildError(f"agency {ori} appears twice with different details")
        seen[ori] = record
        payload.append(record)
    conn.executemany(
        "INSERT OR REPLACE INTO historical_agency ({}) VALUES ({})".format(
            ", ".join(AGENCY_COLUMNS), ", ".join("?" * len(AGENCY_COLUMNS))
        ),
        sorted(seen.values()),
    )
    return {"written": len(seen), "pseudo_identifiers": pseudo}


def _optional_float(raw):
    if raw is None:
        return None
    text = str(raw).strip()
    if text.lower() in _MISSING_TOKENS:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def assert_known_identifier(ori, pseudo, source):
    """Every identifier is either an agency's or one the directory explained as a pseudo-row.

    A third kind would mean the sources hold something this pipeline has no account of, and
    writing it anyway is how unexplained rows get inherited from one rebuild to the next.
    """
    if ori in pseudo:
        return False
    if len(ori) != 9:
        raise BuildError(
            f"{source}: identifier {ori!r} is not a nine-character ORI and the agency "
            "directory does not list it as a state or national pseudo-row"
        )
    return True


def load_base_crime(conn, rows, pseudo=()):
    """Load the 1930-2024 annual series, preserving zero and blank as they arrive."""
    staged = {}
    read = 0
    skipped_pseudo = 0
    for row in rows:
        ori = (row.get("id") or row.get("ori") or "").strip()
        year_raw = str(row.get("year") or "").strip()
        if not ori or not year_raw:
            continue
        if not assert_known_identifier(ori, pseudo, "historical crime"):
            skipped_pseudo += 1
            continue
        read += 1
        year = int(float(year_raw))
        measures = tuple(parse_measure(row.get(column)) for column in BASE_MEASURE_COLUMNS)
        record = (ori, year, parse_measure(row.get("population"))) + measures
        key = (ori, year)
        if key in staged and staged[key] != record:
            raise BuildError(f"{ori} {year} appears twice with different values")
        staged[key] = record
    conn.executemany(
        "INSERT OR REPLACE INTO historical_agency_crime (ori, year, population, {}) "
        "VALUES ({})".format(", ".join(CRIME_MEASURES), ", ".join("?" * (len(CRIME_MEASURES) + 3))),
        [staged[key] for key in sorted(staged)],
    )
    return {"read": read, "written": len(staged), "duplicates_identical": read - len(staged),
            "pseudo_rows_excluded": skipped_pseudo}


def _load_keyed_table(conn, rows, table, columns, build_record, pseudo, source_label):
    """Load one ORI-and-year keyed table from its source rows.

    Shared by population, clearance and staffing because the three differ only in which
    values they carry: the identifier rules, the duplicate rule and the write are the same,
    and having them the same is what lets the five tables agree about who exists.
    """
    staged = {}
    read = 0
    skipped_pseudo = 0
    for row in rows:
        ori = (row.get("id") or row.get("ori") or "").strip()
        year_raw = str(row.get("year") or "").strip()
        if not ori or not year_raw:
            continue
        if not assert_known_identifier(ori, pseudo, source_label):
            skipped_pseudo += 1
            continue
        read += 1
        year = int(float(year_raw))
        record = (ori, year) + tuple(build_record(row))
        key = (ori, year)
        if key in staged and staged[key] != record:
            raise BuildError(f"{source_label}: {ori} {year} appears twice with different values")
        staged[key] = record
    conn.executemany(
        "INSERT OR REPLACE INTO {} (ori, year, {}) VALUES ({})".format(
            table, ", ".join(columns), ", ".join("?" * (len(columns) + 2))
        ),
        [staged[key] for key in sorted(staged)],
    )
    return {"read": read, "written": len(staged), "duplicates_identical": read - len(staged),
            "pseudo_rows_excluded": skipped_pseudo}


def load_base_population(conn, rows, pseudo=()):
    """Load the agency population series. A population of zero is a stated population."""
    return _load_keyed_table(
        conn, rows, "historical_agency_population", ("population",),
        lambda row: (parse_measure(row.get("population")),),
        pseudo, "historical population",
    )


def clearance_rate(offences, cleared):
    """The share of reported offences that were cleared, as a percentage, or nothing.

    A denominator of zero or nothing means there is no rate to state: an agency that
    reported no burglaries did not fail to clear them. But offences with no clearances is a
    measured outcome -- zero per cent -- and the importer this replaces threw exactly that
    away, blanking every measure on any row where all nine rates came out zero. An agency
    that solved none of what it reported was recorded as having reported nothing.
    """
    if offences is None or cleared is None or offences <= 0:
        return None
    return round(cleared / offences * 100.0, 1)


def load_base_clearance(conn, rows, pseudo=()):
    """Load the 1960-2024 clearance series, computing each rate from its own pair."""
    def record(row):
        return tuple(
            clearance_rate(parse_measure(row.get(offences)), parse_measure(row.get(cleared)))
            for offences, cleared in
            (CLEARANCE_SOURCE_PAIRS[measure] for measure in CLEARANCE_MEASURES)
        )
    return _load_keyed_table(
        conn, rows, "historical_agency_clearance", CLEARANCE_COLUMNS,
        record, pseudo, "historical clearance",
    )


def load_base_staffing(conn, rows, pseudo=()):
    """Load the 1930-2025 staffing series. Zero employees is a count, not a silence."""
    return _load_keyed_table(
        conn, rows, "historical_staffing", STAFFING_MEASURES,
        lambda row: tuple(parse_measure(row.get(column)) for column in STAFFING_MEASURES),
        pseudo, "historical staffing",
    )


# ── identity ─────────────────────────────────────────────────────────────────────────

def build_prefix_index(conn):
    """Seven-character prefix to every agency ORI under it, in a fixed order."""
    index = {}
    for (ori,) in conn.execute("SELECT ori FROM historical_agency ORDER BY ori"):
        index.setdefault(ori[:7], []).append(ori)
    return {prefix: tuple(sorted(oris)) for prefix, oris in index.items()}


def build_prefix_name_index(conn):
    """Seven-character prefix to the (ORI, name, state) triples under it, in a fixed order."""
    index = {}
    for ori, agency, state in conn.execute(
        "SELECT ori, agency, state FROM historical_agency ORDER BY ori"
    ):
        index.setdefault(ori[:7], []).append((ori, agency or "", state or ""))
    return {prefix: tuple(triples) for prefix, triples in index.items()}


def match_by_name(ori7, agency_name, name_index):
    """The one agency under this prefix whose directory name fits the name on the source row.

    The annual file's seven-character ORI is not unique -- a city and a district attorney's
    office can share one -- but each row also carries the agency's name, and the directory
    holds the full nine-character identity for both. Returns None unless exactly one fits, so
    a near-miss never becomes a decision.
    """
    matches = [ori for ori, agency, _ in name_index.get(ori7, ())
               if _names_compatible(agency, agency_name)]
    return matches[0] if len(matches) == 1 else None


def validate_ori_mappings(mappings, conn):
    """Check every hand-authored mapping against the agency directory it claims to point at.

    A mapping is evidence, not instruction: if the target does not exist, sits in a different
    state, or carries an unrelated name, it is reported rather than trusted.
    """
    errors = []
    for mapping in mappings:
        row = conn.execute(
            "SELECT agency, state FROM historical_agency WHERE ori = ?", (mapping.target,)
        ).fetchone()
        if row is None:
            errors.append(f"{mapping.source} -> {mapping.target}: target agency is not in the directory")
            continue
        agency, state = row
        if normalize_state(state) != normalize_state(mapping.state):
            errors.append(
                f"{mapping.source} -> {mapping.target}: mapping says state {mapping.state!r} "
                f"but the directory says {state!r}"
            )
        if not _names_compatible(agency, mapping.agency):
            errors.append(
                f"{mapping.source} -> {mapping.target}: mapping says {mapping.agency!r} "
                f"but the directory says {agency!r}"
            )
    return errors


def resolve_annual_ori(ori7, exact_map, index, agency_name=None, state=None, name_index=None):
    """Resolve a seven-character source ORI to a nine-character agency ORI, or refuse.

    Order matters, and so does what counts as evidence.

    A validated mapping wins outright: someone checked that identity by hand, and it is what
    keeps Pontiac's 2025 year off the predecessor ORI that consolidation later removes.

    Otherwise the row's own state and name decide between the agencies sharing the prefix. The
    canonical `+00` form is only a default, never a licence to contradict the row: Port
    Jefferson was being filed as Bellport Village purely because Bellport holds `NY0511100`,
    while the directory names Port Jefferson under the same prefix. A sibling the row's name
    actually fits beats the padded form.

    Where no sibling fits, the padded form still wins, but as a weaker class the manifest
    counts separately. "FAIRBANKS INTRNL AIRPORT" does not contradict "Fairbanks International
    Airport", it abbreviates it, and refusing that whole class would drop thousands of correct
    rows to protect against a handful of wrong ones.
    """
    ori7 = ori7.strip()
    for mapping in exact_map:
        if mapping.source == ori7:
            # The mapping file is checked against the directory, but that says nothing about
            # this row. A row carrying a mapped ORI under another name or another state is not
            # the agency the mapping is about, and filing it there would be an invention.
            # Normalized on both sides, like every other state comparison in this module.
            # Spelling is not evidence: a mapping that says NE and a row that says NB are
            # the same state, and comparing the raw strings would have called that a
            # contradiction and refused the row.
            row_state = (state or "").strip()
            if len(row_state) == 2 and row_state.isalpha() \
                    and normalize_state(row_state) != normalize_state(mapping.state):
                raise AmbiguousOri(
                    f"{ori7} is mapped to {mapping.target} in {mapping.state}, but this row is "
                    f"filed in {row_state}"
                )
            if agency_name and not _names_compatible(mapping.agency, agency_name):
                raise AmbiguousOri(
                    f"{ori7} is mapped to {mapping.target} as {mapping.agency!r}, but this row "
                    f"is named {agency_name!r}"
                )
            return mapping.target, RESOLVED_EXACT

    candidates = index.get(ori7, ())
    padded = ori7 + "00"
    if not candidates:
        return padded, RESOLVED_NEW

    known = name_index.get(ori7, ()) if name_index else ()
    if not known:
        known = tuple((ori, "", "") for ori in candidates)

    # A state that disagrees is a contradiction, not a near miss: narrow to the agencies the
    # row could actually be, and refuse if that leaves nothing.
    # "98" is how federal agencies are filed, and it is not a state. A code that is not two
    # letters carries no state information, so it cannot contradict anything.
    stated = state.strip() if state else ""
    if len(stated) == 2 and stated.isalpha():
        wanted = normalize_state(stated)
        scoped = [(ori, name) for ori, name, st in known if normalize_state(st) == wanted]
        if not scoped and any((st or "").strip() for _, _, st in known):
            raise AmbiguousOri(
                f"{ori7} ({agency_name}) is filed in {state}, but every agency under that prefix "
                "is in another state: " + ", ".join(f"{ori}:{st}" for ori, _, st in known)
            )
        if not scoped:
            scoped = [(ori, name) for ori, name, _ in known]
    else:
        scoped = [(ori, name) for ori, name, _ in known]

    fitting = [ori for ori, name in scoped if agency_name and _names_compatible(name, agency_name)]
    if fitting:
        if padded in fitting:
            return padded, RESOLVED_PADDED
        if len(fitting) == 1:
            return fitting[0], RESOLVED_NAME
        raise AmbiguousOri(
            f"{ori7} ({agency_name}) fits {len(fitting)} agencies equally well: " + ", ".join(sorted(fitting))
        )

    scoped_oris = [ori for ori, _ in scoped]
    if padded in scoped_oris:
        return padded, RESOLVED_PADDED_UNVERIFIED
    if len(scoped_oris) == 1:
        return scoped_oris[0], RESOLVED_PREFIX
    raise AmbiguousOri(
        f"{ori7} ({agency_name}) matches {len(scoped_oris)} agencies, none of them by name, "
        "and none is the canonical +00 form: " + ", ".join(sorted(scoped_oris))
    )


# ── annual era ───────────────────────────────────────────────────────────────────────

def load_annual(conn, rows, exact_map, year, agency_type_for_new=None):
    """Load one annual RETA year into crime, population and clearance together.

    Reporting status comes from `Months_Reported` and from nothing else. Zero months means the
    measures are missing; one or more months means every supplied value is kept, including a
    year of zeroes. The row is written either way, so an agency-year with nothing to report
    looks the same here as it does in the base era.

    All three tables are written from one pass over one set of resolved identities, rather
    than by three importers each deciding for itself which agency a seven-character ORI meant.
    Population and clearance are on this row already; taking them from anywhere else is how a
    restored agency ends up with crime figures and no population to divide them by.

    Staffing is deliberately absent: `historical_staffing_1930_2025.csv` already covers this
    year, so there is nothing here to add and inventing an annual staffing path would create a
    second writer for a table that has one.
    """
    index = build_prefix_index(conn)
    excluded = {"ambiguous_ori": 0, "ori_collision": 0, "unusable_row": 0}
    ambiguities = []
    by_target = {}
    resolutions = {RESOLVED_EXACT: 0, RESOLVED_PADDED: 0, RESOLVED_PREFIX: 0,
                   RESOLVED_NEW: 0, RESOLVED_NAME: 0,
                   RESOLVED_PADDED_UNVERIFIED: 0}

    name_index = build_prefix_name_index(conn)
    known_states = {normalize_state(s) for (s,) in conn.execute(
        "SELECT DISTINCT state FROM historical_agency WHERE state IS NOT NULL AND TRIM(state) <> ''"
    )}
    unknown_states = {}
    for row in rows:
        ori7 = (row.get("ORI") or "").strip()
        if not ori7:
            excluded["unusable_row"] += 1
            continue
        # A two-letter code the directory has never used is reported, not mapped onto
        # whatever looks closest. Naming it is the point: an alias is a claim about two
        # sources spelling one place differently, and that claim needs evidence.
        stated_code = (row.get("State") or "").strip()
        if len(stated_code) == 2 and stated_code.isalpha() \
                and normalize_state(stated_code) not in known_states:
            unknown_states.setdefault(stated_code.upper(), 0)
            unknown_states[stated_code.upper()] += 1
        # A file that is not the year it was asked for would silently overwrite another year.
        row_year = (str(row.get("Year") or "").strip() or None)
        if row_year is not None and int(float(row_year)) != int(year):
            raise BuildError(
                f"{ori7} carries Year {row_year} but this build was told to load {year}; "
                "the annual file and --annual-year disagree"
            )
        try:
            target, how = resolve_annual_ori(
                ori7, exact_map, index,
                agency_name=(row.get("Agency_Name") or "").strip(),
                state=(row.get("State") or "").strip(),
                name_index=name_index,
            )
        except AmbiguousOri as ambiguous:
            excluded["ambiguous_ori"] += 1
            ambiguities.append(str(ambiguous))
            continue
        by_target.setdefault(target, []).append((ori7, how, row))

    # A seven-character ORI can belong to more than one agency. Where the directory holds
    # them separately, the name on each source row says which is which, so the collision is
    # resolved from evidence rather than by dropping both. Only rows the directory cannot
    # place are set aside. Letting the later row win -- what the reference importer did --
    # replaced Huntsville's 2025 figures with another agency's zeroes.
    for target in [t for t, entries in by_target.items() if len(entries) > 1]:
        stays, moved, unplaceable = [], [], []

        # A validated mapping outranks the name heuristic. Both of Pontiac's annual rows are
        # called "Pontiac", so no name can separate them, and the predecessor's name would pull
        # the reported year back onto the ORI that consolidation removes. Where someone has
        # checked the identity by hand, that is the answer, and the other rows give way.
        mapped = [e for e in by_target[target] if e[1] == RESOLVED_EXACT]
        if len(mapped) == 1:
            stays = mapped
            unplaceable = [e for e in by_target[target] if e not in mapped]
        else:
            for entry in by_target[target]:
                ori7, _, row = entry
                placed = match_by_name(ori7, (row.get("Agency_Name") or ""), name_index)
                if placed == target:
                    stays.append(entry)
                elif placed is not None and not by_target.get(placed):
                    moved.append((placed, entry))
                else:
                    unplaceable.append(entry)
        for placed, (ori7, _, row) in moved:
            by_target[placed] = [(ori7, RESOLVED_NAME, row)]

        # One row that filed and rivals that filed nothing is not an ambiguity. Las Vegas
        # Metropolitan Police Department reported twelve months under NV00201 beside a second
        # entry reporting none, and neither abbreviation matched the directory's full name, so
        # both were dropped -- 1.7 million people and 86 murders with them.
        if len(stays) != 1:
            competing = stays + unplaceable
            reporting = [e for e in competing if (parse_measure(e[2].get("Months_Reported")) or 0) > 0]
            if len(reporting) == 1:
                stays = reporting
                unplaceable = [e for e in competing if e not in reporting]

        by_target[target] = stays
        for ori7, _, row in unplaceable:
            excluded["ori_collision"] += 1
            ambiguities.append(
                f"{(row.get('Agency_Name') or '').strip()} ({ori7}) also resolves to {target}, "
                "which the directory assigns to a different agency; the row is not loaded"
            )

    new_agencies = []
    staged = []
    staged_population = []
    staged_clearance = []
    for target in sorted(by_target):
        entries = by_target[target]
        if not entries:
            continue
        if len(entries) > 1:
            excluded["ori_collision"] += len(entries)
            ambiguities.append(
                f"{target} is claimed by {len(entries)} source rows the directory cannot tell apart: "
                + ", ".join(sorted(f"{source} ({(row.get('Agency_Name') or '').strip()})"
                                   for source, _, row in entries))
            )
            continue
        ori7, how, row = entries[0]
        resolutions[how] += 1
        if how == RESOLVED_NEW:
            # Normalized, and lower-cased to match the directory's own spelling. An agency
            # first seen in the annual file must be filed under the state code the rest of
            # the directory uses, or the lookups that scope by state will not find it.
            new_agencies.append((target, (row.get("Agency_Name") or "").strip(),
                                 normalize_state(row.get("State")).lower() or None,
                                 agency_type_for_new))
        staged.append(_annual_record(target, year, row))
        staged_population.append((target, year, parse_measure(row.get("Population"))))
        staged_clearance.append(_annual_clearance_record(target, year, row))

    if new_agencies:
        conn.executemany(
            "INSERT OR IGNORE INTO historical_agency (ori, agency, state, type) VALUES (?, ?, ?, ?)",
            sorted(new_agencies),
        )
    conn.executemany(
        "INSERT OR REPLACE INTO historical_agency_crime (ori, year, population, {}) "
        "VALUES ({})".format(", ".join(CRIME_MEASURES), ", ".join("?" * (len(CRIME_MEASURES) + 3))),
        sorted(staged),
    )
    conn.executemany(
        "INSERT OR REPLACE INTO historical_agency_population (ori, year, population) VALUES (?, ?, ?)",
        sorted(staged_population),
    )
    conn.executemany(
        "INSERT OR REPLACE INTO historical_agency_clearance (ori, year, {}) VALUES ({})".format(
            ", ".join(CLEARANCE_COLUMNS), ", ".join("?" * (len(CLEARANCE_COLUMNS) + 2))
        ),
        sorted(staged_clearance),
    )
    return {
        "written": len(staged),
        "population_written": len(staged_population),
        "clearance_written": len(staged_clearance),
        "new_agencies": len(new_agencies),
        "excluded": excluded,
        "resolutions": resolutions,
        "ambiguities": sorted(ambiguities),
        "unknown_state_codes": dict(sorted(unknown_states.items())),
    }


def _annual_record(ori, year, row):
    months = parse_measure(row.get("Months_Reported")) or 0
    population = parse_measure(row.get("Population"))
    if months <= 0:
        # Nothing was filed, so nothing is claimed about the measures. The totals on the row
        # are deliberately not consulted: reporting status is not inferred from counts.
        return (ori, year, population) + (None,) * len(CRIME_MEASURES)

    values = {}
    for column, measure in _ANNUAL_TO_MEASURE.items():
        values[measure] = parse_measure(row.get(column))
    values["violent"] = _sum_or_none(values, _VIOLENT_PARTS)
    values["property"] = _sum_or_none(values, _PROPERTY_PARTS)
    return (ori, year, population) + tuple(values[measure] for measure in CRIME_MEASURES)


def _annual_clearance_record(ori, year, row):
    """One year of clearance rates from an annual row, on the same terms as the base era.

    The annual file states seven offence counts and their seven cleared counts. Violent and
    property are not on it, so they are summed from their parts and only when every part is
    a number -- the same rule the crime side uses, so a total is never a partial total
    wearing a whole one's name.
    """
    months = parse_measure(row.get("Months_Reported")) or 0
    if months <= 0:
        return (ori, year) + (None,) * len(CLEARANCE_COLUMNS)

    offences, cleared = {}, {}
    for column, measure in _ANNUAL_TO_MEASURE.items():
        offences[measure] = parse_measure(row.get(column))
        cleared[measure] = parse_measure(row.get(_ANNUAL_CLEARED_COLUMNS[measure]))
    for total, parts in (("violent", _VIOLENT_PARTS), ("property", _PROPERTY_PARTS)):
        offences[total] = _sum_or_none(offences, parts)
        cleared[total] = _sum_or_none(cleared, parts)
    return (ori, year) + tuple(
        clearance_rate(offences[measure], cleared[measure]) for measure in CLEARANCE_MEASURES
    )


def _sum_or_none(values, parts):
    """A derived total is only a number when every part it is made of is a number."""
    if any(values.get(part) is None for part in parts):
        return None
    return sum(values[part] for part in parts)


# ── consolidations ───────────────────────────────────────────────────────────────────

def apply_consolidations(conn, entries):
    """Absorb predecessor identities into survivors, one validated entry at a time.

    A structural mismatch is fatal: if an entry names an agency the build does not have, or
    puts the pair in a state the directory disagrees with, the manifest is wrong about this
    data and continuing would be guessing. A premise that simply turns out to be false --
    an identity-duplicate entry whose predecessor does carry crime -- is refused and reported,
    because applying it would destroy history the source still holds.

    Two rules make an application safe, and both are checked across every keyed table before
    anything moves in any of them:

    - Nothing may be discarded. A field the predecessor fills where the survivor holds
      something else, or nothing, refuses the whole entry -- in crime, population, clearance
      or staffing alike, because half an identity is worse than two.
    - Nothing may be dropped on the floor. The predecessor's rows are copied into the
      survivor before it is deleted, whatever the entry calls the relationship, since the
      deletion is the same either way.
    """
    applied, refused = 0, []
    agencies_removed = 0
    rows_copied = {table: 0 for table in RECORD_FIELDS_BY_TABLE}
    rows_removed = {table: 0 for table in RECORD_FIELDS_BY_TABLE}
    for entry in entries:
        predecessor = conn.execute(
            "SELECT agency, state FROM historical_agency WHERE ori = ?", (entry.predecessor,)
        ).fetchone()
        survivor = conn.execute(
            "SELECT agency, state FROM historical_agency WHERE ori = ?", (entry.survivor,)
        ).fetchone()

        if survivor is None:
            raise BuildError(f"{entry.predecessor} -> {entry.survivor}: survivor is not in this build")
        if predecessor is None:
            # The manifest names an agency this build does not have, so the manifest and the
            # sources disagree about what exists. Skipping quietly would let a stale entry sit
            # there indefinitely looking applied.
            raise BuildError(
                f"{entry.predecessor} -> {entry.survivor}: predecessor is not in this build, "
                "so this entry no longer describes the data"
            )

        for label, row in (("predecessor", predecessor), ("survivor", survivor)):
            if normalize_state(row[1]) != normalize_state(entry.state):
                raise BuildError(
                    f"{entry.predecessor} -> {entry.survivor}: entry says state {entry.state!r} "
                    f"but the {label} is in {row[1]!r}"
                )
        if not _names_compatible(predecessor[0], entry.name) or not _names_compatible(survivor[0], entry.name):
            raise BuildError(
                f"{entry.predecessor} -> {entry.survivor}: entry says {entry.name!r} but the "
                f"directory says {predecessor[0]!r} and {survivor[0]!r}"
            )

        # An identity-duplicate entry claims the predecessor never carried crime. That claim
        # is about crime, so it is tested against crime: 30 of the 38 entries turn out to be
        # false, and applying one would delete history the source still holds.
        if entry.scope == SCOPE_IDENTITY_DUPLICATE:
            carried = conn.execute(
                "SELECT COUNT(*) FROM historical_agency_crime WHERE ori = ? AND ({})".format(
                    " OR ".join(f"{f} IS NOT NULL" for f in RECORD_FIELDS)
                ),
                (entry.predecessor,),
            ).fetchone()[0]
            if carried:
                refused.append({
                    "predecessor": entry.predecessor,
                    "survivor": entry.survivor,
                    "reason": f"listed as a duplicate carrying no crime, but the source holds "
                              f"{carried} agency-year(s) with crime values",
                })
                continue

        # Both ORIs holding the same year, with different figures, means this is not one
        # agency's history split in two. Copying with INSERT OR IGNORE and then deleting the
        # predecessor threw the losing side away silently -- 48 years of Allegheny County in
        # the real sources. Neither side is safe to discard, so nothing moves.
        # Field by field, not field against row: a conflict is one field the predecessor
        # fills where the survivor holds something else, or nothing. Comparing "holds any
        # value" against "any field differs" flagged fields the predecessor left blank.
        #
        # Checked in every keyed table before anything moves in any of them, and for both
        # scopes. One identity cannot be half-absorbed: if population disagrees where crime
        # does not, moving crime alone would leave the two tables describing different
        # agencies, and a rate built by joining them would be nonsense assembled from real
        # numbers. Pontiac is the case -- its two ORIs agree on every crime year and disagree
        # on 2015's population, 59,888 against 72,884.
        conflicts = {}
        for table, fields in sorted(RECORD_FIELDS_BY_TABLE.items()):
            years = [str(year) for (year,) in conn.execute(
                "SELECT p.year FROM {0} p JOIN {0} s ON s.ori = ? AND s.year = p.year "
                "WHERE p.ori = ? AND ({1}) ORDER BY p.year".format(
                    table,
                    " OR ".join(
                        f"(p.{f} IS NOT NULL AND (s.{f} IS NULL OR s.{f} <> p.{f}))"
                        for f in fields
                    ),
                ),
                (entry.survivor, entry.predecessor),
            )]
            if years:
                conflicts[table] = years
        if conflicts:
            refused.append({
                "predecessor": entry.predecessor,
                "survivor": entry.survivor,
                "reason": "both agencies hold different figures for overlapping year(s); "
                          "neither history can be discarded -- "
                          + "; ".join(f"{table}: {len(years)} year(s) {years[0]}-{years[-1]}"
                                      for table, years in sorted(conflicts.items())),
                "tables": {table: len(years) for table, years in sorted(conflicts.items())},
            })
            continue

        # Copy first, in every table, then delete. The predecessor's rows are carried across
        # whatever the entry calls the relationship, because the deletion is the same either
        # way and so is what would otherwise be lost. Indianapolis is why: `INIPD0000` was
        # listed as an empty duplicate, and it holds the department's entire staffing history,
        # 1960-2025, on an ORI whose survivor has none. Deleting it without copying would have
        # erased sixty-five years of officer counts to tidy up an identifier.
        for table, fields in sorted(RECORD_FIELDS_BY_TABLE.items()):
            columns = ", ".join(fields)
            rows_copied[table] += conn.execute(
                "INSERT OR IGNORE INTO {0} (ori, year, {1}) "
                "SELECT ?, year, {1} FROM {0} WHERE ori = ? ORDER BY year".format(table, columns),
                (entry.survivor, entry.predecessor),
            ).rowcount
        for table in sorted(RECORD_FIELDS_BY_TABLE):
            rows_removed[table] += conn.execute(
                f"DELETE FROM {table} WHERE ori = ?", (entry.predecessor,)).rowcount
        agencies_removed += conn.execute(
            "DELETE FROM historical_agency WHERE ori = ?", (entry.predecessor,)).rowcount
        applied += 1

    return {"applied": applied,
            "refused": sorted(refused, key=lambda r: r["predecessor"]),
            "survivor_rows_added": dict(sorted(rows_copied.items())),
            "predecessor_rows_removed": dict(sorted(rows_removed.items())),
            "predecessor_agencies_removed": agencies_removed}


def load_consolidations(path):
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    return [Consolidation.from_dict(entry) for entry in payload["entries"]]


# ── evidence ─────────────────────────────────────────────────────────────────────────

_DIGEST_ORDER = {
    "historical_agency": "ori",
    "historical_agency_crime": "ori, year",
    "historical_agency_population": "ori, year",
    "historical_agency_clearance": "ori, year",
    "historical_staffing": "ori, year",
}

#: Every table a complete build produces. Naming them in one place is what stops a later
#: change from adding a table the manifest, the digests and the comparison never hear about.
BUILT_TABLES = ("historical_agency", "historical_agency_crime", "historical_agency_population",
                "historical_agency_clearance", "historical_staffing")


def table_digest(conn, table):
    """A digest of a table's ordered contents, independent of physical row order."""
    order = _DIGEST_ORDER[table]
    digest = hashlib.sha256()
    columns = [row[1] for row in conn.execute(f"PRAGMA table_info({table})")]
    digest.update(("|".join(columns) + "\n").encode("utf-8"))
    for row in conn.execute(f"SELECT {', '.join(columns)} FROM {table} ORDER BY {order}"):
        digest.update(("".join("" if v is None else str(v) for v in row) + "\n").encode("utf-8"))
    return digest.hexdigest()


def table_schema_digest(conn, table):
    sql = conn.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (table,)
    ).fetchone()
    return hashlib.sha256((sql[0] if sql else "").encode("utf-8")).hexdigest()


def sha256_file(path, chunk=1 << 20):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(chunk), b""):
            digest.update(block)
    return digest.hexdigest()


def open_build_database(path):
    assert_safe_destination(path)
    conn = sqlite3.connect(path)
    create_core_tables(conn)
    return conn
