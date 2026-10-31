"""Classify the distinct questions of the production query log (a read-only copy) by request shape, the source policy
requires (P01, P53, P57), place level, the correct action (D31/P06, D03) and coverage status. Rule-based, first match
wins; audited by hand and by Codex (docs/reviews/2026-10-30-query-log-coverage-codex).

Usage: python classify_query_log.py <folder>. The folder holds query_log_questions.csv (the copy), script_strings.json
(normalized strings of the repo's scripts, to set synthetic traffic aside) and places.json (the place kinds the repo's
lib/geo-place-resolver.ts finds in each question). Writes classified.json and classification.csv there.
"""
import collections, csv, json, re, sys

D = sys.argv[1].rstrip('/') + '/'
rows = list(csv.DictReader(open(D + 'query_log_questions.csv', encoding='utf-8', newline='')))
synthetic = set(json.load(open(D + 'script_strings.json', encoding='utf-8')))
places = json.load(open(D + 'places.json', encoding='utf-8'))
norm = lambda q: ' '.join(q.lower().split()).rstrip('?. ')
R = lambda p: re.compile(p, re.I)

# ---- redaction: personal details in free text (Codex review 01, finding 1). The question's shape is kept.
REDACT = [(R(r"\b\d{2,5} (?:[a-z.]+ ){0,2}(?:street|avenue|boulevard|drive|road|lane)\b(?: \d{5})?"), "[address redacted]"),
          (R(r"basically i want to see the trends during my time in [a-z .]+"), "[personal detail redacted]"),
          (R(r"my grandma passed recently and she loved"), "[personal detail redacted]:")]
def redact(q):
    for r, w in REDACT: q = r.sub(w, q)
    return q

# ---- words
OUT = R(r"\b(convict|sentenc|dna\b|prosecut(?!ion declined)|court|trial|jail|prison|incarcerat|recidiv|parole|probation|\bplea\b|\bbail\b|why\b|caus(?:e|es|ed|ing)\b|predict|forecast|regress|should\b|recommend|effective|is it safe|risky|weather|stock|election|immigra|illegal alien|undocumented|joke|poem|recipe|recepy|write (?:a|an|me))")
FOLLOW = R(r"^(?:no,? |yes,? |replace|place\b|is it|both\b|not the|give me the percent|and\b|also\b|now\b|then\b|ok\b|okay\b|same\b|instead\b|what about|how about|can you (?:make|change|show|put|do|add|remove|switch|break|split|graph|chart|plot|re-?run)|make (?:it|this|that)|change (?:it|this|that)|show (?:it|this|that)|put\b|just\b|only\b|exclude|include|re-?do|re-?run|again\b|that\b|this\b|those\b|these\b|percent change|per capita|by year|by month|try\b)")
CONTEXT = R(r"\b(?:these (?:cities|agencies|states|numbers|places)|those (?:cities|agencies|states)|the same (?:data|chart|table|query)|the previous|this chart|that chart|this table|that table|above)\b")
CRIME = R(r"murder|homicid|kill|robber|burglar|assault|rape|theft|larceny|arson|carjack|shoot|violen|property crime|crime|offen[cs]e|drug|narcot|dui|dwi|hate|vandal|fraud|motor vehicle|shoplift|arrest|clear|staff|officer|sworn|weapon|gun|firearm")
METHOD = R(r"\b(?:mean(?:s|ing)?|definition|define[ds]?|included|includes?|counts? as|considered|calculat\w*|methodolog\w*|difference between|units\b|data come|where (?:did|do|does) .* (?:get|come)|source of|data source|how accurate|updated?|missing|why (?:is|are|does) .* (?:different|missing|only|not))")
LOOKUP = R(r"\b(?:agencies (?:reported|report|reporting|participat)|(?:offense|pinal|penal) codes?|code for|zip code|census tract|neighborhood|which agencies are in|what agencies (?:are|match)|agencies table|coverage for|not represented|participat\w+)\b|^(?:list (?:of |all )?(?:agencies|codes|offense codes|states|the (?:agencies|codes))\b|what (?:years|crimes|offenses) (?:are|do|does|is)|what (?:can|do) you|help\b|hi\b|hello\b|test\b)")
SEG = {'clearance': R(r"clear(?:ed|ance)|solv"), 'weapon': R(r"firearm|gun|weapon|knife|shoot|handgun|rifle"),
       'property': R(r"stolen|recovered|property (?:stolen|value|loss)|\bvalue\b"),
       'victim': R(r"victim(?:s|'s)? (?:race|sex|age|gender|ethnic)|(?:female|male|black|white|hispanic|juvenile|child|teen|elderly) victim"),
       'offender': R(r"offender|suspect|perpetrator"), 'relationship': R(r"relationship|stranger|domestic|intimate|acquaint|family"),
       'location': R(r"location|residence|parking|school|store")}
