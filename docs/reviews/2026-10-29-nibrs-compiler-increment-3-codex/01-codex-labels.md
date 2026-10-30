**All 12 labels ACCEPT; add rolling-gap coverage.** (Codex one-pass label review of LS-303..LS-314 at `1354d27`.)

| Case | Verdict |
|---|---|
| LS-303 separate years | ACCEPT: NIBRS detail; one row per year asked, no unsolicited change |
| LS-304 change | ACCEPT: simple assault victims, 2022 against 2024, counts, change, percent change |
| LS-305 compared with | ACCEPT: 2023 is the baseline |
| LS-306 go up | ACCEPT: P54 supplies 2024 |
| LS-307 this year | ACCEPT: Jan-Sep 2026 against Jan-Sep 2025 (P52, D17, LS-268) |
| LS-308 percent change | ACCEPT: the firearm filter makes it NIBRS's (P01) |
| LS-309 matched months | ACCEPT: both years restricted to January-June |
| LS-310 zero base | ACCEPT: P51 known 0, P55 percent change unavailable, not zero or infinity |
| LS-311 missing months | ACCEPT: answer, no change claim; a Jan-Oct subtotal must not appear as an established 2025 count |
| LS-312 missing month (YTD) | ACCEPT: September stays the release endpoint (P52); the gap does not redefine "latest month" |
| LS-313 rolling | ACCEPT: windows use months before the period start (LS-137, plan-language spec) |
| LS-314 last 12 months | ACCEPT: one total Oct 2025-Sep 2026 (P56), not a rolling series |

Missing-month cases answer rather than decline: D17 shows figures while withholding the change; D04 names gaps; P51
forbids unknown months as zero. Rolling prehistory: "since 2023" restricts displayed endpoints, not source months.

Added as specified (LS-315, LS-316, commit `258b92a`): rolling windows with missing inputs. Greensboro has no data for
Nov-Dec 2025. Since 2025: Jan-Oct 2025 windows complete, later ones missing. Since 2026: every window missing because
the gap is in the prehistory. Rolling rates and rolling plus comparison stay refused.

All 14 labels frozen, reviewed by `codex:inc3-labels-1`.

**Edit after freezing, before the build:** LS-308 now names the state ("Charlotte, North Carolina"). The place index named
the city agency "Charlotte-Mecklenburg", so a bare "Charlotte" found Charlotte County, FL. With the city named
(PLACE_NAMES stop-gap NC0600100 "Charlotte"), a bare "Charlotte" is a city and a county of 100,000+, which P28 asks
about. The label's meaning is unchanged; only the question's place words changed.
