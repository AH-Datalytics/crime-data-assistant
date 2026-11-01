# Plain wording for every user-facing string (P74)

Jeff, 2026-11-01: "The answers need to be much, much more crystal clear for users." The redesign shows the engine's text verbatim, so the fix has to be in the engine.

## The rule (P74)

Every decline, question back, button and note:
1. says in plain words what the data records ("Clearances are recorded for each offense");
2. says why the question can't be answered as asked;
3. offers the nearest answerable question as a button whenever one exists;
4. never uses engine vocabulary: units, records (as a noun), slice, shadow, P-numbers, "apply", "interpret", dimension or field names, code names, "reading", "typed reading", "v0", "plan", "compile".

Jeff's example:
- **Before:** I can't apply "victim": clearance figures count offense records, not other units. I haven't answered with a number that leaves it out.
- **After:** Clearances are recorded for each offense, not for each victim, so this can't be counted by victim. Here is the same question counted by offense: [button]

## Where the strings come from, and where they are fixed

**Inventory (before):** 608 distinct user-facing strings. They were collected by running every case question, setup and follow-up, and every button's continuation two levels deep, on the local build. 87 contain engine words.

1. **The shadow's own text.** These are fixed at the source:
   - the decline sentences in answer.ts, places-answer.ts and state-sum.ts;
   - the route sentences;
   - the forecast and court sentences;
   - the notes in deliver.ts.
   "Not in the slice yet: …" becomes "This isn't available yet: …" with a plain description. Compiler reasons, which name code ids, never reach the user: a plain sentence goes out, and the reason is kept for logs.
2. **The reader's text.** The reader modules are shared with the live routes (lib/nibrs-question-types.ts, lib/request-accounting.ts, lib/*-request-accounting.ts), and the live answers must not change. So the shadow translates their text at its boundary (`plainReaderText` in lib/nibrs-shadow/wording.ts), sentence by sentence:
   - `I couldn't interpret "X" in this question, so …` becomes `I didn't understand "X".`, with a closing "Try asking it another way."
   - `I can't apply "X": <reason> I haven't answered…` becomes a plain sentence for each known reason (a fixed table), naming X.
   - `NIBRS doesn't record W, so I can't apply "X". I haven't answered…` becomes `NIBRS doesn't include W, so "X" can't be counted.`
   - A reader sentence the table doesn't know is kept, and the banned-word test fails on it, so a new reason can't slip through unworded.
3. **The nearest answerable question.** For a reader decline that names words it couldn't use, the shadow tries the question without those words. If that question answers or asks a question back, it is offered as a button: `Answer without "X"`, or a reason-specific label (Jeff's example: "Count clearances by offense"). The button's question is shown, so nothing is left out silently.

## Checks

- **lib/nibrs-shadow/wording.ts `jargon()`:** the banned list.
- **A test (offline):** runs a corpus through the shadow with the test stub (the case questions, the preview findings' questions and Jeff's examples) and fails if any user-facing string (decline, question back, button, answer text, column header) contains a banned term.
- **A static check:** the string literals in the shadow's user-facing call sites.
- **The PR:** a before/after table of every changed string, for Jeff to read.

## Also in this PR

- Fixture paths from `process.cwd()`. A Next bundle has no source `__dirname`, and that was the preview's blocker.
- Rates printed with one decimal and thousands separators ("1,459.7").
