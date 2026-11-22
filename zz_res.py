import re, json
R = 'C:/Users/jeffm/cda-ca/'
def rw(p, f):
    s = open(R + p, encoding='utf-8', newline='').read()
    s = f(s)
    open(R + p, 'w', encoding='utf-8', newline='').write(s)

def blocks(s, fn):
    pat = re.compile(r'<<<<<<< HEAD\n(.*?)=======\n(.*?)>>>>>>> origin/dev\n', re.S)
    i = [0]
    def rep(m):
        i[0] += 1
        return fn(i[0], m.group(1), m.group(2))
    return pat.sub(rep, s)

def pj(s):
    def f(n, a, b):
        assert 'test-scorecard-workers' in b and 'test-scorecard-workers' not in a
        k = 'tsx scripts/test-nibrs-duckdb-executor.ts && '
        assert a.count(k) == 1
        return a.replace(k, k + 'tsx scripts/test-scorecard-workers.ts && ')
    return blocks(s, f)
rw('package.json', pj)

def mf(s):
    return blocks(s, lambda n, a, b: a + '    },\n    {\n' + b)
rw('scripts/fixtures/harness-tier-manifest.json', mf)

def ts(s):
    return blocks(s, lambda n, a, b: a + '}\n' + b)
rw('scripts/test-nibrs-shadow.ts', ts)

def an(s):
    def f(n, a, b):
        if n == 1:
            return ('      // "By state" names the nation\'s states as the rows (Engine 2.0, 2026-11-22): no note and no place buttons beside a table of every state.\n'
                    '      byStateRows = /\\b(?:by|per|each|every|for\\s+each)\\s+state\\b/i.test(question);\n'
                    '      if (option) placeDefaulted = true;\n'
                    '      note = byStateRows ? "" : "No place was named, so the United States is shown.";\n'
                    '      if (!byStateRows) more.push({ label: "A state", entry: "which state" }, { label: "A city or agency", entry: "which city or agency" });\n')
        return (a.split('\n')[0] + '\n'
                '    if (!option || !option.continuation) { DEFAULT_MISSES.push({ site: c.about, why: !option ? "no default option" : "no answer" }); return o0; }\n'
                '    if (!byStateRows) notes.push(note);\n')
    return blocks(s, f)
rw('lib/nibrs-shadow/answer.ts', an)

for p in ['package.json', 'scripts/fixtures/harness-tier-manifest.json', 'scripts/test-nibrs-shadow.ts', 'lib/nibrs-shadow/answer.ts']:
    s = open(R + p, encoding='utf-8').read()
    print(p, len(re.findall(r'^(<<<<<<<|>>>>>>>)', s, re.M)))
json.load(open(R + 'package.json', encoding='utf-8'))
json.load(open(R + 'scripts/fixtures/harness-tier-manifest.json', encoding='utf-8'))
print('json ok')
