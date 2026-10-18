"""FBI hate crime bias motivation codes: one decoder for the importer and the re-decode (hotfix 2026-10-12).

The reference (scripts/fixtures/hate-crime-bias-codes.json) is the FBI list: the 36 codes of the 2015 Hate Crime Data
Collection Guidelines, the code groups, and the codes whose MEANING differed in earlier years (FBI UCR Handbook 2004
form 1-699; UCR State Program Bulletin 13-3; Hate Crime Statistics 2015 "About"). Sources and evidence:
audit/request-accounting-stage4/task0/fbi-bias-codes/. The table this replaces mislabeled 23 codes.
"""
import contextlib
import json
import os

REFERENCE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "hate-crime-bias-codes.json")

with open(REFERENCE_PATH, encoding="utf-8") as _fh:
    _REF = json.load(_fh)

MODERN = _REF["modern"]
_BEFORE = {k: v for k, v in _REF["beforeYear"].items() if not k.startswith("_")}


def _group(code):
    """The FBI group of a code, by its range."""
    try:
        n = int(code)
    except (TypeError, ValueError):
        return "Other"
    if 11 <= n <= 16 or 31 <= n <= 33:
        return "Race/Ethnicity/Ancestry"
    if 21 <= n <= 29 or 81 <= n <= 85:
        return "Religion"
    if 41 <= n <= 45:
        return "Sexual Orientation"
    if 51 <= n <= 52:
        return "Disability"
    if 61 <= n <= 62:
        return "Gender"
    if 71 <= n <= 72:
        return "Gender Identity"
    return "Other"


def decode(code, year):
    """(label, group, unresolved, listed) for a bias code in a data year (None = the modern meaning).

    A code not in the FBI list is never given a label: it is reported as itself, in group "Other", with listed False.
    """
    code = (code or "").strip()
    if code not in MODERN:
        return (f"Bias code {code or '(blank)'} (not in the FBI list)", "Other", False, False)
    if year is not None:
        for rule in _BEFORE.get(code, []):
            if int(year) < int(rule["before"]):
                return (rule["label"], rule.get("group", _group(code)), bool(rule.get("unresolved", False)), True)
    return (MODERN[code], _group(code), False, True)


class LockBusy(Exception):
    """Another process holds the hate-crime database lock."""


@contextlib.contextmanager
def exclusive_lock(path):
    """Hold ONE exclusive OS lock on `path` for the duration (shared with scripts/update-hate-crime.sh's flock).

    Non-blocking: raises LockBusy when another process holds it.
    """
    fh = open(path, "a+")
    try:
        try:
            if os.name == "nt":
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            raise LockBusy(path) from exc
        try:
            yield
        finally:
            if os.name == "nt":
                import msvcrt
                fh.seek(0)
                msvcrt.locking(fh.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
    finally:
        fh.close()