RANK = R(r"\b(top \d+|top ten|most\b(?! recent)|highest|lowest|least\b|rank|ranking|worst|safest|most dangerous|which (?:city|cities|state|states|county|counties|agenc\w+)|leading)\b")
YEARS = re.compile(r"\b(?:19[3-9]\d|20[0-3]\d)\b")
PCMP = R(r"\b(?:vs\.?|versus|compared? (?:to|with)|compare|change|increase|decrease|went (?:up|down)|go(?:ne)? (?:up|down)|up or down|ytd|year[- ]to[- ]date|year over year|percent change|than (?:last|in))\b")
CATVS = R(r"\b(?:arrest|exceptional|male|female|men|women|firearm|gun|non-firearm|gang|non-gang|under \d+|over \d+|black|white|hispanic|adult|juvenile|stranger|known|cleared|uncleared|weekday|weekend|day|night|domestic|methamphetamine|cocaine)\w*\s+(?:vs\.?|versus)\s+")
SHARE = R(r"\b(?:age groups?|by (?:race|sex|gender|age|ethnicity|weapon|type|relationship|location|offense|circumstance|motive|bias|clearance|demographic|victim|offender)|breakdown|broken down|share|percent(?:age)? of|proportion|what percent|demographic|distribution|split)\b")
TREND = R(r"\b(?:since|over time|trends?|trending|per year|each month|as far back|monthly|per month|by month|by year|annual|each year|every year|over the (?:last|past)|historical|history|rolling|from \d{4} (?:to|through|-)|\d{4}\s*(?:-|to|through)\s*\d{4}|last \d+ years|past \d+ years|decade)\b")
RATE = R(r"\b(?:rates?|per capita|per 100|per 1,?000|per resident|percent cleared|clearance percent)\b")
# A period is a range or a point in time; grain and window words ("per year", "monthly", "over time") are not (Codex 01.2).
RANGE = R(r"\b(?:19[3-9]\d|20[0-3]\d|since|this year|last year|ytd|year[- ]to[- ]date|so far|today|to present|to date|currently|latest|most recent|as far back|every year available|all years|last \d+ (?:years|months)|past \d+ (?:years|months)|last decade|past decade)\b")
NATIONAL = R(r"\b(?:national(?:ly)?|nationwide|nation\b|u\.?s\.?a?\b|united states|america|the country|countrywide|all states|every state|each state|by state|which states?|what states?|states with|all cities|major (?:us )?cities|big cities|large cities)\b")
EDIT = R(r"^(?:add (?:a |in |the )?(?:column|row|line|the \d{4}|\d{4})|add in\b|remove\b|delete\b|drop\b|hide\b|sort\b|label\b)|\b(?:y-axis|x-axis|axis|legend|column for|to the table|to the chart|from the (?:data|table|chart))\b")
CAUSAL = R(r"^did .* work\b|\b(?:affect(?:ed|s)?|effect of|impact(?:ed)? (?:of|on))\b")
# Many places, each its own series or row, are a collection of agencies, not a national total (Codex 02.3).
COLLECTION = R(r"\b(?:top \d+|\d+ (?:largest|biggest|most populous)|largest|biggest|major|big|large|these \d+|\d+) (?:us |u\.s\. |american )?(?:cities|agencies|departments)\b|\bcities\b|\bagencies\b|\bdepartments\b")
SUBAGENCY = R(r"\b(?:zip ?codes?|neighborhoods?|census tracts?|police districts?|beats?|precincts?|wards?|blocks?)\b")
GROUP_RATE = R(r"\b(?:black|white|hispanic|latino|asian|teen\w*|juvenile|youth|men|women|female|male|elderly|children|age \d+|under \d+|over \d+)\b")
# ---- sources by policy (P01, P53, P57)
HATE = R(r"\bhate|bias|anti-")
STAFF = R(r"staff|officers?\b|sworn|personnel|police employees")
HOMICIDE = R(r"murder|homicid|kill")
HOM_DETAIL = R(r"race|sex|gender|age\b|ages\b|relationship|weapon|gun|firearm|knife|circumstance|gang|domestic|victim|offender|stranger|poison")
NIBRS_ONLY = R(r"\barrest|cannabis|marijuana|carjack|shoplift|vehicle burglar|burglar(?:y|ies) (?:from|of) (?:a )?(?:vehicle|car)|theft from (?:a )?motor|23f|drug|narcot|meth|cocaine|fentanyl|dui|dwi|fraud|vandal|weapons? law|simple assault|intimidation|kidnap|traffick|sex offense|fondl|animal cruel|pornograph|gambl|bribery|embezzl|extortion|stolen property|counterfeit|identity theft|location type|offender|arrestee|exceptional|by exception|cleared by arrest|clearance type|by clearance|nibrs|domestic violence|juvenile|incidents?\b")
CURRENT = R(r"\b(?:this year|ytd|year[- ]to[- ]date|so far|2026)\b")
# Monthly data is Current Trends' whatever the years (Historical is annual).
MONTHLY = R(r"\b(?:last 12 months|rolling|per month|monthly|by month|each month|month by month|most recent month|through (?:january|february|march|april|may|june|july|august|september|october|november)|january|february|march|april|june|july|august|september|october|november|december|jan|feb|jun|jul|aug|sept?|oct|nov|dec)\b")
NIBRS_DETAIL = R(r"\bvalue\b|dollar|(?<!homicide )(?<!murder )victims?\b.*\bby (?:age|race|sex|gender)|\bvictims? (?:age|race|sex)|age groups?\b.*victim")
PART1 = R(r"murder|homicid|kill|robber|burglar|aggravated assault|\bassault|rape|larceny|theft|motor vehicle|arson|violent crime|property crime|crime rate|\bcrime\b|part i|part 1|index crime|shoot")

