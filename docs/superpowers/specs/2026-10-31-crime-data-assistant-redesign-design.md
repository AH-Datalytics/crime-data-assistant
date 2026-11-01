# Crime Data Assistant redesign: design

Date: 2026-10-31. Owner: Jeff Asher. Status: direction approved ("chat it is"); this document is the build reference.
Mockups (static HTML, served by `docs/superpowers/mockups/nibrsai-redesign/serve.py` on port 8765; they do not open
from disk): `20-start.html` (start page) and `24-chat.html` (the conversation). The other files in that folder are
rejected or superseded rounds, kept for reference.

## Intent

NIBRSAI.com becomes the **Crime Data Assistant** inside the Crime Index site (crimeindex.org), in Crime Index's look,
running the new answer engine (`lib/nibrs-shadow`, `lib/nibrs-plan`). The chat is the product: a person types a question
in plain English and gets the answer as a chart and a table with its source, or one number, or a question back, or a
plain no with the nearest answerable question. It must look like part of Crime Index, not like an AI product.

## Owner's rules (hard)

- Crime Index's formatting and aesthetic exactly: its header, logo artwork (`crimeindex/src/components/common/Svg/components/SvgLogoSite.tsx`),
  fonts (Neue Haas Grotesk Display via the Typekit kit, Hanken Grotesk, Fragment Mono), tokens (`crimeindex/src/app/globals.css`),
  tables (`explorer/ExplorerTable`), chart styling (`vis/Timeline`: no gridlines, `#CCC` y axis, 1.5px line with gradient area),
  dark tooltip (`explorer/ExplorerTooltip`), buttons and inputs.
- No AI summary boxes of any kind: no stat or KPI tiles, no coverage boxes, no big number with a caption. No
  "overline, clever headline, one-line explainer" sections, no hint lines, no slogans or selling lines, no AI-speak.
- Never join items with a middle dot. American spelling, plain English. The product is "Crime Index", never
  "Real-Time Crime Index".
- Each answer with a series or a breakdown shows a chart and a table side by side. A single number is shown as the
  answer sentence only.
- The user needs some hand-holding, delivered through the start page's sources table and examples and through
  click-to-ask, not through explanatory copy.

## Rejected (do not reintroduce)

A standalone explorer replacing the chat; a slot-sentence question builder; a plain reskin of today's app; place-first
asking and place pages; a browse catalog; numbers in clarify buttons; drawn gaps on charts; suggested-question chip rows;
a workbook of stacked numbered answers; a left question list or numbered answer tabs; a gray hero box; navy, plum or
burgundy for the assistant; source-table dots that switch the Source menu.

## Color

- The assistant is **teal** `#0E6E7A` (hover/dark `#094B54`, tint `#EEF7F8`): the header tab when active, the start
  page band, the Ask button, links in answers, the follow-up highlight.
