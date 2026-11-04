"""Draft a label for every logged question (coordinator for Jeff, 2026-11-04: "100% answered correctly -- however correct
is defined"; plan accepted the same day). Each distinct first question per tab, and each distinct follow-up pair, gets
one expected outcome: answer (with its source), clarify (with what is asked) or decline (with the plain reason).

The labels come from written rules over the question's own words and the agency list (a gazetteer), never from the
engine's output, so scoring the engine against them is not circular. The rules are numbered (R01...) and each label
names the rule that made it. Every label here is a draft until reviewed; a rule's open question is "disputed" and listed
for Jeff (docs/reports/qlog-scorecard.md).

  python scripts/draft-qlog-labels.py --extract <qlog_all.json> --synthetic <script_strings.json> --local <out.json>

The extract (the production query log, read-only) stays outside the repo. The repo gets
scripts/fixtures/answer-eval/qlog-labels.json: the labels keyed by a hash of the normalized question, with the question
as written and, for a follow-up, the turn before it (Jeff 2026-11-04: "Redacted text OK", then "there's no PII in
there": text as written; a grep for anything like a credential or token runs before each PR).

"First question" (coordinator 2026-11-04): the first row of each session in each tab; every later row of that session
in that tab is a follow-up to the row before it.
"""
import argparse, collections, hashlib, json, re

ap = argparse.ArgumentParser()
ap.add_argument("--extract", required=True)
ap.add_argument("--synthetic", required=True)
ap.add_argument("--local", required=True)
ap.add_argument("--agencies", default="scripts/fixtures/nibrs-shadow/agencies.json")
ap.add_argument("--out", default="scripts/fixtures/answer-eval/qlog-labels.json")
args = ap.parse_args()

norm = lambda q: " ".join(q.lower().split()).rstrip("?.! ")
qhash = lambda q: hashlib.sha256(norm(q).encode("utf-8")).hexdigest()[:10]
R = lambda p: re.compile(p, re.I)

TAB_SOURCE = {"historical": "historical", "current": "rtci", "nibrs": "nibrs", "shr": "shr", "hate_crime": "hate_crime"}
TAB_SHORT = {"historical": "hist", "current": "ct", "nibrs": "nibrs", "shr": "shr", "hate_crime": "hc"}

