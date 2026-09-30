"""The row delimiter in historical_core.table_digest must stay exactly one byte, code point 0x1F.

WHY THIS EXISTS. That delimiter was a RAW 0x1F byte sitting in the source, which made the file
fragile: any tool that re-encodes it could destroy the separator silently, and Git had to be told
whether the file was text. P1.1 replaced the raw byte with the four source characters of an explicit
escape. The runtime value must be identical -- and "must be identical" is a claim that needs a test
rather than an assurance.

The delimiter matters. ASCII Unit Separator is chosen precisely because it cannot appear in the data
being joined, so `("a", "b|c")` and `("a|b", "c")` produce different digests. If the escape had been
mangled into four literal characters, that property would silently break: rows would join with the
text "\\x1f" and any row containing that text could collide.

Read-only. Builds a throwaway in-memory database; touches nothing on disk.
"""
import hashlib
import io
import os
import sqlite3
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import historical_core  # noqa: E402

SOURCE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "historical_core.py")
US = chr(0x1F)

passed = 0


def check(name, body):
    global passed
    body()
    passed += 1
    print("  ok  %s" % name)


def test_source_has_no_raw_control_byte():
    data = io.open(SOURCE, "rb").read()
    assert bytes([0x1F]) not in data, "a raw 0x1F byte is back in historical_core.py"
    control = [b for b in data if b < 0x20 and b not in (9, 10, 13)]
    assert not control, "historical_core.py contains control byte(s): %r" % control


def test_source_carries_the_escape():
    text = io.open(SOURCE, encoding="utf-8").read()
    # Built from chr() so this test cannot itself be mangled by whatever writes it.
    escape = chr(92) + "x1f"
    assert escape in text, "the explicit 0x1F escape is missing from the source"


def test_delimiter_is_one_code_point():
    assert len(US) == 1, "the unit separator is not a single code point"
    assert ord(US) == 0x1F, "the unit separator is not code point 0x1F"
    assert US.encode("utf-8") == bytes([0x1F]), "the unit separator is not one byte in UTF-8"


def _digest_of(rows):
    """Run the real table_digest over a throwaway table holding `rows`."""
    conn = sqlite3.connect(":memory:")
    conn.execute("CREATE TABLE t (a TEXT, b TEXT)")
    conn.executemany("INSERT INTO t VALUES (?, ?)", rows)
    # table_digest reads its ordering from historical_core._DIGEST_ORDER, so register one.
    historical_core._DIGEST_ORDER["t"] = "a, b"
    return historical_core.table_digest(conn, "t")


def test_digest_matches_an_independent_computation():
    """The decisive equivalence check: recompute the digest by hand with chr(0x1F)."""
    rows = [("x", "y"), ("p", "q")]
    actual = _digest_of(rows)

    expected = hashlib.sha256()
    expected.update(("|".join(["a", "b"]) + "\n").encode("utf-8"))
    for row in sorted(rows):
        expected.update((US.join(row) + "\n").encode("utf-8"))
    assert actual == expected.hexdigest(), (
        "table_digest no longer joins rows with a single 0x1F -- the escape did not survive as one "
        "code point (got %s, expected %s)" % (actual, expected.hexdigest()))


def test_the_delimiter_still_separates_ambiguous_rows():
    """The property the separator exists for: a pipe in the data must not create a collision."""
    left = _digest_of([("a", "b|c")])
    right = _digest_of([("a|b", "c")])
    assert left != right, "two different rows digested identically; the delimiter is not doing its job"


def test_a_literal_backslash_delimiter_would_be_detectably_different():
    """Proves the equivalence test above is not vacuous."""
    rows = [("x", "y")]
    real = _digest_of(rows)
    mangled = hashlib.sha256()
    mangled.update(("|".join(["a", "b"]) + "\n").encode("utf-8"))
    mangled.update(((chr(92) + "x1f").join(rows[0]) + "\n").encode("utf-8"))
    assert real != mangled.hexdigest(), (
        "a four-character literal delimiter produces the same digest as one 0x1F byte, so the "
        "equivalence test above would not catch a mangled escape")


check("the source carries no raw control byte", test_source_has_no_raw_control_byte)
check("the source carries the explicit escape", test_source_carries_the_escape)
check("the delimiter is one code point, 0x1F", test_delimiter_is_one_code_point)
check("table_digest matches an independent 0x1F computation", test_digest_matches_an_independent_computation)
check("the delimiter still separates otherwise-ambiguous rows", test_the_delimiter_still_separates_ambiguous_rows)
check("a mangled delimiter would be detectably different", test_a_literal_backslash_delimiter_would_be_detectably_different)

print("historical core digest delimiter tests: %d passed" % passed)
