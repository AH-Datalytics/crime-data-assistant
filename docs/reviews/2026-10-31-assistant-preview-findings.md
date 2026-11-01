# Crime Data Assistant preview: findings from the first end-to-end run (2026-10-31)

The chat page (`/assistant`, spec `docs/superpowers/specs/2026-10-31-crime-data-assistant-redesign-design.md`) wired
to the shadow engine on the pinned build `20261028-test5`, local dev server only. Questions were asked in the page at
1440x900 and through its API: Jeff's "vehicle burglaries in Baltimore", 14 sampled LS cases, and follow-ups.

## What works

- Speed: every reply in 0.6 to 4.2 s on this laptop (the first question after a server start takes about 18 s while
  Next compiles the route).
- Jeff's question: "Vehicle burglaries in Baltimore in 2024" asks which Baltimore; "Baltimore city" answers 3,787 theft
  from motor vehicle offenses (23F). "Vehicle break-ins in Nashville in 2022" (LS-252) answers 7,793.
- Layout with real data: monthly series (one year and five years), a year series, breakdowns (victim race; 30-odd
  location types), single numbers, state sums with the P61 button, several measures, a decline with its alternative,
  clarify buttons. Chart beside table holds; the table is the only inner scroll.
- Follow-ups through the engine's rewriter: "by year", "make it a bar chart" (redrawn, no data turn).

## Engine findings (for the engine session; no engine code was changed)

1. **The fixtures are read relative to `__dirname`** (`lib/nibrs-shadow/places.ts` NAMES_FILE and loadPlaceIndex's
   default, `srs.ts` DIR). No Next bundle has a source `__dirname` (Turbopack gives `C:\ROOT\...`, webpack gives
   `.next/dev/server/app`), so `/api/nibrs-shadow-query` and `/preview` fail on any question once agency names load.
   The preview runs only with a dev-only `next.config.ts` hook (`config.node.__dirname = true`), present only when
   the process was started with `next dev --webpack` and `NIBRS_SHADOW_ROOT` is set; `next build` and plain `next dev`
   never see it (a first version that always declared `webpack` broke the Turbopack production build; caught by
   `scripts/test-nibrs-preview-production.sh`). Fix in the engine: resolve from `process.cwd()` as the routes do for
   `agencies.json`, then the hook can go.
2. **Jeff: "The answers need to be much, much more crystal clear for users."** His example: "I can't apply "victim":
   clearance figures count offense records, not other units. I haven't answered with a number that leaves it out."
   Every decline and clarify should say in plain words what the data records, why the question can't be answered as
   asked, and offer the nearest answerable question as a button ("Clearances are recorded for each offense, not for
   each victim, so this can't be counted by victim. Here is the same question counted by offense:"), with no engine
   vocabulary (units, records, slice, shadow, P-numbers, "apply", "interpret", dimension names).
2b. **Internal wording reaches users.** "Not in the slice yet: counts of this crime come from Historical or Current
   Trends (P01), which this NIBRS shadow does not run." (Burglaries in Memphis); "Not in the slice yet: v0 cannot group
   victim by offense_weapon.weapon" (aggravated assault victims by weapon, Detroit); "The question could not be read:
   no typed reading." (LS-113); "Not in the slice yet: a state or the nation together with other places." (LS-060).
   Policy ids, "slice", "shadow", "v0" and dimension names should never be in an explanation.
3. **A rate prints without a thousands separator**: "1459.7 shoplifting offenses per 100,000 residents" (LS-320).
4. **The rewriter treats a complete new question as a follow-up.** After "Murder victims in Houston by race in 2024",
   "Did shoplifting go up in Detroit from 2022 to 2023?" returns "The follow-up could not be placed in the previous
   question with certainty; ask the full question." It names its own crime and place, so it should be `new`. The page
   now offers "Ask ... as a new question" on every rewriter question back.
5. **Jeff, on the unread-phrase decline:** "I couldn't interpret "rolling over 12 months" in this question, so I
   haven't answered it with a number that ignores it." is "not something we say"; the "so I haven't answered it with a
   number that ignores it" part is not obvious to a reader. Plainer: say which words were not understood and ask for the
   question another way. And **"rolling over 12 months" must be read**: rolling totals are needed (the engine already
   computes rolling windows; this phrasing is not recognized).
6. **"go up" is not read**: asked on its own, the same question returns "I couldn't interpret 'go up in' ...". Change
   questions in that form ("did X go up/down from A to B") are common.
7. **"female" as a follow-up** returns `ask` with the fragment "Whether "female" means victims, offenders or
   arrestees." and no options; it should be a question with three options (victims, offenders, arrestees).
8. **"by year" after a one-year question** rewrites to "Shoplifting in Memphis by year in 2024": one row. Fine as a
   reading; the page shows it as the sentence.
9. **LS labels against the engine** (sample of 14): LS-156 and LS-135 (possession or distribution arrests) labeled
   answer, engine declines; LS-060 and LS-113 labeled clarify, engine declines; LS-030 labeled decline, engine asks
   which place. For the label owners to check.
10. **Clarify labels carry no description.** "Baltimore city, Maryland" and "Baltimore County, Maryland" are the whole
   buttons; the spec's mono description (city police; county police, does not include the city) needs the engine to
   say which agency type each option is.

## After engine PR #86 (dev 802dace, 2026-11-01)

- Item 1 is fixed: fixture paths come from `process.cwd()`. The dev-only webpack hook and `--webpack` are removed;
  the preview runs on the default bundler, and `next.config.ts` matches dev.
- Item 3 is fixed ("1,459.7"). Item 2b's strings are rewritten in plain words (P74), and declines now offer a
  question-only choice ("Ask instead: ...") that the page asks as a new question.
- Still unclear, from the follow-up rewriter (not covered by P74): "Whether "female" means victims, offenders or
  arrestees." (no options) and "The follow-up could not be placed in the previous question with certainty; ask the
  full question." (a complete new question). "I can't answer this combination yet. Try a simpler version, for example
  one crime in one place for one year." (victims cleared; victims by weapon) is plain but offers no button.
- The rewriter's new `propose` result (P73) is returned by the route as a "Did you mean ...?" reply and never run
  until confirmed; the deterministic rewriter the preview uses does not propose.

## Page findings (fixed in this round)

- A one-row series ("2024: 10,149") showed as a table; it is now the answer sentence.
- A one-year monthly chart labeled only "2024"; it now names Jan, Apr, Jul, Oct.
- A long breakdown drew every category and ran far below its table; the 15 largest are drawn, with a line saying the
  table has all.
- Percent columns dropped a trailing zero ("13"); they now show one decimal ("13.0").
- A series that starts with periods no agency reported now starts at the first reported period (Jeff): the leading
  blank rows are left out of the chart, the table and the CSV, and the engine's note for that run becomes "No report is
  known for January 2017 to May 2018, so the chart and table start at June 2018." (Houston shoplifting, 2017 to 2019).
- Each answer with a table has "Download CSV" (the delivered columns and values) and "Download PNG" (the question, the
  chart beside the full table, the notes with the source); a new answer scrolls its question to the top of the view.
- The chart is drawn with SVG attributes, not stylesheet classes, so the PNG keeps its colors (it exported solid black).
- After a button, the read line repeated the original question above an answer to a different one; it is now hidden
  after a button (the engine's headline says what was answered).

## Not in this round

Downloads, permanent links, click-to-ask, the full start page and its sources table (per the coordinator's scope). The
other four sources answer "Not available yet in this preview". The engine's "proposal" outcome is rendered ("Did you
mean ...? Run it / Edit it") but stubbed until the engine returns it.