# ---------------------------------------------------------------------------------------------- word lists
NOT_A_QUESTION = R(r"^(?:hi|hello|hey|test(?:ing)?|thanks?|thank you|ok|okay|yes|no|asdf+|\?+|\.+)$")
COURT = R(r"\b(?:convict\w*|sentenc\w*|prosecut(?!ion declined)\w*|court\w*|trial\w*|jail\w*|prison\w*|incarcerat\w*|recidiv\w*|parole|probation|plea|bail|defendants?)\b")
WHY = R(r"^(?:why\b)|\b(?:(?:effect|impact|influence) of|because of|due to|correlat\w*|what caused|what causes|cause[sd]? (?:the|of|by)|reasons? (?:for|why)|due to what|explain why)\b")
PREDICT = R(r"\b(?:predict\w*|forecast\w*|projection|will (?:\w+ ){0,4}(?:go|be|rise|fall|increase|decrease)|next year|in 20(?:2[7-9]|[3-9]\d))\b")
OPINION = R(r"\b(?:should\b|recommend\w*|is it safe|safe to (?:live|move|visit)|best place|worth moving|policy (?:work|effect)\w*|effective)\b")
UNRELATED = R(r"\b(?:weather|stock|joke|poem|recipe|write (?:a|an|me) (?:story|poem|essay)|who (?:is|was) the (?:president|mayor|governor))\b")
BELOW = R(r"\b(?:\d+(?:st|nd|rd|th) district|congressional districts?|neighbou?rhoods?|zip ?codes?|census tracts?|blocks?|addresse?s?|street address|precincts?|beats?|wards?|districts? \d+)\b")
METHOD = R(r"^(?:what|how|why|is|are|does|do|explain|define|where)\b.*\b(?:mean(?:s|ing)?|definition|define[ds]?|included|includes?|counts? as|considered|calculat\w*|methodolog\w*|difference between|data come|source of|data source|how accurate|missing)\b")
LOOKUP = R(r"\b(?:scope of|what data|do you have (?:any )?(?:data|numbers|figures|information)|list of (?:\w+ ){0,3}(?:agencies|departments)|which (?:jurisdictions|agencies|cities|states) (?:are )?included|which agencies (?:report|are)|what agencies|agencies reported|what (?:years|cities|states|agencies|crimes|offenses) (?:are|do|does|is)|what (?:can|do) you|data (?:available|coverage)|participat\w*|report(?:s|ed|ing)? to (?:nibrs|the fbi)|(?:offense|penal) codes?)\b")
CRIME = R(r"stab\w*|officers?|staffing|police employees|sworn|dangerous|safest|fentanyl|meth|cocaine|heroin|opioid|marijuana|seizures?|murder|homicid|kill|robber|burglar|assault|rape|theft|larceny|arson|carjack|shoot|violen|property crime|crime|offen[cs]e|drug|narcotic|dui|hate|bias|vandal|fraud|motor vehicle|auto theft|car theft|stolen|shoplift|arrest|clear|weapon|gun|firearm|sex(?:ual)? offen|traffick|kidnap|extortion|bribery|embezzle|counterfeit|forger|prostitut|gambling|pornograph|animal cruel|stalk|intimidat|domestic|victim|offender|incident")
NATIONAL = R(r"\b(?:national(?:ly)?|nationwide|united states|u\.?s\.?a?\b|america(?:n)?|the country|the nation|all states|every state|each state|across states|by state|states)\b")
STATE_NAMES = ["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "district of columbia", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan", "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york", "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota", "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming", "puerto rico", "guam"]
STATE_ABBR = "AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR GU".split()
STATE_RE = re.compile(r"\b(?:" + "|".join(STATE_NAMES) + r")\b(?!\s+(?:county|parish|township|city|heights|park)\b(?!\s+(?:agenc|police|sheriff|department)\w*))", re.I)
ABBR_RE = re.compile(r"(?:,\s*|\b)(?:" + "|".join(STATE_ABBR) + r")\b")   # case-sensitive: "IN", "OR" only as capitals
# A set of places picked by size, rank or a rule is a place ("the ten largest cities", "which state has the most").
PLACE_SET = R(r"\b(?:top \d+|top (?:five|ten|twenty)|(?:\d+|five|ten|twenty) (?:largest|biggest|most populous|safest|most dangerous)|largest cities|biggest cities|most populous|which (?:city|cities|state|states|county|counties|agenc\w+|town|place)|what (?:city|cities|state|states|county|counties|town)|cities|counties|agencies (?:reporting|that)|consistent reporters|all agencies|major cities|large cities|big cities|jurisdictions|departments)\b")
# Common short names of big cities and their departments.
PLACE_ABBR = re.compile(r"\b(?:nyc|NYC|LA|DC|D\.C\.|SF|philly|nola|NOLA|nopd|NOPD|lapd|LAPD|nypd|NYPD|mpd|MPD|cpd|CPD|sfpd|SFPD|dcpd|DCPD|chi-?town)\b")
REGION = R(r"\b(?:midwest|northeast|south(?:east|west)?|west coast|east coast|new england|pacific northwest|mountain west|sun ?belt|rust ?belt)\b")
FOREIGN = R(r"\b(?:canada|mexico|england|britain|united kingdom|\buk\b|london|paris,? france|france|germany|berlin|italy|spain|japan|tokyo|china|india|brazil|australia|toronto|vancouver|montreal|ontario|quebec|europe|africa|russia|ukraine|ireland|scotland|israel|nigeria|jamaica|philippines|el salvador|honduras|guatemala|colombia|venezuela)\b")
MONTHS = r"(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)"
PERIOD = R(r"\b(?:1[89]\d\d|20[0-3]\d)s?\b|\b(?:the )?(?:fifties|sixties|seventies|eighties|nineties)\b|\b(?:since|as far back|as many years as|all (?:available )?years|every year available|all available|full history|this year|last year|ytd|year[- ]to[- ]date|so far this year|(?:last|past) (?:\d+|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty|fifty|few|several|couple of) (?:years?|months?|decades?)|(?:last|past) (?:year|decade|month|quarter)|rolling(?: over)? (?:12|twelve)(?:[- ]months?)?|(?:12|twelve)[- ]month rolling|latest (?:year|month|data|figures?)|most recent (?:year|month|data|figures?))\b")
HATE = R(r"\bhate\b|\bbias\b|anti-?(?:black|white|jewish|semit|muslim|islam|asian|hispanic|latino|gay|lesbian|trans|lgbt)")
SHR_DETAIL = R(r"\b(?:(?:(?:black|white|asian|hispanic|latino|native american)s?\s+(?:victims?|people|men|women|males?|females?|offenders?|suspects?|americans?|children|teens?|youths?)|blacks|whites|asians|hispanics|latinos|women|females?|males?|\bmen\b|children|teens?|juveniles?)|handguns?|rifles?|shotguns?|gang\w*|domestic|intimate|spouses?|family|circumstance|relationship|weapon|gun|firearm|knife|victim(?:s|'s)? (?:race|sex|age)|offender(?:s|'s)? (?:race|sex|age)|by (?:race|sex|age))\b")
MURDER = R(r"murder|homicid")
SHOOTING = R(r"\bshootings?\b|\bshot\b|gun violence")
NEW_YORK = re.compile(r"\bnew york\b(?!\s+(?:city|state|county|police|pd|nypd))", re.I)
SERIES = R(r"\b(?:per year|by year|each year|every year|yearly|annual(?:ly)?|per month|by month|monthly|over time|trends?|trending|history|historical(?:ly)?)\b")
STAFF = R(r"\b(?:officers?|staffing|police employees|sworn|civilian employees)\b")
PART1 = R(r"stolen (?:car|vehicle|auto)s?|murder|homicid|\brape|robber|aggravated assault|agg(?:ravated)? assault|burglar|larcen|theft|motor vehicle|auto theft|car theft|arson|violent crime|property crime|part (?:i|1|one)|index crime|clearance rate|crime rate|crimes?\b")
NIBRS_DETAIL = R(r"\b(?:(?:(?:black|white|asian|hispanic|latino|native american)s?\s+(?:victims?|people|men|women|males?|females?|offenders?|suspects?|americans?|children|teens?|youths?)|blacks|whites|asians|hispanics|latinos|women|females?|males?|\bmen\b|children|teens?|juveniles?)|handguns?|rifles?|shotguns?|gang\w*|offenders?|suspects?|race|sex|gender|age group|by age|ages?|juvenile|teen|adult|location|residence|stolen (?:property|goods|items|guns|firearms)|property (?:stolen|value|loss|type)|drugs?|narcotics?|value|clearance type|exceptional|prosecution declined|cleared by|arrests?|arrestees?|relationship|stranger|domestic|intimate|weapon|firearm|gun|knife|drug type|fentanyl|meth\w*|cocaine|heroin|marijuana|opioid|group b|simple assault|intimidation|fraud|shoplift\w*|vandal\w*|kidnap\w*|traffick\w*|carjack\w*|vehicle burglar\w*|theft from (?:a |an )?(?:motor )?(?:vehicles?|autos?|cars?)|car break-?ins?|victims? (?:by|of)|incidents? (?:by|with))\b")
MONTHLY = R(r"\b(?:(?:through|thru|until|to|from|in) " + MONTHS + r")\b|\b(?:month|monthly|by month|per month|ytd|year[- ]to[- ]date|rolling|this year|so far|last 12 months|last twelve months|past 12 months|recent months|quarter\w*|weekly)\b|^(?!.*\b(?:by year|per year|annual\w*|yearly|each year|since (?:19|20)\d\d|from (?:19|20)\d\d)\b).*\b2026\b")
BARE_CRIME = R(r"\bcrimes?\b|\bcrime (?:rate|stats|statistics|data)\b|\bdangerous\b|\bsafest\b")
SPECIFIC = R(r"violen|property|murder|homicid|kill|robber|burglar|assault|rape|theft|larceny|arson|carjack|shoot|drug|narcotic|dui|hate|vandal|fraud|motor vehicle|stolen|shoplift|arrest|clear|weapon|gun|firearm|sex(?:ual)?|traffick|kidnap|officers?|staffing|sworn|part (?:i|1|one)|index crime|all (?:offenses|crimes)|total (?:offenses|crimes)")
FOLLOW_LEAD = R(r"^(?:no,? |yes,? |and\b|also\b|now\b|then\b|ok\b|okay\b|same\b|instead\b|what about|how about|this is not|can you (?:make|change|show|put|do|add|remove|switch|break|split|graph|chart|plot)|make (?:it|this|that)|change (?:it|this|that)|show (?:it|this|that)|just\b|only\b|exclude|include|redo|again|that\b|this\b|those\b|these\b|it\b|per capita|by year|by month|as a (?:rate|chart|table)|and what)")
PRESENTATION = R(r"\b(?:bar chart|line chart|pie chart|chart|graph|plot|table|csv|download|export|bigger|smaller|color)\b")
YEAR = re.compile(r"\b(?:1[89]\d\d|20[0-3]\d)\b")

