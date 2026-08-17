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
_VIOLENT_PARTS = ("murder", "rape", "robbery", "assault")
_PROPERTY_PARTS = ("burglary", "theft", "motor_vehicle_theft")

AGENCY_COLUMNS = ("ori", "agency", "state", "type", "region", "division", "size",
                  "latitude", "longitude", "start", "end")

RESOLVED_EXACT = "exact_mapping"
RESOLVED_PADDED = "canonical_padded"
RESOLVED_PREFIX = "unique_prefix"
RESOLVED_NEW = "new_agency"
RESOLVED_NAME = "directory_name_match"

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
        """
    )


def assert_safe_destination(path):
    """Refuse to build anywhere that could be a real database.

    The pipeline produces evidence, not production data. Every destination has to be a new
    file the caller chose, and the canonical names are rejected wherever they appear.
    """
    if not path:
        raise BuildError("a destination path is required")
    normalized = str(path).replace("\\", "/").lower()
    if os.path.basename(normalized) in _FORBIDDEN_BASENAMES:
        raise BuildError(f"refusing to build into a canonical database: {path}")
    for fragment in _FORBIDDEN_FRAGMENTS:
        if fragment.replace("\\", "/") in normalized:
            raise BuildError(f"refusing to build into a production path: {path}")
    if os.path.exists(path):
        raise BuildError(f"destination already exists; choose a new file: {path}")
    return path


# ── base era ─────────────────────────────────────────────────────────────────────────

def load_agencies(conn, rows):
    """Load the agency directory from its source rows. Returns how many were written."""
    payload = []
    seen = {}
    for row in rows:
        ori = (row.get("id") or row.get("ori") or "").strip()
        if not ori:
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
    return len(seen)


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


def load_base_crime(conn, rows):
    """Load the 1930-2024 annual series, preserving zero and blank as they arrive."""
    staged = {}
    read = 0
    for row in rows:
        ori = (row.get("id") or row.get("ori") or "").strip()
        year_raw = str(row.get("year") or "").strip()
        if not ori or not year_raw:
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
    return {"read": read, "written": len(staged), "duplicates_identical": read - len(staged)}


# ── identity ─────────────────────────────────────────────────────────────────────────

def build_prefix_index(conn):
    """Seven-character prefix to every agency ORI under it, in a fixed order."""
    index = {}
    for (ori,) in conn.execute("SELECT ori FROM historical_agency ORDER BY ori"):
        index.setdefault(ori[:7], []).append(ori)
    return {prefix: tuple(sorted(oris)) for prefix, oris in index.items()}


def build_prefix_name_index(conn):
    """Seven-character prefix to the (ORI, agency name) pairs under it, in a fixed order."""
    index = {}
    for ori, agency in conn.execute("SELECT ori, agency FROM historical_agency ORDER BY ori"):
        index.setdefault(ori[:7], []).append((ori, agency or ""))
    return {prefix: tuple(pairs) for prefix, pairs in index.items()}


def match_by_name(ori7, agency_name, name_index):
    """The one agency under this prefix whose directory name fits the name on the source row.

    The annual file's seven-character ORI is not unique -- a city and a district attorney's
    office can share one -- but each row also carries the agency's name, and the directory
    holds the full nine-character identity for both. Returns None unless exactly one fits, so
    a near-miss never becomes a decision.
    """
    matches = [ori for ori, agency in name_index.get(ori7, ()) if _names_compatible(agency, agency_name)]
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
        if (state or "").strip().lower() != mapping.state.strip().lower():
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


def resolve_annual_ori(ori7, exact_map, index):
    """Resolve a seven-character source ORI to a nine-character agency ORI, or refuse.

    Order matters. The exact mapping wins first, which is what keeps Pontiac's 2025 year off
    the predecessor ORI that consolidation later removes.
    """
    ori7 = ori7.strip()
    for mapping in exact_map:
        if mapping.source == ori7:
            return mapping.target, RESOLVED_EXACT

    candidates = index.get(ori7, ())
    padded = ori7 + "00"
    if padded in candidates:
        return padded, RESOLVED_PADDED
    if len(candidates) == 1:
        return candidates[0], RESOLVED_PREFIX
    if len(candidates) > 1:
        raise AmbiguousOri(
            f"{ori7} matches {len(candidates)} agencies and none is the canonical +00 form: "
            + ", ".join(candidates)
        )
    return padded, RESOLVED_NEW


# ── annual era ───────────────────────────────────────────────────────────────────────

def load_annual(conn, rows, exact_map, year, agency_type_for_new=None):
    """Load one annual RETA year.

    Reporting status comes from `Months_Reported` and from nothing else. Zero months means the
    measures are missing; one or more months means every supplied value is kept, including a
    year of zeroes. The row is written either way, so an agency-year with nothing to report
    looks the same here as it does in the base era.
    """
    index = build_prefix_index(conn)
    excluded = {"ori_collision": 0, "ambiguous_ori": 0, "unusable_row": 0}
    ambiguities = []
    by_target = {}
    resolutions = {RESOLVED_EXACT: 0, RESOLVED_PADDED: 0, RESOLVED_PREFIX: 0,
                   RESOLVED_NEW: 0, RESOLVED_NAME: 0}

    for row in rows:
        ori7 = (row.get("ORI") or "").strip()
        if not ori7:
            excluded["unusable_row"] += 1
            continue
        try:
            target, how = resolve_annual_ori(ori7, exact_map, index)
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
    name_index = build_prefix_name_index(conn)
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
        by_target[target] = stays
        for ori7, _, row in unplaceable:
            excluded["ori_collision"] += 1
            ambiguities.append(
                f"{(row.get('Agency_Name') or '').strip()} ({ori7}) also resolves to {target}, "
                "which the directory assigns to a different agency; the row is not loaded"
            )

    new_agencies = []
    staged = []
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
            new_agencies.append((target, (row.get("Agency_Name") or "").strip(),
                                 (row.get("State") or "").strip().lower(), agency_type_for_new))
        staged.append(_annual_record(target, year, row))

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
    return {
        "written": len(staged),
        "new_agencies": len(new_agencies),
        "excluded": excluded,
        "resolutions": resolutions,
        "ambiguities": ambiguities,
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
    """
    applied, refused, skipped = 0, [], 0
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
            skipped += 1
            continue

        for label, row in (("predecessor", predecessor), ("survivor", survivor)):
            if (row[1] or "").strip().lower() != entry.state.strip().lower():
                raise BuildError(
                    f"{entry.predecessor} -> {entry.survivor}: entry says state {entry.state!r} "
                    f"but the {label} is in {row[1]!r}"
                )
        if not _names_compatible(predecessor[0], entry.name) or not _names_compatible(survivor[0], entry.name):
            raise BuildError(
                f"{entry.predecessor} -> {entry.survivor}: entry says {entry.name!r} but the "
                f"directory says {predecessor[0]!r} and {survivor[0]!r}"
            )

        carried = conn.execute(
            "SELECT COUNT(*) FROM historical_agency_crime WHERE ori = ? AND ({})".format(
                " OR ".join(f"{m} IS NOT NULL" for m in CRIME_MEASURES)
            ),
            (entry.predecessor,),
        ).fetchone()[0]

        if entry.scope == SCOPE_IDENTITY_DUPLICATE and carried:
            refused.append({
                "predecessor": entry.predecessor,
                "survivor": entry.survivor,
                "reason": f"listed as a duplicate carrying no crime, but the source holds "
                          f"{carried} agency-year(s) with crime values",
            })
            continue

        if entry.scope == SCOPE_CRIME_TRANSITION:
            conn.execute(
                "INSERT OR IGNORE INTO historical_agency_crime "
                "(ori, year, population, {0}) SELECT ?, year, population, {0} "
                "FROM historical_agency_crime WHERE ori = ? ORDER BY year".format(", ".join(CRIME_MEASURES)),
                (entry.survivor, entry.predecessor),
            )
        conn.execute("DELETE FROM historical_agency_crime WHERE ori = ?", (entry.predecessor,))
        conn.execute("DELETE FROM historical_agency WHERE ori = ?", (entry.predecessor,))
        applied += 1

    return {"applied": applied, "refused": refused, "already_absent": skipped}


def load_consolidations(path):
    with open(path, encoding="utf-8") as handle:
        payload = json.load(handle)
    return [Consolidation.from_dict(entry) for entry in payload["entries"]]


# ── evidence ─────────────────────────────────────────────────────────────────────────

_DIGEST_ORDER = {
    "historical_agency": "ori",
    "historical_agency_crime": "ori, year",
}


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
