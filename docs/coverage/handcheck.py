"""Write the hand-check CSV: all 122 gap rows and a 100-row sample of planned rows (seed 20261031), each judged by
reading the question. Usage: python handcheck.py <classification.csv> <out.csv>"""
import csv, random, sys

x = list(csv.DictReader(open(sys.argv[1], encoding='utf-8')))
gaps = [r for r in x if r['status'].startswith('G')]
planned = random.Random(20261031).sample([r for r in x if r['status'].startswith('P')], 100)
assert len(gaps) == 122

KEEP = 'gap (confirmed)'
# Gap rows: (hand status, one-line reason). Unlisted rows are confirmed gaps with the reason below.
G = {
 7: ('decline', '"misdemeanor" is not recorded in NIBRS; offer arrests by offense'),
 20: ('clarify, then built (inc 6)', 'no place or period; clearance type for an agency is built'),
 24: ('planned (Historical), clarify period', 'an agency\'s Part I crime; not a lookup'),
 26: ('planned (inc 7b)', 'follow-up: "those years"'),
 36: ('clarify', 'which definition: NIBRS 11A (forcible rape) only, or Historical\'s legacy rape series; and the place and period'),
 41: ('decline', 'P61: non-reporters are never estimated; offer sums of reporting agencies'),
 42: ('planned (inc 7b)', 'follow-up: edits the previous table'),
 50: ('decline', 'calls for service are not recorded; offer crimes (the next row)'),
 56: ('planned (Historical)', 'an agency\'s murder rate series; not a lookup'),
 61: ('built (inc 6)', 'clearance by arrest vs exceptional for one agency, by year'),
 65: ('decline', 'modeling request; the app reports counts, not models'),
 66: ('decline', 'asks for a statistical judgment; offer the two series'),
 67: ('decline', 'asks whether a rate is "high"; offer a comparison'),
 68: ('planned (inc 7b)', 'follow-up: "the observed trend"'),
 69: ('planned (area totals, county-wide)', 'an explicit sum of a county\'s agencies (ruling 2026-10-30)'),
 80: ('planned (inc 8)', 'named agencies x clearance type is a two-way breakdown'),
 83: ('decline', 'a list of individual incidents is outside the result contract (groupings and numbers)'),
 95: ('planned (inc 7b)', 'follow-up: edits the previous table'),
 103: ('planned (Historical)', 'agency rankings by Part I rate come with the Historical source'),
 105: ('planned (Historical), clarify period', 'an agency\'s Part I trend; not a lookup'),
 106: ('planned (Historical), clarify period', 'an agency\'s Part I trend; not a lookup'),
 112: ('clarify', 'which agency ("PPD") and which crime'),
}
# Confirmed gaps, by what is missing (read one by one).
CLASSES = {
 'a breakdown, comparison or series for a state (increment 5 built sums only)': [5, 10, 13, 19, 21, 23, 32, 34, 43, 45, 55, 64, 71, 82, 84, 85, 93, 100, 101, 114, 118, 119],
 'a breakdown or ranking for the nation, or a ranking of states': [1, 3, 6, 15, 22, 39, 47, 54, 88, 96],
 'agencies reporting in every year (a panel) across states': [29, 30, 48, 49, 86, 87, 89, 90, 92, 94, 99],
 'a set of cities across states (by size, rank or threshold)': [8, 9, 18, 31, 33, 35, 40, 46, 51, 52, 72, 91, 97, 98, 107, 108, 109],
 'lookup: coverage, codes or the agency directory': [2, 4, 16, 17, 25, 27, 28, 37, 44, 57, 59, 60, 62, 63, 70, 73, 74, 75, 76, 77, 78, 79, 81, 102, 115, 116, 120, 121],
 'definition or method: a text answer outside the plan language': [11, 12, 14, 53, 58, 104, 110, 113, 117, 122],
 'definition or method (a text answer), asked with a follow-up (increment 7b): a compound question stays a gap if any part is one': [38, 111],
}
WHY = {i: k for k, ids in CLASSES.items() for i in ids}
assert not set(WHY) & set(G) and len(WHY) + len(G) == 122, (len(WHY), set(WHY) & set(G))
gap_reason = lambda i: WHY[i]