def place_level(q):
    kinds = places.get(q, [])
    nat = bool(NATIONAL.search(q))
    if 'ambiguous' in kinds: return 'ambiguous'
    if len(kinds) > 1 or (nat and kinds): return 'several'
    if kinds: return 'state' if kinds[0] == 'state' else 'agency'
    # Many places with none named ("cities with the most murders"): agencies across the nation, not one national total.
    if COLLECTION.search(q) or R(r"\bcounties\b").search(q): return 'several'
    return 'national' if nat else 'none'

def shape(q, follow):
    # Edits to the previous table or chart are follow-ups even when they name no crime (Codex 02.1).
    if EDIT.search(q): return 'follow-up (needs context)'
    if OUT.search(q) or CAUSAL.search(q): return 'out of scope'
    if len(q.split()) <= 4 and not CRIME.search(q) and not YEARS.search(q): return 'follow-up (needs context)'
    if (follow or FOLLOW.search(q) or CONTEXT.search(q)) and (not CRIME.search(q) or len(q.split()) <= 6 or CONTEXT.search(q)) and not R(r"^(?:can you )?compare\b").search(q) and ':' not in q:
        return 'follow-up (needs context)'
    if R(r"^(?:what|how|why|is|are|does|do|explain|define|where)\b").search(q) and METHOD.search(q): return 'method/definition'
    if RANK.search(q): return 'ranking'
    if LOOKUP.search(q): return 'lookup/list'
    segs = [k for k, r in SEG.items() if r.search(q)]
    if (len(segs) >= 2 and SHARE.search(q)) or len(segs) >= 3: return 'cross-segment'
    if CATVS.search(q): return 'share/breakdown'
    if PCMP.search(q):
        return 'period comparison' if len(set(YEARS.findall(q))) >= 2 or R(r"\b(?:ytd|year[- ]to[- ]date|last year|change|increase|decrease|up|down)\b").search(q) else 'place comparison'
    if SHARE.search(q): return 'share/breakdown'
    if TREND.search(q): return 'trend'
    if RATE.search(q): return 'rate'
    return 'count'