# ---------------------------------------------------------------------------------------------- the gazetteer
# Agency names that occur in more than one state: a question naming one with no state is asked about (R11). Only
# names of 4+ letters that are cities or counties, so "Clinton" is ambiguous and "Ada" is not read as a place at all.
agencies = json.load(open(args.agencies, encoding="utf-8"))["agencies"]
states_of = collections.defaultdict(set)
pop_of = collections.defaultdict(lambda: collections.defaultdict(int))
for a in agencies:
    if a.get("kind") not in ("city", "county"):
        continue
    for n in {a["name"].lower(), *(x.lower() for x in (a.get("aliases") or []))}:
        if len(n) >= 4:
            states_of[n].add(a["state"])
            pop_of[n][a["state"]] = max(pop_of[n][a["state"]], a.get("population") or 0)

def ambiguous(name):
    """Several states have it and none is plainly the one meant: the largest is not at least five times the next."""
    ps = sorted(pop_of[name].values(), reverse=True)
    return len(ps) > 1 and ps[0] < 5 * max(ps[1], 1)
# Only names of real size are taken as the place a question names (a single-word city of population 25,000+, or any
# multi-word name), so ordinary words that are also tiny towns ("Justice", "Commerce") are not read as places.
big = {n.lower() for a in agencies if a.get("kind") in ("city", "county") and (a.get("population") or 0) >= 25000
       for n in [a["name"], *(a.get("aliases") or [])] if len(n) >= 4}
