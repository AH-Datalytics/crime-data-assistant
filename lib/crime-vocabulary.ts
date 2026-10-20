/**
 * This product's crime and data vocabulary, used for exactly one decision: whether a candidate span in the typo-tolerant
 * place fallback (`fuzzyFallbackMention` in lib/geo-place-resolver.ts) is a crime-data term rather than a misspelled
 * place name. It extends the ordinary-English guard (lib/english-common-words.ts) without changing that list, which
 * has a second consumer (lib/shr-request-accounting.ts) that this change must not affect.
 *
 * THE MEASURED DEFECT (2026-10-20, live release a45a209). The fallback only runs when a question names no exact place,
 * i.e. mostly national questions. It then fuzzy-matched crime words to towns one edit away: "hate" -> Fate, TX (which
 * declined the release-cb HC1 question), "crime" -> Crane, MO, "theft" -> Taft, CA, "drugs" -> Driggs, ID, "gambling"
 * -> Grambling, LA, "clearance" -> Clarence, IA, and others: 14 of 105 probed words, in 154 of 1,575 probed phrasings
 * ("Increase in crime nationally", "Number of thefts by year", "locations of hate crimes").
 *
 * WHERE THE WORDS COME FROM (not from the collisions). CODEBOOK_WORDS is every word (letters only, at least 3
 * characters) of the FBI CDE codebook label columns this repo ships in scripts/fixtures/cde (offense names and
 * categories, crime_against, weapon, location, bias, victim type, relationship, exceptional clearance, property
 * description and loss, suspected drug, ethnicity, race, and the SHR weapon / relationship / circumstance names),
 * minus words already in the ordinary-English list, minus any word that is itself an exact place name (alaska, arab,
 * center, foster, friend, garden, mission, pacific, register, rifle, temple), so this list can never hide a place.
 * scripts/test-phantom-place-guard.ts recomputes it from the fixtures and requires an exact match. PRODUCT_TERMS
 * are the few core subjects of this product's four tabs that the codebook labels do not spell this way.
 *
 * WHAT IT CANNOT DO. It withholds a weak spelling correction for these words; it never removes a place, because exact
 * place matching runs first and is untouched. It does not solve place understanding, and it is not a place-exclusion
 * list: no word is here because a town's name collided with it.
 */

