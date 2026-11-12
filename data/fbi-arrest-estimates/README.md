# FBI estimated national arrests, 1970-2025

The FBI's "Estimated Number of Arrests, United States" table (Table 29 in most years; Table 18 in 2016; Tables
23-28 in the 1970s), one row per year and offense, as printed. Collected on the runner laptop on 2026-11-12 (job
FE1); not yet used by the app.

- `estimated_arrests.csv`: 1,877 rows, 55 years (1970-2020, 2022-2025). Offense names are the FBI's own for that year.
- `check_report.csv`: one row per year: printed total, row sum minus total (with and without Suspicion), violent and
  property subtotal differences, method, flags.
- `checks/YYYY.checks.json`: per-year check detail, with the raw text of any mismatch.

Gaps, as decided by Jeff:
- 2021: no national estimate was published.
- Before 1970: the source PDFs have no national estimated-arrests table.

Sources:
- 2020 and 2022-2025: Crime Data Explorer downloads (xlsx/xls).
- 2004-2019: ucr.fbi.gov pages.
- 1995-2003: FBI PDFs and archived pages.
- 1970-1994: scanned PDFs, read from the page image and compared with OCR.

Owner decisions (Jeff, 2026-11-12):
- 1981 keeps the printed numbers. The handwritten drug-abuse corrections on the page are in
  `checks/1981.checks.json` notes only.
- For 1970-1994, one image read plus the OCR comparison and the sum checks is accepted, with no second full read.

Read before using the numbers:
- Rounding: totals before 2000 are printed rounded, and offense rows differ from the printed total by up to a few
  hundred.
  - 1999 is 14,430 above its printed total. The page image matches the stored numbers.
- Suspicion: in 1970-1973, 1976, 1977 and 1986 the printed total includes the Suspicion line. In every other year it
  doesn't.
- `sub_line`: "Manslaughter by negligence" (1970-1977) is marked `sub_line = true` but is its own offense, counted in
  the printed total. When summing to the total, count it.
  - The other sub-lines (the narcotic and gambling breakdowns, 1972-1984) are parts of their parent line and must
    not be added again.
- Categories change over time:
  - arson is listed from 1970 and in property crime from 1979;
  - Runaways appears 1970-2009;
  - "Forcible rape" becomes "Rape" in 2013;
  - Drunkenness is in "All other offenses" under NIBRS from 2021.

Files are stored byte for byte (`.gitattributes`: `-text`), so their sha256s match the runner's originals.
