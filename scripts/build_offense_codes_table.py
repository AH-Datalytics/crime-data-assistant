"""Build a small nibrs_offense_codes reference table."""
import sqlite3

CODES = [
    ("09A", "Murder and Nonnegligent Manslaughter", "Crimes Against Persons"),
    ("09B", "Negligent Manslaughter", "Crimes Against Persons"),
    ("09C", "Justifiable Homicide", "Crimes Against Persons"),
    ("100", "Kidnapping/Abduction", "Crimes Against Persons"),
    ("11A", "Forcible Rape", "Crimes Against Persons"),
    ("11B", "Forcible Sodomy", "Crimes Against Persons"),
    ("11C", "Sexual Assault With Object", "Crimes Against Persons"),
    ("11D", "Forcible Fondling", "Crimes Against Persons"),
    ("120", "Robbery", "Crimes Against Persons"),
    ("13A", "Aggravated Assault", "Crimes Against Persons"),
    ("13B", "Simple Assault", "Crimes Against Persons"),
    ("13C", "Intimidation", "Crimes Against Persons"),
    ("200", "Arson", "Crimes Against Property"),
    ("210", "Extortion/Blackmail", "Crimes Against Property"),
    ("220", "Burglary/Breaking & Entering", "Crimes Against Property"),
    ("23A", "Pocket-picking", "Crimes Against Property"),
    ("23B", "Purse-snatching", "Crimes Against Property"),
    ("23C", "Shoplifting", "Crimes Against Property"),
    ("23D", "Theft From Building", "Crimes Against Property"),
    ("23E", "Theft From Coin-Operated Machine", "Crimes Against Property"),
    ("23F", "Theft From Motor Vehicle", "Crimes Against Property"),
    ("23G", "Theft of Motor Vehicle Parts/Accessories", "Crimes Against Property"),
    ("23H", "All Other Larceny", "Crimes Against Property"),
    ("240", "Motor Vehicle Theft", "Crimes Against Property"),
    ("250", "Counterfeiting/Forgery", "Crimes Against Property"),
    ("26A", "False Pretenses/Swindle/Confidence Game", "Crimes Against Property"),
    ("26B", "Credit Card/ATM Fraud", "Crimes Against Property"),
    ("26C", "Impersonation", "Crimes Against Property"),
    ("26D", "Welfare Fraud", "Crimes Against Property"),
    ("26E", "Wire Fraud", "Crimes Against Property"),
    ("26F", "Identity Theft", "Crimes Against Property"),
    ("26G", "Hacking/Computer Invasion", "Crimes Against Property"),
    ("26H", "Money Laundering", "Crimes Against Property"),
    ("270", "Embezzlement", "Crimes Against Property"),
    ("280", "Stolen Property Offenses", "Crimes Against Property"),
    ("290", "Destruction/Damage/Vandalism of Property", "Crimes Against Property"),
    ("30A", "Non-Forcible Incest (Historical)", "Crimes Against Society"),
    ("30B", "Non-Forcible Fondling (Historical)", "Crimes Against Society"),
    ("30C", "Non-Forcible Sodomy (Historical)", "Crimes Against Society"),
    ("30D", "Non-Forcible Rape (Historical)", "Crimes Against Society"),
    ("35A", "Drug/Narcotic Violations", "Crimes Against Society"),
    ("35B", "Drug Equipment Violations", "Crimes Against Society"),
    ("360", "Sex Offenses (Historical)", "Crimes Against Society"),
    ("36A", "Incest", "Crimes Against Society"),
    ("36B", "Statutory Rape", "Crimes Against Society"),
    ("370", "Pornography/Obscene Material", "Crimes Against Society"),
    ("39A", "Betting/Wagering", "Crimes Against Society"),
    ("39B", "Operating/Promoting/Assisting Gambling", "Crimes Against Society"),
    ("39C", "Gambling Equipment Violations", "Crimes Against Society"),
    ("39D", "Sports Tampering", "Crimes Against Society"),
    ("40A", "Prostitution", "Crimes Against Society"),
    ("40B", "Assisting or Promoting Prostitution", "Crimes Against Society"),
    ("40C", "Purchasing Prostitution", "Crimes Against Society"),
    ("49A", "Failure to Register as Sex Offender", "Crimes Against Society"),
    ("49B", "Failure to Register as Violent Offender", "Crimes Against Society"),
    ("49C", "Failure to Register Other", "Crimes Against Society"),
    ("510", "Bribery", "Crimes Against Society"),
    ("520", "Weapon Law Violations", "Crimes Against Society"),
    ("521", "Violation of No Contact Order", "Crimes Against Society"),
    ("522", "Violation of Protection Order", "Crimes Against Society"),
    ("526", "Treason", "Crimes Against Society"),
    ("58B", "Espionage", "Crimes Against Society"),
    ("61A", "Federal Liquor Offenses", "Crimes Against Society"),
    ("61B", "Immigration Violations", "Crimes Against Society"),
    ("620", "Import Violations", "Crimes Against Society"),
    ("64A", "Human Trafficking - Commercial Sex", "Crimes Against Persons"),
    ("64B", "Human Trafficking - Involuntary Servitude", "Crimes Against Persons"),
    ("720", "Animal Cruelty", "Crimes Against Society"),
    ("90A", "Bad Checks", "Group B"),
    ("90B", "Curfew/Loitering/Vagrancy", "Group B"),
    ("90C", "Disorderly Conduct", "Group B"),
    ("90D", "Driving Under the Influence", "Group B"),
    ("90E", "Drunkenness", "Group B"),
    ("90F", "Family Offenses, Nonviolent", "Group B"),
    ("90G", "Liquor Law Violations", "Group B"),
    ("90H", "Peeping Tom", "Group B"),
    ("90I", "Runaway", "Group B"),
    ("90J", "Trespass of Real Property", "Group B"),
    ("90Z", "All Other Offenses", "Group B"),
]

def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default="/opt/nibrs/nibrs.db")
    args = parser.parse_args()

    conn = sqlite3.connect(args.db, timeout=30)
    conn.execute("PRAGMA busy_timeout=30000")

    conn.execute("""
        CREATE TABLE IF NOT EXISTS nibrs_offense_codes (
            code TEXT PRIMARY KEY,
            offense_name TEXT,
            category TEXT
        )
    """)
    conn.execute("DELETE FROM nibrs_offense_codes")
    conn.executemany(
        "INSERT INTO nibrs_offense_codes VALUES (?, ?, ?)",
        CODES,
    )
    conn.commit()
    cnt = conn.execute("SELECT COUNT(*) FROM nibrs_offense_codes").fetchone()[0]
    print(f"Built nibrs_offense_codes: {cnt} rows")
    conn.close()

if __name__ == "__main__":
    main()