multi = {n for n in states_of if " " in n}
PLACE_NAMES = sorted(big | multi, key=len, reverse=True)
PLACE_RE = re.compile(r"\b(?:" + "|".join(re.escape(n) for n in PLACE_NAMES) + r")\b", re.I)

def places(q):
    return [m.group(0).lower() for m in PLACE_RE.finditer(q)] + (["(abbreviation)"] if PLACE_ABBR.search(q) else [])

WORDLIKE = {"IN", "OR", "ME", "HI", "OH", "OK", "ID", "MA", "AL", "DE", "LA", "CO", "PA", "MO", "NE", "WA", "GA", "SC"}
ABBR_AFTER = re.compile(r",\s*(?:" + "|".join(STATE_ABBR) + r")\b|\b(?:" + "|".join(re.escape(n) for n in PLACE_NAMES) + r")\s+(?:" + "|".join(a for a in STATE_ABBR if a not in WORDLIKE) + r")\b", re.I)

# Misspellings: common ones of crime words, and a place name after "in", "for", "of" or "at" that is close to a
# gazetteer name of the same number of words (difflib ratio 0.85 or more; words of five letters or more).
TYPOS = {"homocide": "homicide", "homocides": "homicides", "homicde": "homicide", "murdur": "murder", "murderes": "murders", "robery": "robbery",
         "roberies": "robberies", "burglery": "burglary", "burgalry": "burglary", "assult": "assault", "assualt": "assault", "agravated": "aggravated",
         "aggrevated": "aggravated", "larcency": "larceny", "vehical": "vehicle", "violant": "violent", "voilent": "violent"}
import difflib
ONE_WORD = sorted({n for n in PLACE_NAMES if " " not in n})
TWO_WORD = sorted({n for n in PLACE_NAMES if n.count(" ") == 1})
def spelled(q):
    """Common misspellings, and a place name after "in", "for", "of" or "at" close to a gazetteer name. One word is
    matched at a time and the next word only looked at, so nothing is consumed ("of women in phialdelphia")."""
    out = re.sub(r"[A-Za-z]+", lambda m: TYPOS.get(m.group(0).lower(), m.group(0)), q)
    COMMON = {"in", "for", "of", "at", "by", "since", "from", "the", "and", "per", "during", "with", "to", "through", "over", "between", "vs", "versus", "compared", "murders", "crime", "crimes"}
    known = lambda w: bool(PLACE_RE.fullmatch(w) or STATE_RE.fullmatch(w))
    def close(w, pool):
        if len(w) < 5 or known(w):
            return None
        best = difflib.get_close_matches(w.lower(), pool, n=1, cutoff=0.8 if len(w) >= 8 else 0.85)
        return best[0] if best else None
    def fix(m):
        one, nxt = m.group(2), m.group(3)
        if known(one):
            return m.group(0)
        # Two words first ("new orlens" -> "new orleans"); the next word stays in the text after it.
        if nxt and nxt.lower() not in COMMON and not known(one + " " + nxt):
            two = close(one + " " + nxt, TWO_WORD)
            if two:
                return m.group(1) + two + " "
        best = close(one, ONE_WORD)
        return m.group(1) + best if best else m.group(0)
    return re.sub(r"(\b(?:in|for|of|at)\s+)([A-Za-z]+)(?=\s+([A-Za-z]+)|)", fix, out)