def source(q):
    """The source the question needs by policy, or 'unresolved' (no crime named)."""
    if R(r"\b(?:according to|from|in|per) (?:the )?nibrs\b").search(q): return 'NIBRS'
    if HATE.search(q): return 'Hate Crime'
    if STAFF.search(q) and not PART1.search(q): return 'Crime Index historical'
    if HOMICIDE.search(q) and HOM_DETAIL.search(q) and not R(r"clear").search(q): return 'SHR'
    # A detail only NIBRS records wins over the period default (Codex 02.2).
    if NIBRS_ONLY.search(q) or NIBRS_DETAIL.search(q): return 'NIBRS'
    if PART1.search(q) or R(r"clear").search(q):
        # A series reaching back past the current year needs Historical for the completed years; the current year is
        # Current Trends' (status says so). Monthly data is Current Trends'.
        if MONTHLY.search(q): return 'Crime Index current'
        if CURRENT.search(q) and not (TREND.search(q) and any(int(y) < 2025 for y in YEARS.findall(q))): return 'Crime Index current'
        return 'Crime Index historical'
    if STAFF.search(q): return 'Crime Index historical'
    return 'unresolved'

# A state's clearance rate, or every state's, is declined (P18).
STATECLR = lambda q, lvl, src: src == 'Crime Index historical' and bool(R(r"clear").search(q)) and (lvl == 'state' or bool(R(r"\b(?:by|each|every|all|which) states?\b").search(q)))

def action(q, sh, lvl, src):
    if sh == 'out of scope': return 'decline'
    if sh in ('method/definition', 'lookup/list'): return 'answer'
    if sh == 'follow-up (needs context)': return 'needs context'
    if SUBAGENCY.search(q): return 'decline (below the agency: no source)'
    if METRO.search(q): return 'decline (metro area: until after inc 8)'
    if STATECLR(q, lvl, src): return 'decline (P18: no state clearance rate)'
    if RATE.search(q) and GROUP_RATE.search(q) and not STAFF.search(q): return 'decline (D03: offer counts or shares)'
    if src == 'unresolved' or not CRIME.search(q): return 'clarify'
    if lvl in ('none', 'ambiguous') and not LOOKUP.search(q): return 'clarify'
    if not RANGE.search(q): return 'clarify'
    return 'answer'

