#!/usr/bin/env python3
"""Tests for bh_population() in nibrs-auto-update.py.

The NIBRS batch header carries five county slots, 24 characters apart, each with
the population of the part of the agency in that county. Reading only the first
undercounted every multi-county agency (Kansas City, MO: 317,692 against
518,039). The federal placeholder 100,000,000 is zeroed per slot.

Usage: python scripts/test_nibrs_bh_population.py
"""

import importlib.util
import sys
import unittest
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPTS))


def load_updater():
    name = "nibrs_auto_update_bh_population"
    spec = importlib.util.spec_from_file_location(name, SCRIPTS / "nibrs-auto-update.py")
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


U = load_updater()


def bh_line(slots, length=260):
    """A BH line with the given current-population slot values (None = blank)."""
    line = list("BH" + " " * (length - 2))
    for k, value in enumerate(slots):
        start = 105 + 24 * k
        text = " " * 9 if value is None else str(value).rjust(9, "0")
        line[start:start + 9] = text
        # County and MSA codes after each population, so a slot is not all blank.
        line[start + 9:start + 15] = "001002"
    return "".join(line)


class BhPopulation(unittest.TestCase):
    def test_single_county_agency(self):
        self.assertEqual(U.bh_population(bh_line([123456])), 123456)

    def test_multi_county_agency_sums_all_slots(self):
        # Kansas City, MO in the 2025 master file.
        line = bh_line([317692, 144216, 56034, 97, 0])
        self.assertEqual(U.bh_population(line), 518039)

    def test_placeholder_zeroed_per_slot(self):
        self.assertEqual(U.bh_population(bh_line([100_000_000])), 0)
        self.assertEqual(U.bh_population(bh_line([100_000_000, 5000])), 5000)
        self.assertEqual(U.bh_population(bh_line([99_999_999])), 99_999_999)

    def test_real_zero_stays_zero(self):
        self.assertEqual(U.bh_population(bh_line([0, 0, 0, 0, 0])), 0)

    def test_all_blank_is_none(self):
        self.assertIsNone(U.bh_population(bh_line([None, None, None, None, None])))

    def test_first_slot_blank_later_slot_counted(self):
        self.assertEqual(U.bh_population(bh_line([None, 2500])), 2500)

    def test_short_line_reads_available_slots(self):
        # s() returns '' past the end of the line, so missing slots are blank.
        line = bh_line([4000], length=130)
        self.assertEqual(U.bh_population(line), 4000)


if __name__ == "__main__":
    unittest.main()