# Planned sample: (hand verdict, hand status, reason) for rows placed wrongly; unlisted rows are correct.
P = {
 1: ('misplaced', 'planned (inc 9), clarify place', 'standalone question, not a follow-up; value is increment 9'),
 5: ('misplaced', 'built (inc 3)', 'aggravated assaults with a firearm for one agency are a NIBRS weapon filter'),
 6: ('misplaced', 'clarify', 'nonfatal shootings are not recorded as such; ask whether aggravated assaults with a firearm are meant'),
 4: ('misplaced', 'decline (D03); offer homicides by offender age (SHR)', 'rates for generational cohorts are group rates (D03)'),
 9: ('gap', 'gap', 'national panel by offender age: a national breakdown'),
 13: ('gap', 'gap', 'a region ("the southwest") is not a place any source or ruling covers'),
 24: ('misplaced', 'planned (SHR)', 'justifiable homicide is an SHR circumstance'),
 27: ('gap', 'gap', 'a typical value for a whole state: a state statistic beyond sums'),
 28: ('misplaced', 'decline', 'not a data question'),
 38: ('gap', 'gap', 'statewide offender-age breakdown: increment 7 is for agencies'),
 43: ('misplaced', 'clarify', 'Crofton is not an agency; ask which agency, and "surrounding areas" is unspecified'),
 44: ('gap', 'gap', 'a method question about the data (gang circumstance)'),
 55: ('misplaced', 'planned (inc 7b)', 'follow-up about the previous answer'),
 57: ('misplaced', 'decline', 'population by race is not crime data; group rates are D03'),
 58: ('misplaced', 'planned (inc 7b); decline the commentary', 'follow-up; "interesting trends" asks for commentary'),
 61: ('misplaced', 'planned (Current Trends)', 'a moving average of monthly murders is Current Trends\''),
 63: ('gap', 'gap', 'national panel by offender race: a national breakdown'),
 66: ('misplaced', 'planned (inc 7b)', 'follow-up: "break out by crime type"'),
 67: ('gap', 'gap', 'an agency identifier lookup'),
 72: ('gap', 'gap', 'selecting agencies by type (tribal) is in no plan; sets of named agencies are planned with Historical'),
 81: ('misplaced', 'planned (SHR)', 'murders by month in 1996: SHR is monthly from 1976 (Current Trends starts in 2017; Historical is annual)'),
 82: ('misplaced', 'decline', 'asks for correlates (causes)'),
 90: ('misplaced', 'planned (Historical)', 'an agency\'s murder rate against the nation is Part I (Historical), not SHR'),
 91: ('misplaced', 'clarify', 'shootings are not recorded as such; ask which crime is meant'),
 93: ('misplaced', 'built (inc 6)', 'clearance by type for one agency is NIBRS (P66), built'),
 96: ('misplaced', 'decline the offender count; offer homicides by the primary offender\'s race and age (SHR)', 'SHR records one offender per incident, so offender counts are refused (other-sources plan)'),
 97: ('gap', 'gap', 'PROVISIONAL: robbery by weapon for a state is a NIBRS state breakdown; no local evidence that Historical carries the Return A weapon split'),
}

NAMES = [('Hi Jeff can you', 'Hi [name] can you'), ('Joe\ufffds crime', '[name]\ufffds crime'), ("Joe's crime", "[name]'s crime"), ('Joe’s crime', '[name]’s crime')]
def scrub(q):
    for a, b in NAMES: q = q.replace(a, b)
    return q
for r in gaps + planned: r['question'] = scrub(r['question'])

with open(sys.argv[2], 'w', encoding='utf-8', newline='') as f:
    w = csv.writer(f, lineterminator='\n')
    w.writerow(['check', 'id', 'question', 'shape', 'place', 'source', 'rule_status', 'hand_verdict', 'hand_status', 'reason'])
    for i, r in enumerate(gaps, 1):
        st, why = G[i] if i in G else (KEEP, gap_reason(i))
        w.writerow(['gap', f'G{i}', r['question'], r['shape'], r['place'], r['source'], r['status'], 'gap' if st == KEEP else 'moved', st, why])
    for i, r in enumerate(planned, 1):
        v, st, why = P.get(i, ('correct', r['status'], ''))
        w.writerow(['planned sample', f'P{i}', r['question'], r['shape'], r['place'], r['source'], r['status'], v, st, why])
print('gaps confirmed', 122 - len(G), 'moved', len(G))
print('planned sample: gap', sum(v[0] == 'gap' for v in P.values()), 'misplaced', sum(v[0] == 'misplaced' for v in P.values()))