COUNTYWIDE = R(r"countywide|county-wide|all (?:the )?agencies in|entire county|whole county|county total|county as a whole")
# Metro geography, not agency names ("LAS VEGAS METRO PD", "Metropolitan Nashville") (Codex 02.6).
METRO = R(r"\bmetro(?:politan)? (?:areas?|regions?|statistical)|\bmsas?\b|\bcbsas?\b")
INC9 = R(r"circumstance|injur|drug type|meth|cocaine|fentanyl|heroin|marijuana|cannabis|opioid|\bvalue\b|dollar|number of (?:victims|offenders)|justifiable")
PEOPLE = R(r"offender|arrestee|suspect|juvenile|adult|female victim|male victim|victims? under|relationship|stranger")
def status(q, sh, lvl, src):
    """B = built (an answer, or a named route), P = planned (where), G = gap, C = clarify first."""
    if sh == 'out of scope': return 'B decline'
    # Follow-ups are increment 7b (coordinator 2026-10-30): continuations of the previous answer.
    if sh == 'follow-up (needs context)': return 'P inc 7b'
    if SUBAGENCY.search(q): return 'B decline (below the agency)'
    if sh in ('lookup/list', 'method/definition'): return 'G'
    # Areas (ruling 2026-10-30): an explicit county-wide total sums the county's agencies; a metro area after increment 8.
    if COUNTYWIDE.search(q): return 'P area totals (county-wide, ruling 2026-10-30)'
    if METRO.search(q): return 'P area totals (metro, after inc 8; declined until then)'
    # No crime named: the policy action is to ask (D31), not a missing capability.
    if src == 'unresolved': return 'C clarify first (no crime named)'
    # Decided declines come before the generic rules: a group rate (D03), a state clearance rate (P18).
    if RATE.search(q) and GROUP_RATE.search(q) and not STAFF.search(q): return 'B decline (D03)'
    if STATECLR(q, lvl, src): return 'B decline (P18)'
    if src == 'NIBRS':
        # National totals of people are not estimated; NIBRS has no estimates (P61).
        if R(r"\bestimates? (?:since|of|for)\b").search(q): return 'G (no source: NIBRS has no estimates)'
        if INC9.search(q): return 'P inc 9'
        if sh == 'cross-segment': return 'B inc 6' if SEG['property'].search(q) and SEG['clearance'].search(q) and lvl == 'agency' else 'P inc 7-8'
        if sh == 'share/breakdown':
            if PEOPLE.search(q): return 'P inc 7'
            # A question with no place is judged as for an agency once the place is given (as for every other shape).
            return 'B inc 1, 6' if lvl in ('agency', 'none', 'ambiguous') else 'G (breakdowns for states, the nation, sets of cities)'
        if lvl in ('state', 'national'):
            if sh == 'count': return 'B inc 5'
            if sh == 'trend': return 'G (monthly or rate series for states)' if R(r"month|rolling|rate").search(q) else 'B inc 5'
            if sh == 'rate': return 'B inc 5'
            if sh == 'ranking': return 'B inc 4 (a state\'s agencies, P60)' if lvl == 'state' else 'G (rankings of states, cities nationally)'
            return 'G (comparisons for states, the nation)'
        if lvl == 'several' and sh in ('ranking', 'count', 'rate', 'trend', 'period comparison', 'place comparison') and not places.get(q):
            return 'G (sets of cities nationally)'
        if sh == 'ranking': return 'B inc 4'
        return {'count': 'B inc 1-2', 'rate': 'B inc 4', 'trend': 'B inc 3', 'period comparison': 'B inc 3', 'place comparison': 'B inc 4'}.get(sh, 'B')
    if src == 'Crime Index historical':
        if STAFF.search(q) and not PART1.search(q): return 'P Historical (staffing)'
        cur = ' (+ current year: Current Trends)' if CURRENT.search(q) else ''
        if lvl in ('state', 'national') and sh in ('count', 'rate', 'trend', 'period comparison'):
            if R(r"clear").search(q): return 'B inc 5' if sh == 'rate' else 'P Historical (national clearance series)'
            return 'B inc 5' + cur
        # An agency's Part I clearance rate for a year is a named Historical route (P57).
        if lvl == 'agency' and sh == 'rate' and R(r"clear").search(q): return 'B route (inc 5, P57); P Historical'
        return 'P Historical' + cur
    if src == 'Crime Index current':
        return 'B route (inc 5); P Current Trends' if lvl in ('state', 'national') and sh in ('count', 'trend', 'period comparison', 'rate') else 'P Current Trends'
    if src == 'SHR': return 'B route (inc 5); P SHR' if R(r"relationship").search(q) else 'P SHR'
    return 'P Hate Crime'

by = collections.defaultdict(list)
for r in rows: by[norm(r['question'])].append(r)
out = []
for q, rs in by.items():
    tab = collections.Counter(r['tab'] for r in rs).most_common(1)[0][0]
    sh = shape(q, any(r['routing_mode'] == 'follow_up' for r in rs))
    lvl = place_level(q); src = source(q)
    out.append({'question': redact(rs[0]['question'].strip().replace('\n', ' ')), 'norm': q, 'times': len(rs), 'tab': tab, 'synthetic': q in synthetic,
                'shape': sh, 'place': lvl, 'source': src, 'action': action(q, sh, lvl, src), 'status': status(q, sh, lvl, src),
                'logged_actions': ';'.join(sorted({r['delivery_action'] for r in rs if r['delivery_action']}))})
json.dump(out, open(D + 'classified.json', 'w', encoding='utf-8'), ensure_ascii=False)
real = [x for x in out if not x['synthetic']]
with open(D + 'classification.csv', 'w', encoding='utf-8', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['question', 'times_asked', 'tab', 'shape', 'place', 'source', 'correct_action', 'status', 'logged_actions'])
    for x in sorted(real, key=lambda x: (-x['times'], x['norm'])):
        w.writerow([x['question'], x['times'], x['tab'], x['shape'], x['place'], x['source'], x['action'], x['status'], x['logged_actions']])
print('distinct', len(out), 'real', len(real))
for k in ('shape', 'place', 'source', 'action'): print(k, collections.Counter(x[k] for x in real).most_common())
print('status', collections.Counter(x['status'].split(' ')[0] for x in real).most_common())
