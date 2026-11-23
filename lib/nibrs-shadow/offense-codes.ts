/**
 * The NIBRS offense codes, from the FBI's 2025.0 NIBRS User Manual (section 2.3, Group A and Group B offense listing).
 * Used only for the fixed, count-free answers to questions about the codes themselves (coverage.ts, shape "codes").
 * `fed`: reported by federal and tribal agencies only. `retired`: the year the FBI removed it from Group B.
 */
export type OffenseCode = { code: string; name: string; group: "A" | "B"; against: "Person" | "Property" | "Society" | "Not a Crime" | null; fed?: true; retired?: number };

const A = (code: string, name: string, against: OffenseCode["against"], fed?: true): OffenseCode => ({ code, name, group: "A", against, ...(fed ? { fed } : {}) });
const B = (code: string, name: string, fed?: true, retired?: number): OffenseCode => ({ code, name, group: "B", against: null, ...(fed ? { fed } : {}), ...(retired ? { retired } : {}) });

export const OFFENSE_CODES: OffenseCode[] = [
  A("09A", "Murder and Nonnegligent Manslaughter", "Person"), A("09B", "Negligent Manslaughter", "Person"), A("09C", "Justifiable Homicide", "Not a Crime"),
  A("100", "Kidnapping/Abduction", "Person"),
  A("101", "Treason", "Society", true), A("103", "Espionage", "Society", true),
  A("11A", "Rape", "Person"), A("11B", "Sodomy", "Person", true), A("11C", "Sexual Assault With An Object", "Person", true), A("11D", "Criminal Sexual Contact", "Person"),
  A("120", "Robbery", "Property"),
  A("13A", "Aggravated Assault", "Person"), A("13B", "Simple Assault", "Person"), A("13C", "Intimidation", "Person"),
  A("200", "Arson", "Property"), A("210", "Extortion/Blackmail", "Property"), A("220", "Burglary/Breaking & Entering", "Property"),
  A("23A", "Pocket-picking", "Property"), A("23B", "Purse-snatching", "Property"), A("23C", "Shoplifting", "Property"), A("23D", "Theft From Building", "Property"),
  A("23E", "Theft From Coin-Operated Machine or Device", "Property"), A("23F", "Theft From Motor Vehicle", "Property"),
  A("23G", "Theft of Motor Vehicle Parts or Accessories", "Property"), A("23H", "All Other Larceny", "Property"),
  A("240", "Motor Vehicle Theft", "Property"), A("250", "Counterfeiting/Forgery", "Property"),
  A("26A", "False Pretenses/Swindle/Confidence Game", "Property"), A("26B", "Credit Card/Automated Teller Machine Fraud", "Property"), A("26C", "Impersonation", "Property"),
  A("26D", "Welfare Fraud", "Property"), A("26E", "Wire Fraud", "Property"), A("26F", "Identity Theft", "Property"), A("26G", "Hacking/Computer Invasion", "Property"),
  A("26H", "Money Laundering", "Society", true),
  A("270", "Embezzlement", "Property"), A("280", "Stolen Property Offenses", "Property"), A("290", "Destruction/Damage/Vandalism of Property", "Property"),
  A("30A", "Illegal Entry into the United States", "Society", true), A("30B", "False Citizenship", "Society", true), A("30C", "Smuggling Aliens", "Society", true), A("30D", "Re-entry after Deportation", "Society", true),
  A("35A", "Drug/Narcotic Violations", "Society"), A("35B", "Drug Equipment Violations", "Society"),
  A("360", "Failure to Register as a Sex Offender", "Society", true), A("36A", "Incest", "Person"), A("36B", "Statutory Rape", "Person"),
  A("370", "Pornography/Obscene Material", "Society"),
  A("39A", "Betting/Wagering", "Society"), A("39B", "Operating/Promoting/Assisting Gambling", "Society"), A("39C", "Gambling Equipment Violations", "Society"), A("39D", "Sports Tampering", "Society"),
  A("40A", "Prostitution", "Society"), A("40B", "Assisting or Promoting Prostitution", "Society"), A("40C", "Purchasing Prostitution", "Society"),
  A("49A", "Harboring Escapee/Concealing from Arrest", "Society", true), A("49B", "Flight to Avoid Prosecution", "Society", true), A("49C", "Flight to Avoid Deportation", "Society", true),
  A("510", "Bribery", "Property"), A("520", "Weapon Law Violations", "Society"), A("521", "Violation of National Firearm Act of 1934", "Society", true),
  A("522", "Weapons of Mass Destruction", "Society", true), A("526", "Explosives", "Society", true),
  A("58A", "Import Violations", "Society", true), A("58B", "Export Violations", "Society", true),
  A("61A", "Federal Liquor Offenses", "Society", true), A("61B", "Federal Tobacco Offenses", "Society", true), A("620", "Wildlife Trafficking", "Society", true),
  A("64A", "Human Trafficking, Commercial Sex Acts", "Person"), A("64B", "Human Trafficking, Involuntary Servitude", "Person"),
  A("720", "Animal Cruelty", "Society"),
  B("90B", "Curfew/Loitering/Vagrancy Violations"), B("90C", "Disorderly Conduct"), B("90D", "Driving Under the Influence"), B("90F", "Family Offenses, Nonviolent"),
  B("90G", "Liquor Law Violations"), B("90J", "Trespass of Real Property"), B("90Z", "All Other Offenses"),
  B("90K", "Failure to Appear", true), B("90L", "Federal Resource Violations", true), B("90M", "Perjury", true),
  B("90A", "Bad Checks", undefined, 2021), B("90E", "Drunkenness", undefined, 2021), B("90H", "Peeping Tom", undefined, 2021), B("90I", "Runaway", undefined, 2008),
];

/** The codes in force today (not retired), in code order: digits before letters, as the FBI lists them. */
export const CURRENT_CODES = OFFENSE_CODES.filter((c) => !c.retired).sort((a, b) => a.code.localeCompare(b.code));
