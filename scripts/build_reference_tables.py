"""Build small reference lookup tables for NIBRS codes."""
import sqlite3
import argparse

CLEARANCE_CODES = [
    ("N", "Not Cleared", "Incident is still open / no clearance"),
    ("A", "Death of Offender", "Offender died before arrest"),
    ("B", "Prosecution Declined", "Prosecutor declined to pursue charges"),
    ("C", "In Custody of Other Jurisdiction", "Offender is in custody elsewhere"),
    ("D", "Victim Refused to Cooperate", "Victim declined to assist prosecution"),
    ("E", "Juvenile/No Custody", "Juvenile offender, no custody action taken"),
]

LOCATION_TYPES = [
    ("01", "Air/Bus/Train Terminal"),
    ("02", "Bank/Savings and Loan"),
    ("03", "Bar/Nightclub"),
    ("04", "Church/Synagogue/Temple/Mosque"),
    ("05", "Commercial/Office Building"),
    ("06", "Construction Site"),
    ("07", "Convenience Store"),
    ("08", "Department/Discount Store"),
    ("09", "Drug Store/Doctor's Office/Hospital"),
    ("10", "Field/Woods"),
    ("11", "Government/Public Building"),
    ("12", "Grocery/Supermarket"),
    ("13", "Highway/Road/Alley/Street/Sidewalk"),
    ("14", "Hotel/Motel/Etc."),
    ("15", "Jail/Prison/Penitentiary/Corrections Facility"),
    ("16", "Lake/Waterway/Beach"),
    ("17", "Liquor Store"),
    ("18", "Parking/Drop Lot/Garage"),
    ("19", "Rental Storage Facility"),
    ("20", "Residence/Home"),
    ("21", "Restaurant"),
    ("22", "School/College"),
    ("23", "Service/Gas Station"),
    ("24", "Specialty Store"),
    ("25", "Other/Unknown"),
    ("37", "Abandoned/Condemned Structure"),
    ("38", "Amusement Park"),
    ("39", "Arena/Stadium/Fairgrounds/Coliseum"),
    ("40", "ATM Separate from Bank"),
    ("41", "Auto Dealership New/Used"),
    ("42", "Camp/Campground"),
    ("44", "Daycare Facility"),
    ("45", "Dock/Wharf/Freight/Modal Terminal"),
    ("46", "Farm Facility"),
    ("47", "Gambling Facility/Casino/Race Track"),
    ("48", "Industrial Site"),
    ("49", "Military Installation"),
    ("50", "Park/Playground"),
    ("51", "Rest Area"),
    ("52", "School—College/University"),
    ("53", "School—Elementary/Secondary"),
    ("54", "Shelter—Mission/Homeless"),
    ("55", "Shopping Mall"),
    ("56", "Tribal Lands"),
    ("57", "Community Center"),
    ("58", "Cyberspace"),
]

PROPERTY_DESCRIPTIONS = [
    ("01", "Aircraft"),
    ("02", "Alcohol"),
    ("03", "Automobiles"),
    ("04", "Bicycles"),
    ("05", "Buses"),
    ("06", "Clothes/Furs"),
    ("07", "Computer Hardware/Software"),
    ("08", "Consumable Goods"),
    ("09", "Credit/Debit Cards"),
    ("10", "Drugs/Narcotics"),
    ("11", "Drug/Narcotic Equipment"),
    ("12", "Farm Equipment"),
    ("13", "Firearms"),
    ("14", "Gambling Equipment"),
    ("15", "Heavy Construction/Industrial Equipment"),
    ("16", "Household Goods"),
    ("17", "Jewelry/Precious Metals/Gems"),
    ("18", "Livestock"),
    ("19", "Merchandise"),
    ("20", "Money"),
    ("21", "Negotiable Instruments"),
    ("22", "Nonnegotiable Instruments"),
    ("23", "Office-type Equipment"),
    ("24", "Other Motor Vehicles"),
    ("25", "Purses/Handbags/Wallets"),
    ("26", "Radios/TVs/VCRs/DVD Players"),
    ("27", "Recordings—Audio/Visual"),
    ("28", "Recreational Vehicles"),
    ("29", "Structures—Single Occupancy Dwellings"),
    ("30", "Structures—Other Dwellings"),
    ("31", "Structures—Other Commercial/Business"),
    ("32", "Structures—Industrial/Manufacturing"),
    ("33", "Structures—Public/Community"),
    ("34", "Structures—Storage"),
    ("35", "Structures—Other"),
    ("36", "Tools"),
    ("37", "Trucks"),
    ("38", "Vehicle Parts/Accessories"),
    ("39", "Watercraft"),
    ("41", "Aircraft Parts/Accessories"),
    ("42", "Artistic Supplies/Accessories"),
    ("43", "Building Materials"),
    ("44", "Camping/Hunting/Fishing Equipment/Supplies"),
    ("45", "Chemicals"),
    ("46", "Collections/Collectibles"),
    ("47", "Crops"),
    ("48", "Documents/Personal or Business"),
    ("49", "Explosives"),
    ("59", "Firearm Accessories"),
    ("64", "Fuel"),
    ("65", "Identity Documents"),
    ("66", "Identity—Intangible"),
    ("67", "Law Enforcement Equipment"),
    ("68", "Lawn/Yard/Garden Equipment"),
    ("69", "Logging Equipment"),
    ("70", "Medical/Medical Lab Equipment"),
    ("71", "Metals, Non-Precious"),
    ("72", "Musical Instruments"),
    ("73", "Pets"),
    ("74", "Pharmaceuticals"),
    ("75", "Phone/Cell Phone"),
    ("76", "Photographic/Optical Equipment"),
    ("77", "Portable Electronic Communications"),
    ("78", "Recreational/Sports Equipment"),
    ("79", "Other"),
    ("80", "Pending Inventory"),
    ("88", "Special Category"),
    ("99", "Unknown"),
]