def has_state(q):
    return bool(STATE_RE.search(q) or ABBR_RE.search(q) or ABBR_AFTER.search(q))

# ---------------------------------------------------------------------------------------------- the rules
def label_first(q, tab):
    """One question with no earlier turn: (outcome, detail, source, rule, status, note)."""
    n = norm(q)
    if NOT_A_QUESTION.match(n) or len(n) < 3:
        return ("exclude", "not a question", None, "R01", "draft", "a greeting, a test or a single word")
    if UNRELATED.search(q):
        return ("decline", "not about crime data", None, "R03", "draft", "")
    if COURT.search(q) and not R(r"\barrest").search(q):
        return ("decline", "court outcomes and corrections are not in this data", None, "R03", "draft", "")
    if WHY.search(q):
        return ("decline", "the data says what was reported, not why", None, "R03", "draft", "")
    if PREDICT.search(q):
        return ("decline", "the data has no future figures", None, "R03", "draft", "")
    if OPINION.search(q):
        return ("decline", "the data reports figures, not advice or safety judgments", None, "R03", "draft", "")
    if FOREIGN.search(q):
        return ("decline", "the data covers U.S. agencies only", None, "R05", "draft", "")
    if BELOW.search(q):
        return ("decline", "the data goes down to the agency, not below it", None, "R04", "draft", "")
    named0 = places(spelled(q))
    if R(r"clearance rates?|percent(?:age)? cleared").search(q) and (STATE_RE.search(q) or ABBR_RE.search(q)) and not named0 and not NATIONAL.search(q):
        return ("decline", "there is no state clearance rate in the data", None, "R15", "draft", "P18")
    if R(r"\brates?\b|per capita|per 100").search(q) and R(r"\b(?:age groups?|by age|by race|by sex|for (?:black|white|hispanic|asian)s?|(?:black|white|hispanic|asian|juvenile|youth|teen|female|male)s? (?:victims?|offenders?|people|residents|population|crime))\b").search(q):
        return ("decline", "rates are for places, not groups of people (counts or shares instead)", None, "R15", "draft", "D03")
    if R(r"calls? for service|911 calls|dispatch(?:es)?").search(q):
        return ("decline", "there are no calls-for-service data", None, "R15", "draft", "P47")
    if METHOD.search(q):
        return ("answer", "the FBI's definition, named as the FBI's", TAB_SOURCE.get(tab), "R06", "draft", "D1 (Jeff 2026-11-04): FBI definitions")
    if LOOKUP.search(q) and not (CRIME.search(q) and R(r"\b(?:most|highest|lowest|least|top|rank\w*)\b").search(q)):
        return ("answer", "a lookup (coverage, codes, agency list)", TAB_SOURCE.get(tab), "R07", "draft", "a capability gap today")
    # Misspellings the engine reads ("new orlens", "homocide") are read here too, so a label never asks about a part
    # the question does name.
    q = spelled(q)
    crime = bool(CRIME.search(q))
    named = places(q)
    scope = bool(named) or has_state(q) or bool(NATIONAL.search(q)) or bool(REGION.search(q))
    # No crime and no place, or no crime and words that point back ("now detroit", "how about the national average"):
    # a follow-up asked first, or too short to read. The whole question is asked for.
    if not crime and (not scope or FOLLOW_LEAD.search(q.strip())):
        return ("clarify", "the whole question", None, "R08", "draft", "no crime, and no place or a word pointing back")
    # Every part that is missing, in the order D31 asks them; the engine may ask any of them first (one at a time), so
    # each is a right question to ask. A set of places with no state or nation named ("the cities with the most
    # murders") is missing its scope: the place is asked (P12).
    missing = []
    if not crime:
        missing.append("crime")
    elif tab != "hate_crime" and BARE_CRIME.search(q) and not SPECIFIC.search(q):
        missing.append("violent, property or both")
    if not scope:
        missing.append("place")
    elif named and not has_state(q) and not NATIONAL.search(q):
        amb = [p for p in named if ambiguous(p)]
        if amb and len(named) == 1:
            missing.append(f"which {amb[0].title()}")
    if SHOOTING.search(q) and not R(r"fatal|homicid|murder|killed|deaths?|injur|aggravated").search(q):
        missing.insert(0, "fatal or non-fatal shootings")
    if NEW_YORK.search(q) and not has_state(q.replace("New York", "").replace("new york", "")) and not any(p for p in named if p != "new york"):
        missing.append("which New York")
    if not PERIOD.search(q) and not SERIES.search(q):
        missing.append("period")
    if missing:
        rule = {"crime": "R09", "violent, property or both": "R09b", "place": "R10", "period": "R13", "fatal or non-fatal shootings": "R09s", "which New York": "R11"}.get(missing[0], "R11")
        note = {"R09": "D31", "R09b": "D09", "R09s": "D14", "R10": "P12/D31", "R13": "P06/D31", "R11": "several places have this name (P26 for New York)"}[rule]
        return ("clarify", " / ".join(missing), None, rule, "draft", note)
    years = [int(y) for y in YEAR.findall(q)]
    if years and max(years) > 2026:
        return ("decline", "the data has no future figures", None, "R12", "draft", "")
    # The source, by what is asked (R14):
    #   hate or bias words: Hate Crime;
    #   a state's or the nation's murder by a Homicide Report detail, NIBRS not named: Homicide Reports (P53);
    #   NIBRS named, or a NIBRS-only detail (a person's attributes, location, property, clearance type, arrests by
    #   age, relationship, weapon, drug type...): NIBRS;
    #   a Part I crime's count or rate by month, year to date, rolling or this year: Current Trends;
    #   a Part I crime's count or rate by year: Historical (Crime Index), from any tab (P75-P79); a Homicide Reports
    #   tab's plain murder count this way is disputed (D3: Crime Index or SHR);
    #   otherwise the tab's own source.
    if HATE.search(q):
        return ("answer", "", "hate_crime", "R14", "draft", "")
    if STAFF.search(q) and not PART1.search(q):
        return ("answer", "", "historical", "R14", "draft", "staffing (Crime Index)")
    nibrs_named = bool(R(r"\bnibrs\b").search(q))
    if MURDER.search(q) and SHR_DETAIL.search(q) and not named and not nibrs_named:
        return ("answer", "", "shr", "R14", "draft", "P53")
    if nibrs_named or NIBRS_DETAIL.search(q):
        return ("answer", "", "nibrs", "R14", "draft", "a NIBRS detail (an agency's murder detail too: P53)")
    if PART1.search(q):
        if MONTHLY.search(q):
            return ("answer", "", "rtci|nibrs", "R14", "draft", "a Part I figure by month (Current Trends, or NIBRS where it lacks the place)")
        if PLACE_SET.search(q):
            return ("answer", "", "historical|nibrs", "R14", "draft", "a ranking or set of places (Crime Index or NIBRS)")
        if tab == "shr" and MURDER.search(q):
            return ("answer", "", "historical", "R14", "draft", "D3 (Jeff 2026-11-04): a Homicide Reports tab's plain murder count is Historical's")
        return ("answer", "", "historical", "R14", "draft", "a Part I figure by year (Crime Index)")
    return ("answer", "", TAB_SOURCE.get(tab), "R14", "draft", "")