- Sources keep their own colors, used for their names, marks and charts: Current Trends `#485EC9` and Historical
  `#BC4704` (Crime Index's own), NIBRS purple `#6B3FA0`, Homicide Reports gold `#A87A12`, Hate Crime gray `#575757`.
  NIBRS chart fill uses the purple ramp (`#9C7CCB` to `#6B3FA0`, tint `#F4F0FA`).
- The start page band follows Crime Index's explorer hero (`site/Hero/Hero.module.css`, `Hero_explorer`): 8rem, a
  dark-to-light vertical gradient in teal (`#0A4D57` to `#11727F`) with Crime Index's 18px dot grid, title bottom-aligned,
  white-to-60% gradient lettering.

## Start page (`20-start.html`)

Top to bottom:
1. Crime Index header with the real logo; nav "Current Trends", "Historical Data Library", "Crime Data Assistant" (active, teal).
2. The teal band with "Crime Data Assistant".
3. A tinted strip (`#EEF7F8`): one plain line ("Questions about U.S. crime data, answered from five FBI and Crime Index
   datasets with a chart, a table and the source."), the question box, the Source menu (Auto, or one source), Ask.
   Asking opens the conversation.
4. **Data sources** (section title in Crime Index's dark display style): a table, one row per source with its name in
   its color, its detail and years ("Incident, 2017 to Sep 2026") and a timeline bar on a 1930 to 2026 scale; columns
   grouped Geography (Nation, State, Agency), People (Victims, Offenders, Arrestees), Incident detail (Weapon,
   Relationship, Location, Circumstances, Property, Bias), Outcomes (Clearances, Staffing). A dot in the source color
   marks a detail the source records; clicking it puts a starter question in the box. Every header stays on one line.
   Years: Current Trends monthly 2017 to Aug 2026; Historical annual 1930 to 2025; NIBRS 2017 to Sep 2026; Homicide
   Reports 1976 to Sep 2026; Hate Crime 1991 to Sep 2026. These dates and the dots must come from the sources at build
   time (see Open items).
5. **Example questions**: a striped table, two per source, in the source's color; clicking one puts it in the box.
6. A light band with **Tips** and **Disclaimers** (Crime Index's notes band).

## The conversation (`24-chat.html`)

One straight scroll, like any chat. Crime Index header at the top; no band. The question box is pinned to the bottom
(input, Source menu, teal Ask), with one fine-print line under it ("Answers come from FBI and Crime Index data and can
be wrong. Check important figures against the FBI Crime Data Explorer."). The column is at most 76rem wide.

Each turn:
- **The question as typed**, right-aligned on the teal tint, square-ish corners (Crime Index's 6px input radius).
- **The reply**, full width below, no avatar, no bubble, then a divider before the next turn.
- A new turn scrolls so its question sits at the top of the view.

### Reply by outcome (the engine's `ShadowOutcome`, `lib/nibrs-shadow/answer.ts`)

| Outcome | What the reply shows |
|---|---|
| `answer` with a table of more than one row, or with `delivered.chart` set | Read line, then chart beside table, then notes, then actions |
| `answer` with a single cell (one number) | Read line, then the answer sentence (`delivered.text[0]`) with the number in bold display type, then notes, then the Copy link action. No chart, no table, no box. |
| `answer` with `buttons` (P61: "Show only agencies that reported every month") | As above, then each button as a plain outlined choice under the notes; choosing it runs its `continuation` as a new turn |
| `clarify` | `question` as one sentence ("Two agencies match. Which one?"), then each option as a full-width choice row: the label and, in mono, a plain description (agency type; "does not include the city"). No numbers. An option with `entry` opens a small input in place. An option with `otherSource` names the other source. |
| `decline` | `explanation` as one sentence, then `alternative` (if any) as the primary choice row and, for a period problem, "Pick another period" opening the period in the box. `notBuilt` declines say the data is not loaded yet, in the same form. |
| `route` | `explanation` and the name of the source that answers it; the question runs there (Source set to that source) as a new turn. |
| `srs` (historical file) | Same as `answer`; the source line is "Source: FBI SRS." |

### Inside an answer

- **Read line**: "Answering **<the standalone question>**. Edit" in body text. The question is the engine's rewrite
  (P69, `follow-up.ts`), lowercased at the start, shown on every answer. Edit turns the line into an input with
  "Ask this" and "Cancel"; asking adds the edited question as a new turn (the original answer is not changed). When the
  rewriter returns `kind: "ask"`, the reply is a clarify with its `options`. A presentation-only follow-up ("make it a
  bar chart") changes the chart in place and adds no data turn.
- **Chart beside table**: 3fr chart, 2fr table, about 400px tall. The chart is drawn at its real pixel width so axis
  labels stay 14px (Crime Index's ECharts timeline; the build should use ECharts with Crime Index's `Timeline` settings).
  `delivered.chart.kind` picks line (months) or bar (years, quarters). The table is Crime Index's table: display-font
  headers from `table.columns[].header`, rows from `table.rows`, striped, right-aligned numbers, the first column bold.
  A null cell is blank (never 0). The table scrolls inside itself only when taller than the chart; it is the only
  inner scroll on the page.
- **Linked chart and table**: hovering a row puts the chart's crosshair and tooltip on that point (or highlights the
  bar), and hovering the chart highlights the row.
- **Click-to-ask**: clicking a point, bar or row opens Crime Index's dark tooltip surface as a menu, headed with the
  place and the clicked period or category, listing only questions the source can answer for that measure (see Open
  items: the list is a UI mapping until the engine supplies one). For a property crime (counted by offense, P11) no
  victim breakdowns are offered. Choosing one adds it as a new turn in plain words ("Car thefts in Baltimore by location
  type, July 2023").
- **Notes**: `delivered.text` after the first line, in order, in 0.95rem body text; the source line last
  ("Source: FBI NIBRS.") in the secondary text color. Fixed statements (`ANSWER_STATEMENTS`) appear here exactly as
  worded. Nothing is shortened into fine print.
- **Supporting columns (P72)**: population and agencies-reporting columns are ordinary table columns when the engine
  returns them; no special treatment.
- **Actions**: text links "Download data" (the table as CSV, columns exactly as delivered), "Download image" (chart and
  table with the source line), "Copy link".

### Follow-ups

There is one question box. Anything typed is a follow-up to the latest answer unless it names its own crime and place,
in which case the rewriter treats it as new (`Rewrite.kind`). The read line on the reply is what shows the user how it
was taken; that line is the follow-up contract, so no "Follows answer 2" labels or targets are shown.

### Permanent links (later, low priority)

"Copy link" makes a link that reopens that answer with the numbers as they were on the day it was produced (stored by
the answer's cache key and release id from the envelope). Opening it costs no model call. When newer data exists, the
page says so beside the answer. Read-only route, `noindex`, rate-limited.

## What carries over from today's app

The source menu and auto-routing, the tutorial content (moved into Tips and Disclaimers), CSV and image export, query
logging. Not carried over: the left rail, source badges, plan chips, the colored source cards, the "I am a bot" wording.

## Owner's decisions (2026-10-31)

- **Where it lives:** nibrsai.com for now, as this app reskinned; the header's "Current Trends" and "Historical Data
  Library" link out to crimeindex.org. It becomes part of Crime Index later; keep components portable to the crimeindex
  repo (Next.js, Tailwind v3 CSS modules, ECharts 6).
- **Sources:** all five are added to the new engine before launch. The UI is built against the engine's
  `ShadowOutcome` contract only; there is no adapter to today's `/api/query`, `/api/shr-query` or `/api/hc-query`.
  Until a source is in the engine, its questions come back as the engine's `route` or `decline` (`notBuilt`) and are
  shown that way; the start page's sources table can mark such a source "Not yet" in the private preview.
- **Single number:** the answer sentence in the chat, nothing else.
- **Click-to-ask list:** a fixed list in the UI for the first build, drafted below; replaced by an engine-supplied list
  when the engine has one.

## Click-to-ask list (draft for review)

The menu offers only questions that the source records (the sources table) and that the engine answers; it never offers
a "why" question (the engine declines causes). The clicked slice is a period (a month, quarter or year) or a category
(a row of a breakdown). Each choice becomes a plain question with the slice's place and period filled in.

| Source | Measure | For a clicked period | For a clicked category |
|---|---|---|---|
| NIBRS | Crime against persons (murder, rape, assaults, robbery victims, kidnapping) | That year by month (from a year) or the whole year by month (from a month); victims by sex, by age, by race; offenders by sex, age, race (agencies only; the engine declines offender breakdowns for states and the nation); victim's relationship to the offender; by weapon; by location type; share cleared; arrests; rate per 100,000 residents; the same for the state; compare with another agency (a nearby agency of the same name or county, as clarify offers) | That category by month over the answer's period (as a condition: "female murder victims ... by month"); that category's share by year |
| NIBRS | Crime against property (burglary, theft, shoplifting, motor vehicle theft, carjacking counted by offense) | By month or whole year by month; by location type; share cleared; arrests; rate per 100,000 residents; the same for the state; compare with another agency. No victim breakdowns (P11). | That category by month |
| NIBRS | Arrests | By arrestee sex, age, race; by month | That category by month |
| Current Trends | Any of the seven Part I crimes | The same months a year earlier; rolling 12 months; rate per 100,000; the nation; compare with another city in the sample; clearances where the agency reports them | None (no breakdowns in this source) |
| Historical | Any Part I crime, agency, state or nation | Every year from 1960 (state, nation) or the agency's first year; rate per 100,000; clearances (agencies and the nation; no state clearance rate, P18); police staffing for that year | None |
| Homicide Reports | Homicides | By weapon; by circumstance; victims by sex, age, race; offenders by sex, age, race; by relationship; that year by month | That category by year |
| Hate Crime | Incidents | By bias motivation; by offense; by location type; by state (nation only) | That bias or offense by year |

Choices the engine would decline for the clicked slice (for example quarters of a breakdown, which it does not answer
yet) are left out rather than shown and declined.

## Open items for the owner

1. **Charts for breakdowns.** The engine sets `delivered.chart` to null for category breakdowns (victim race, weapon,
   location) and draws only time series. This design draws a bar chart from the table when the answer has one category
   grouping, no time grouping and one number column besides any P72 supporting column (the bars use that number
   column; supporting columns are not charted). To confirm.
2. **Sources table contents.** The years and the dots are drafted from today's app and the engine; each needs checking
   against the source before launch (for example whether Current Trends records clearances for every agency).

## Calls made in this design (for the owner to check)

- No band on the conversation page, to give answers the screen; the header tab carries the teal.
- The read line ("Answering ...") is on every answer, including the first, not only on rewritten follow-ups.
- Clarify rows describe the agency type in mono beside the name.
- Tables over about 12 rows scroll inside the answer; shorter tables do not.
- The first build is the private preview behind today's sign-in gate (`middleware.ts`); public access, rate limits and
  abuse protection are a launch decision.
- "Copy link" is hidden until permanent links are built; "Download data" and "Download image" ship in the first build.
- Presentation-only follow-ups ("make it a bar chart", "sort by ...") arrive from the rewriter as
  `Rewrite.kind === "presentation"`; the page redraws the chart and adds no data turn.
- The conversation state the page sends with a follow-up is the previous turn's standalone question (P69 uses only the
  previous turn); the server keeps no session.
- The start page's years and dots come from a JSON file generated from the sources when data is loaded, not from page code.

## Left to the builder

Component structure; ECharts versus another library as long as the output matches Crime Index's `Timeline`; mobile
layout (the chart stacks above the table; the question box stays pinned); loading state wording; keyboard access for
click-to-ask (Enter on a focused row opens the menu).