WEAPON_CODES = [
    ("11", "Firearm (type not stated)"),
    ("12", "Handgun"),
    ("13", "Rifle"),
    ("14", "Shotgun"),
    ("15", "Other Firearm"),
    ("20", "Knife/Cutting Instrument"),
    ("30", "Blunt Object"),
    ("35", "Motor Vehicle"),
    ("40", "Personal Weapons (hands, fists, feet)"),
    ("50", "Poison"),
    ("60", "Explosives"),
    ("65", "Fire/Incendiary Device"),
    ("70", "Drugs/Narcotics/Sleeping Pills"),
    ("85", "Asphyxiation"),
    ("90", "Other"),
    ("95", "Unknown"),
    ("99", "None"),
]

RACE_CODES = [
    ("W", "White"),
    ("B", "Black or African American"),
    ("I", "American Indian or Alaska Native"),
    ("A", "Asian"),
    ("P", "Native Hawaiian or Other Pacific Islander"),
    ("U", "Unknown"),
]

ETHNICITY_CODES = [
    ("H", "Hispanic or Latino"),
    ("N", "Not Hispanic or Latino"),
    ("U", "Unknown"),
]

POP_GROUPS = [
    ("0", "Possessions (Puerto Rico, Guam, etc.)"),
    ("1A", "Cities 1,000,000+"),
    ("1B", "Cities 500,000–999,999"),
    ("1C", "Cities 250,000–499,999"),
    ("2", "Cities 100,000–249,999"),
    ("3", "Cities 50,000–99,999"),
    ("4", "Cities 25,000–49,999"),
    ("5", "Cities 10,000–24,999"),
    ("6", "Cities 5,000–9,999"),
    ("7", "Cities 2,500–4,999"),
    ("8", "Cities under 2,500"),
    ("8A", "Non-MSA Cities under 2,500"),
    ("8B", "MSA Cities under 2,500"),
    ("9A", "Non-MSA Counties"),
    ("9B", "MSA Counties"),
    ("9C", "Non-MSA State Police"),
    ("9D", "MSA State Police"),
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/opt/nibrs/nibrs.db")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    conn.execute("PRAGMA busy_timeout=30000")

    tables = {
        "nibrs_clearance_codes": {
            "schema": "(code TEXT PRIMARY KEY, description TEXT, detail TEXT)",
            "data": CLEARANCE_CODES,
        },
        "nibrs_location_types": {
            "schema": "(code TEXT PRIMARY KEY, description TEXT)",
            "data": LOCATION_TYPES,
        },
        "nibrs_property_descriptions": {
            "schema": "(code TEXT PRIMARY KEY, description TEXT)",
            "data": PROPERTY_DESCRIPTIONS,
        },
        "nibrs_weapon_codes": {
            "schema": "(code TEXT PRIMARY KEY, description TEXT)",
            "data": WEAPON_CODES,
        },
        "nibrs_race_codes": {
            "schema": "(code TEXT PRIMARY KEY, description TEXT)",
            "data": RACE_CODES,
        },
        "nibrs_ethnicity_codes": {
            "schema": "(code TEXT PRIMARY KEY, description TEXT)",
            "data": ETHNICITY_CODES,
        },
        "nibrs_pop_groups": {
            "schema": "(code TEXT PRIMARY KEY, description TEXT)",
            "data": POP_GROUPS,
        },
    }

    for name, info in tables.items():
        conn.execute(f"CREATE TABLE IF NOT EXISTS {name} {info['schema']}")
        conn.execute(f"DELETE FROM {name}")
        placeholders = ",".join("?" * len(info["data"][0]))
        conn.executemany(f"INSERT INTO {name} VALUES ({placeholders})", info["data"])
        cnt = conn.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
        print(f"  {name}: {cnt} rows")

    conn.commit()
    print("Done")
    conn.close()


if __name__ == "__main__":
    main()