def complete(q):
    q = spelled(q)
    return bool(CRIME.search(q)) and bool(places(q) or has_state(q) or NATIONAL.search(q)) and bool(PERIOD.search(q))


def stands_alone(q):
    return bool(CRIME.search(q)) and (bool(places(q)) or has_state(q) or bool(NATIONAL.search(q)) or bool(REGION.search(q)) or bool(PLACE_SET.search(q))) and not FOLLOW_LEAD.search(q.strip())


def label_follow(prev_label, q, tab):
    """A later turn: a question of its own is labeled as a first question (F1); otherwise it is read with the turn before."""
    if stands_alone(q) or complete(q) or prev_label[3].split("+")[-1] in ("R06", "R07"):
        o = label_first(q, tab)
        return o[:3] + ("F1+" + o[3], o[4], o[5])
    if PRESENTATION.search(q) and len(q.split()) <= 8 and not (places(q) or has_state(q) or PERIOD.search(q)):
        return ("answer", "the same data, shown another way", prev_label[2], "F2", "draft", "presentation only")
    if prev_label[0] == "answer":
        src = "nibrs" if NIBRS_DETAIL.search(q) and prev_label[2] in ("historical", "rtci") else prev_label[2]
        return ("answer", "the earlier question, changed as asked", src, "F3", "draft", "a follow-up to an answerable question")
    if prev_label[0] == "clarify":
        return ("exclude", "a reply to the old app's clarifying question", None, "F4", "draft", "D4 (Jeff 2026-11-04): left out")
    return ("clarify", "the whole question", None, "F5", "draft", "a follow-up to a question that was declined or excluded")