/** Generated from scripts/fixtures/cde (rule above); frozen here, verified by the test. Do not edit by hand. */
const CODEBOOK_WORDS = [
  "abandoned", "abduction", "abortion", "accessories", "acquaintance", "act", "acts", "african", "aggravated",
  "agnosticism", "air", "aircraft", "alcohol", "aliens", "alley", "american", "amphetamines", "amusement",
  "ancestry", "animal", "anti", "appear", "applicable", "arena", "argument", "arguments", "arrest", "arson",
  "artistic", "asian", "asphyxiation", "assault", "assisting", "atheism", "atm", "attack", "auto", "automated",
  "automatic", "automobile", "avoid", "babysittee", "babysitter", "bank", "bar", "barbiturates", "beach", "betting",
  "bias", "bicycles", "bisexual", "black", "blackjack", "blackmail", "blunt", "boyfriend", "brass", "brawl",
  "breaking", "bribery", "brother", "buddhist", "building", "burglary", "burned", "bus", "buses", "business", "camp",
  "campground", "camping", "card", "cards", "casino", "catholic", "checks", "chemicals", "child", "chinese",
  "christ", "christian", "church", "circumstances", "citizenship", "clothes", "club", "cocaine", "cohabitant",
  "coin", "coliseum", "collectibles", "collections", "college", "commercial", "commercialized", "commersical",
  "communications", "community", "computer", "concealing", "condemned", "conduct", "confidence", "conforming",
  "construction", "consumable", "contact", "convenience", "cooperate", "corrections", "counterfeited",
  "counterfeiting", "crack", "credit", "crime", "criminal", "crops", "cruelty", "curfew", "custody", "cutting",
  "cyberspace", "damage", "damaged", "daughter", "daycare", "dealership", "death", "debit", "declined", "department",
  "deportation", "depressants", "destroyed", "destruction", "determination", "device", "disability", "discount",
  "disorderly", "dock", "doctor", "documents", "domestic", "driving", "drop", "drowning", "drug", "drugs",
  "drunkenness", "due", "dwelling", "eastern", "electronic", "elementary", "embezzlement", "employee", "employer",
  "enforcement", "entering", "entry", "equipment", "escapee", "espionage", "etc", "ethnicity", "explosives",
  "export", "extortion", "facility", "facts", "failure", "fairgrounds", "family", "farm", "father", "federal",
  "felony", "female", "field", "financial", "fire", "firearm", "firearms", "fishing", "flight", "forcible", "forged",
  "forgery", "fraud", "freight", "fuel", "furs", "gambling", "game", "gang", "gangland", "garage", "gas", "gay",
  "gender", "girlfriend", "goods", "government", "grandchild", "grandparent", "greek", "grocery", "hacking",
  "hallucingens", "handgun", "hanging", "harboring", "hard", "hashish", "hawaiian", "heroin", "heterosexual",
  "highway", "hindu", "hispanic", "home", "homeless", "homicide", "homosexual", "hospital", "hotel", "household",
  "human", "hunting", "husband", "identity", "illegal", "impersonation", "import", "incendiary", "incest", "indian",
  "individual", "industrial", "influence", "installation", "instances", "institution", "institutional", "instrument",
  "instruments", "intangible", "intimate", "intimidation", "invasion", "inventory", "involuntary", "islamic",
  "islander", "jail", "japanese", "jehovah", "jesus", "jewelry", "jewish", "jurisdiction", "justifiable", "juvenile",
  "kidnapping", "killed", "killings", "knife", "knuckles", "lab", "lake", "lands", "larceny", "latino", "laundering",
  "law", "lawn", "laws", "lesbian", "lethal", "liquor", "livestock", "loan", "logging", "loitering", "lot", "lsd",
  "machine", "male", "mall", "manslaughter", "marijuana", "mass", "material", "materials", "medical", "member",
  "mental", "merchandise", "metals", "meth", "military", "mixed", "modal", "money", "morphine", "mosque", "motel",
  "mother", "motivation", "motor", "multiple", "murder", "musical", "muslim", "narcotic", "narcotics", "national",
  "native", "negligent", "negotiable", "neighbor", "nightclub", "non", "nonnegligent", "nonviolent", "object",
  "obscene", "offender", "offenses", "office", "officer", "operated", "operating", "opium", "optical",
  "organization", "orientation", "orthodox", "otherwise", "parent", "park", "parking", "pcp", "peeping", "pending",
  "penitentiary", "perjury", "permit", "personal", "pets", "photographic", "physical", "picking", "pills",
  "playground", "pocket", "poison", "pornography", "portable", "precious", "pretenses", "prison", "promoting",
  "property", "prosecution", "prostitution", "protestant", "provided", "public", "purchasing", "purse", "pushed",
  "race", "races", "radio", "rape", "recordings", "recovered", "recreational", "refused", "relationship", "religion",
  "religions", "religious", "rental", "residence", "resource", "rest", "restaurant", "road", "robbery", "runaway",
  "russian", "savings", "school", "secondary", "seized", "separate", "service", "servitude", "sex", "sexual",
  "shelter", "shoplifting", "shopping", "shotgun", "sibling", "sidewalk", "sikh", "simple", "single", "sister",
  "site", "sleeping", "smuggling", "snatching", "sniper", "society", "sodomy", "software", "son", "special",
  "specialty", "specified", "sports", "spouse", "stadium", "station", "statutory", "stepchild", "stepdaugther",
  "stepfather", "stepmother", "stepparent", "stepsibling", "stepson", "stimulants", "stolen", "storage", "store",
  "stranger", "strangulation", "street", "structure", "supermarket", "supplies", "suspected", "swindle", "synagogue",
  "tampering", "teller", "terminal", "theft", "thrown", "tobacco", "tom", "tools", "track", "trafficking",
  "trailers", "train", "transgender", "treason", "trespass", "tribal", "trucks", "unarmed", "united", "university",
  "unknown", "vagrancy", "vandalism", "vandalized", "vcr", "vehicle", "vehicles", "vessel", "vice", "victim",
  "violation", "violations", "violence", "wagering", "wallet", "watercraft", "waterway", "weapon", "weapons",
  "welfare", "wharf", "white", "wife", "wildlife", "window", "wire", "witness", "woods", "yard",
] as const;

/** Core subjects of the four tabs that the codebook labels do not spell this way. Each is a product term, not a collision. */
const PRODUCT_TERMS = [
  "hate",        // hate crime (the Hate Crime tab)
  "clearance",   // clearance rates (Historical, SHR)
  "cleared",
  "gun",         // gun / shooting questions (SHR weapon groups, NIBRS firearm)
  "shooting",
  "carjacking",  // NIBRS carjacking tables
  "adult",       // age groups (NIBRS, SHR)
  "age",
  "incident",    // NIBRS counting units
  "offense",
  "america",     // the national scope word ("crime in America"; it is not an exact place in the catalog)
  "ori",         // the FBI agency identifier (ORI)
] as const;

const VOCABULARY: ReadonlySet<string> = new Set<string>([...CODEBOOK_WORDS, ...PRODUCT_TERMS]);

/** Sizes, exposed so a test can pin the lists against silent growth. */
export const CODEBOOK_WORD_COUNT = CODEBOOK_WORDS.length;
export const PRODUCT_TERM_COUNT = PRODUCT_TERMS.length;
/** The frozen codebook words, for the test that recomputes them from the fixtures. */
export const CODEBOOK_WORD_LIST: readonly string[] = CODEBOOK_WORDS;

/**
 * Is `token` (one resolver token key) this product's crime/data vocabulary? Plurals are accepted by a simple singular
 * check (thefts -> theft, robberies -> robbery, crimes -> crime) rather than by listing invented plural forms.
 */
export function isCrimeVocabularyWord(token: string): boolean {
  const t = token.replace(/[^a-z0-9]+/gi, " ").toLowerCase().trim();
  if (!t || t.includes(" ")) return false;
  if (VOCABULARY.has(t)) return true;
  if (t.length > 4 && t.endsWith("ies") && VOCABULARY.has(`${t.slice(0, -3)}y`)) return true;
  if (t.length > 3 && t.endsWith("es") && VOCABULARY.has(t.slice(0, -2))) return true;
  if (t.length > 3 && t.endsWith("s") && VOCABULARY.has(t.slice(0, -1))) return true;
  return false;
}