# ---------------------------------------------------------------------------------------------- run
rows = json.load(open(args.extract, encoding="utf-8"))
synthetic = {norm(s) for s in json.load(open(args.synthetic, encoding="utf-8"))}
firsts, follows = {}, {}
for r in rows:
    tab, q = r.get("tab"), (r.get("question") or "").strip()
    if tab not in TAB_SOURCE or not q or norm(q) in synthetic:
        continue
    if r["n"] == 1 or not r.get("previous"):
        k = (tab, qhash(q))
        firsts.setdefault(k, {"q": q, "times": 0})["times"] += 1
    else:
        k = (tab, qhash(r["previous"]), qhash(q))
        follows.setdefault(k, {"q": q, "prev": r["previous"].strip(), "times": 0})["times"] += 1

local, repo = [], []
def emit(kind, tab, h, q, times, o, prev=None, prev_h=None):
    outcome, detail, source, rule, status, note = o
    lid = f"QL-{TAB_SHORT[tab]}-{h}" if kind == "first" else f"QL-{TAB_SHORT[tab]}-{prev_h[:5]}{h[:5]}"
    expected = {"outcome": outcome, "source": source.split("|")[0] if source else None}
    if source and "|" in source:
        expected["source_any"] = source.split("|")
    if outcome == "decline": expected["reason"] = detail
    elif outcome == "clarify":
        # The first missing part (D31's order), and every missing part: asking about any of them is right.
        expected["about"] = detail.split(" / ")[0]
        expected["about_any"] = detail.split(" / ")
    elif outcome == "answer":
        expected["answer"] = detail or "the figures asked for"
        expected["meaning"] = None
        expected["values"] = {"status": "pending"}
    rec = {"id": lid, "tab": tab, "kind": kind, "hash": h, "previous_hash": prev_h, "times": times, "question": q, "previous": prev,
           "expected": expected, "label": {"status": status, "rule": rule, "drafted_by": "rules-v1", "reviewed_by": None, "notes": note}}
    repo.append(rec)
    local.append(rec)

first_label = {}
for (tab, h), v in sorted(firsts.items()):
    o = label_first(v["q"], tab)
    first_label[(tab, h)] = o
    emit("first", tab, h, v["q"], v["times"], o)
for (tab, ph, h), v in sorted(follows.items()):
    prev_o = first_label.get((tab, ph)) or label_first(v["prev"], tab)
    emit("follow-up", tab, h, v["q"], v["times"], label_follow(prev_o, v["q"], tab), v["prev"], ph)

# Ids are unique (a follow-up id joins both hashes; a clash is a bug, never silently merged).
ids = collections.Counter(r["id"] for r in repo)
assert all(c == 1 for c in ids.values()), [i for i, c in ids.items() if c > 1][:5]
json.dump(local, open(args.local, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
json.dump({"about": "Draft labels for every logged question (coordinator 2026-11-04). Keyed by a hash of the normalized question, with the question as written. Made by scripts/draft-qlog-labels.py (rules-v1).",
           "labels": repo}, open(args.out, "w", encoding="utf-8", newline="\n"), ensure_ascii=False, indent=1)
c = collections.Counter((r["tab"], r["kind"], r["expected"]["outcome"]) for r in repo)
for k in sorted(c): print(*k, c[k])
print("status", collections.Counter(r["label"]["status"] for r in repo))
print("rules", sorted(collections.Counter(r["label"]["rule"] for r in repo).items()))
