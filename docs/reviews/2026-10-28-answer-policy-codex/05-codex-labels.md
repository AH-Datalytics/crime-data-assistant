```json
{
  "accept": [
    "LS-002", "LS-005", "LS-007", "LS-008", "LS-009", "LS-010",
    "LS-011", "LS-012", "LS-013", "LS-014", "LS-015", "LS-016",
    "LS-017", "LS-018", "LS-019", "LS-020", "LS-027", "LS-033",
    "LS-034", "LS-035", "LS-047", "LS-051", "LS-091", "LS-092",
    "LS-093", "LS-095", "LS-101", "LS-105", "LS-106", "LS-107",
    "LS-150", "LS-151", "LS-160", "LS-163", "LS-170", "LS-172",
    "LS-188", "LS-199", "LS-209", "LS-211", "LS-214", "LS-215"
  ],
  "change": {
    "LS-001": {
      "issue": "The national scope default is untracked.",
      "fix": "Add P12. Retain state grouping, prosecution-declined numerator, and all-cleared-rapes denominator."
    },
    "LS-004": {
      "issue": "Ranking dependencies and denominator semantics are incomplete.",
      "fix": "Add D05 and P17. Keep all reported rapes as the denominator; restrict only the numerator to prosecution-declined clearances. Preserve the inherited state ranking and 2025, with deterministic alphabetical ties."
    },
    "LS-006": {
      "issue": "The alternative uses a percentage as its base unit and omits the city-agency dependency.",
      "fix": "Encode murder clearances divided by murders known, statistic=share, with percentage presentation. Add P16, D14 and D25; explicitly name Houston PD in the offered alternative."
    },
    "LS-021": {
      "issue": "The murder unit is source-specific and the city default is untracked.",
      "fix": "Set murder unit=victim and add P16. Preserve Ward Police Department, Arkansas, and Historical. Treat any reported-zero or coverage assertion as conditional on independent rows."
    },
    "LS-022": {
      "issue": "Decline contradicts GC-022's requirement to answer this question about the data.",
      "fix": "Set action=answer with a definitional meaning: source=nibrs, national data scope, period.rule='not applicable: definitional answer', measure='available geographic detail', unit='geographic level', statistic=list, values=not_checkable. Require prose explaining that ZIP-level geography is absent, no structured rows, and no city substitute."
    },
    "LS-023": {
      "issue": "The nearest alternative drops the requested Black-victim restriction.",
      "fix": "Add filter 'victim race: Black', remove the all-races grouping, and add P16. Preserve Detroit, 2023, SHR and murder-victim count."
    },
    "LS-024": {
      "issue": "The nearest alternative drops the requested female-victim restriction.",
      "fix": "Add filter 'victim sex: female', remove the all-sex grouping, and add P16. Preserve Chicago, robbery victims and the P06 period."
    },
    "LS-028": {
      "issue": "The question supplies no murder measure, but the alternative invents one.",
      "fix": "Keep the truthful D03 decline and set alternative=null. Remove P06/P12 if they no longer support an encoded meaning."
    },
    "LS-031": {
      "issue": "The follow-up does not fully preserve its demographic and period context.",
      "fix": "Add P23 and D04. Preserve the requested 2000-2026 bounds, naming unavailable years. Retain Black, Asian and White race categories and Hispanic ethnicity distinctly, plus offender sex. Repeat the unknown-demographics caveat."
    },
    "LS-036": {
      "issue": "The NIBRS reporting-population rate rule is missing.",
      "fix": "Add P15. Specify per 100,000 residents of the reporting agency, with population weighted by reported months as applicable, and require that wording. Preserve 2021-2025 and missing-year disclosure."
    },
    "LS-037": {
      "issue": "The NIBRS reporting-population rate rule is missing.",
      "fix": "Add P15. Specify per 100,000 residents of the reporting agency, with population weighted by reported months as applicable, and require that wording."
    },
    "LS-038": {
      "issue": "Neither the cleared numerator nor the complete sex-offense set is encoded.",
      "fix": "Encode cleared sex offenses divided by reported sex offenses, statistic=share. Enumerate rape, sodomy, sexual assault with an object, fondling, incest and statutory rape identically in numerator and denominator."
    },
    "LS-040": {
      "issue": "Murder units, city-default dependency and a gold statement are incomplete.",
      "fix": "Set murder unit=victim; add P16 and name Philadelphia PD. Explicitly prohibit silently recutting earlier years to match partial 2026, as the gold expectation requires."
    },
    "LS-041": {
      "issue": "The principal-agency default is untracked.",
      "fix": "Add P16 and require naming NYPD. Preserve the monthly murder-victim meaning and all gold boundary, gap and partial-year statements."
    },
    "LS-042": {
      "issue": "The two city-to-agency defaults are untracked.",
      "fix": "Add P16 and require naming Milwaukee PD and Chicago PD. Preserve separate annual figures and D17's matching-month condition."
    },
    "LS-043": {
      "issue": "The city-to-agency default is untracked.",
      "fix": "Add P16 and require naming Houston PD. Preserve theft from motor vehicle, clearance status, annual grouping and the requested 2018-2026 bounds."
    },
    "LS-046": {
      "issue": "The city-to-agency defaults are untracked.",
      "fix": "Add P16 and require naming both agencies. Preserve the requested 1930 start, outside-coverage disclosure, missing years and prohibition on an unsolicited rape-definition note."
    },
    "LS-048": {
      "issue": "The city-to-agency defaults are untracked.",
      "fix": "Add P16 and require naming the St. Louis city and Chicago agencies. Preserve separate murder-victim rates and the requested 1950 start."
    },
    "LS-052": {
      "issue": "Seattle's principal-agency default is untracked.",
      "fix": "Add P16 and require naming Seattle PD. Retain the source switch only on independently established period availability; a draft source-wide maximum is not proof."
    },
    "LS-054": {
      "issue": "Homicide interpretation, two-stage ordering and sample scope are incomplete.",
      "fix": "Add P10/P17. Select the 20 most populous city agencies first, then sort that set by 2026 YTD murder rate, breaking ties alphabetically by agency name. Set cohort=source_sample and name the RTCI sample."
    },
    "LS-055": {
      "issue": "The national trend's matched reporting cohort is not encoded.",
      "fix": "Set cohort=same_agencies within the RTCI sample and name that scope. Keep full-year counts separate from any explicitly matched-month change calculation; preserve all D06/D17 conditions."
    },
    "LS-056": {
      "issue": "The options omit completeness/tie policies and leave the Both ranking ambiguous.",
      "fix": "Add P04/P17/P22. Each option must use full-year reporters within source_sample. Rank by the chosen rate; Both ranks by the combined violent-plus-property rate. Preserve latest complete year, top 1 and alphabetical agency-name ties."
    },
    "LS-068": {
      "issue": "The national figure does not explicitly identify its source sample.",
      "fix": "Require identification of consistent reporters within the Current Trends sample, alongside the excluded-agency count and count/percentage changes. Retain same_agencies."
    },
    "LS-069": {
      "issue": "Annual participation is incorrectly put under the fixed crime-count cohort.",
      "fix": "Add P12. Distinguish each year's all-reporting agency participation count from hate-crime incidents for the fixed same-agency cohort. State that these figures cannot isolate true crime change from every reporting change."
    },
    "LS-071": {
      "issue": "The inherited principal-agency mapping is untracked.",
      "fix": "Add P16 and require naming Dallas PD. Preserve the 2010-on annual series, P23 inheritance and repeated caveats."
    },
    "LS-072": {
      "issue": "Inherited-context dependencies and the gold caveat are incomplete.",
      "fix": "Add P23/P16. Preserve the Santa Clara County city-agency scope and annual alternative, and include the applicable coverage caveat in full in the decline. Do not substitute the county sheriff."
    },
    "LS-073": {
      "issue": "The inherited principal-agency mappings are untracked and the murder-clearance unit is inconsistent.",
      "fix": "Add P16 and D01/D18. Name all 36 agencies; count cleared murders consistently with the murder-victim base. Preserve 2024, separate agencies and all clearance categories."
    },
    "LS-076": {
      "issue": "A named sheriff agency is typed as a county geography and D10 is omitted.",
      "fix": "Set every option's place to kind=agency, Cook County Sheriff's Office, IL. Add D10/P22. Preserve the three crime choices and P06 year."
    },
    "LS-078": {
      "issue": "The decline falsely denies data for every place inside a county.",
      "fix": "Keep the gold-required decline and null alternative, but say the sources lack the requested sub-agency areas. Do not claim that separately administered cities or agency jurisdictions within a county have no data."
    },
    "LS-079": {
      "issue": "A named sheriff agency is typed as a county geography.",
      "fix": "Set place.kind=agency for Baldwin County Sheriff's Office. Preserve D10 naming and the P10 murder-victim meaning."
    },
    "LS-082": {
      "issue": "The binding counting-unit dependency is missing.",
      "fix": "Add D18. Preserve both explicitly named agencies, separate results, 2020-2025 and the existing victim/offense units."
    },
    "LS-083": {
      "issue": "Grouping crimes by offender age is silently converted into counting offenders.",
      "fix": "Count violent crimes using D18's FBI composite units, grouped by linked offender age. Deduplicate crimes within each age group and disclose that multi-offender crimes may occur in multiple age groups. Do not use offender count as the crime count."
    },
    "LS-084": {
      "issue": "Rape uses a source-specific offense unit instead of the source-neutral person-crime unit.",
      "fix": "Set rape unit=victim under D18. Preserve the disclosed rape proxy, national series and mandatory 2013-definition statement."
    },
    "LS-085": {
      "issue": "Person-crime units conflict with D18.",
      "fix": "Set murder, rape and aggravated-assault units=victim; retain property/robbery offense units and the FBI violent-crime composite. Add D18/D04 and preserve the no-2013-note requirement for 2020-2025."
    },
    "LS-086": {
      "issue": "The clearance fraction lacks an explicit cleared numerator and consistent share semantics.",
      "fix": "Encode cleared rapes divided by all reported rapes in the same reporting cohort, statistic=share, with percentage presentation and consistent person-crime units. Preserve coverage and the no-2013-note statement; listing P02 does not establish its data condition."
    },
    "LS-087": {
      "issue": "The gold outside-coverage requirement is weakened to merely naming the range.",
      "fix": "Explicitly identify a requested start/end outside coverage when applicable, as well as interior missing state-years. Preserve the no-2013-definition-note rule."
    },
    "LS-088": {
      "issue": "Follow-up context is untracked and the missing-code explanation could guess a cause.",
      "fix": "Add P23. Enumerate the commercial-location set in the meaning. Explain empty or unknown location categories only from independently established conditions; do not equate an empty cell with zero robberies."
    },
    "LS-094": {
      "issue": "Inherited city mapping and officer/employee semantics are incomplete.",
      "fix": "Add P23/P16 and D26/D04. Preserve Chicago and the requested 1930-2026 bounds; offer the available staffing trend with truthful missing years and distinct officer versus employee units."
    },
    "LS-096": {
      "issue": "The gold internal-failure statement and tie policy are missing.",
      "fix": "Add P17 and deterministic alphabetical ties. Require that an internal execution failure be identified as an app failure, never missing data or zero. Preserve the gold-required limit 20 despite the singular wording."
    },
    "LS-097": {
      "issue": "Murder units and a conditional gold expectation are missing or wrong.",
      "fix": "Set murder unit=victim. Require that internal failure be described as app failure, never missing data or zero. Preserve both agencies and ten complete years."
    },
    "LS-098": {
      "issue": "Last year is replaced by latest available complete year, and gold failure wording is omitted.",
      "fix": "Add P07. Compare 2025 with 2024 as of this review, rather than arbitrary latest years. If 2025 is unavailable, apply P07's explicit decline/offer behavior rather than substituting silently. Add the gold app-failure statement."
    },
    "LS-099": {
      "issue": "Murder units and the gold failure statement are incomplete.",
      "fix": "Set murder unit=victim; add D27 and the conditional app-failure-not-missing-data statement. Preserve separate Chicago and Illinois sample figures over the same months."
    },
    "LS-108": {
      "issue": "The median's measured unit is wrong.",
      "fix": "Use measure='murder victim age', unit='years of age', statistic=median. Encode exclusion of unknown/invalid ages in filters; retain firearm and the national annual span."
    },
    "LS-109": {
      "issue": "The source-switching proxy option and button semantics are untracked.",
      "fix": "Add P01/P22 and D04. Preserve Chicago, 2015-on and firearm in both options. Explicitly label aggravated assault as a proxy including people not hit, and name unavailable NIBRS years."
    },
    "LS-110": {
      "issue": "The proxy option's source switch is untracked and can imply actual shooting victims.",
      "fix": "Add P01/P22. Preserve Dallas and the P06 period. Make the assault option explicitly a proxy that includes victims not hit by gunfire."
    },
    "LS-111": {
      "issue": "Offender-age grouping silently changes crimes into offenders.",
      "fix": "Use D18's FBI violent-crime composite counts linked to offender ages, deduplicated within each age group, with cross-group overlap disclosed. Preserve firearm, 2018-2025, the requested consistent cohort and all gold failure statements."
    },
    "LS-114": {
      "issue": "The clearance numerator is implicit and percent is used as a base unit.",
      "fix": "Encode cleared rapes divided by all reported rapes in the same agency/year, statistic=share, using consistent person-crime units. Preserve exactly SFPD plus three population-selected peers and every gold peer statement."
    },
    "LS-115": {
      "issue": "The clearance fraction and follow-up dependency are incomplete.",
      "fix": "Apply the corrected LS-114 clearance-share meaning, add P23, and preserve exactly SFPD plus eight peers, the named population band and the full repeated caveat."
    },
    "LS-116": {
      "issue": "Options omit peer/button dependencies and the population-only peer selection.",
      "fix": "Add D16/P22 and encode peers selected on population alone in every option. Preserve San Francisco, all crime choices, per-100,000 rates and ten complete years; name unavailable years rather than silently shortening the span."
    },
    "LS-118": {
      "issue": "The clearance meaning lacks an explicit numerator and consistent fraction semantics.",
      "fix": "Encode FBI-composite violent crimes cleared divided by violent crimes known in the same agency/year, statistic=share. Preserve the national figure and individual peer rows; add D25."
    },
    "LS-119": {
      "issue": "Clarification dependencies and murder units are incomplete.",
      "fix": "Add D28/P22 and set murder unit=victim in both options. Preserve the DC/state distinction, 2010-on period and respective population denominators."
    },
    "LS-122": {
      "issue": "Homicides grouped by offender age are mislabeled as an offender count.",
      "fix": "Use murder unit=victim grouped by linked offender age, with within-group deduplication and cross-group overlap disclosed. Preserve P10, nationwide scope, 2021-2025 and the explicitly requested same-agency cohort."
    },
    "LS-125": {
      "issue": "The binding peer rule and cleared numerator are missing.",
      "fix": "Add D16. Encode cleared rapes divided by all reported rapes, statistic=share, with consistent person-crime units. Preserve Denver plus exactly three population-selected peers and the named band/year."
    },
    "LS-128": {
      "issue": "Expanding clearance types can exceed the default row limit, and dependencies are missing.",
      "fix": "Add D01/D05/P17. Rank state exceptional-clearance shares, then show one row per selected state with clearance-type shares as columns. Cap at 20 states/rows, use alphabetical ties, and retain all reported rapes as the denominator."
    },
    "LS-129": {
      "issue": "The clearance numerator is implicit and percent is used as the base unit.",
      "fix": "Encode cleared murders divided by all reported murders in each agency/year, statistic=share, with murder-victim units. Preserve seven separate agencies, 2025 and P16."
    },
    "LS-131": {
      "issue": "Separate race filters can mean an impossible conjunction, and clearance semantics are unclear.",
      "fix": "Use one filter 'victim race in {Black, White}', group by race, and calculate cleared murder victims divided by all murder victims of that race in the same year. Preserve Minnesota and P06."
    },
    "LS-133": {
      "issue": "The alternative mixes victim/offense units and has no share denominator.",
      "fix": "Add D03/P11. Count actual violent-crime victims, including robbery victims, by victim race. Set the denominator to all such victims in the same cohort/year and explicitly handle unknown race. Preserve P06/P12."
    },
    "LS-134": {
      "issue": "The composite unit is informal and its binding rule is missing.",
      "fix": "Add D18 and define violent crime as murder, rape and aggravated-assault victim counts plus robbery offense counts. Preserve state/year grouping and the explicitly requested same-agency cohort."
    },
    "LS-140": {
      "issue": "Carjackings use incidents while the corresponding rate case uses offenses.",
      "fix": "Use robbery offenses in which a motor vehicle was taken, unit=offense under D18; do not silently change the counting unit to incidents. Preserve St. Louis, monthly grouping and the ten-year span."
    },
    "LS-141": {
      "issue": "The binding rule used by this duplicate is missing.",
      "fix": "Add D02. Preserve the same decline and null alternative as LS-012."
    },
    "LS-144": {
      "issue": "Montgomery County Police Department contradicts D10's sheriff default.",
      "fix": "Use Montgomery County Sheriff's Office, MD, kind=agency in every option. Add D09/D10/D28/P22. Preserve the period and three choices. If sheriff data cannot run, mark that branch unresolved; do not substitute the county PD."
    },
    "LS-148": {
      "issue": "The clearance rule and denominator contract are incomplete.",
      "fix": "Add D01. Retain all reported rapes as the denominator, exceptional-type numerators and state grouping. Use the same definition as LS-128, not the share of already-cleared rapes."
    },
    "LS-149": {
      "issue": "Fairfax County Police Department contradicts D10.",
      "fix": "Replace it with Fairfax County Sheriff's Office, VA, kind=agency; add D10 and name the sheriff in statements. Preserve 2025 and P10. If the sheriff cannot answer, leave unresolved rather than substituting the county PD."
    },
    "LS-152": {
      "issue": "The clearance rule is missing and the statement asserts unverified missing-city coverage.",
      "fix": "Add D01. Preserve all Group A cleared offenses, 36 agencies, 2025 and clearance type. Remove the assertion that New York lacks 2025 data unless independently established."
    },
    "LS-154": {
      "issue": "The clearance share has no encoded cleared numerator.",
      "fix": "Encode motor-vehicle-theft offenses cleared divided by all reported motor-vehicle-theft offenses in the same agency/year, statistic=share, with percentage presentation. Preserve Omaha and the ten-year span."
    },
    "LS-155": {
      "issue": "Grouping crimes by offender race is silently converted into counting offenders.",
      "fix": "Use D18's FBI composite crime counts linked to offender race, deduplicated within race, with cross-group overlap disclosed. Preserve firearm, 2017-2025, national scope and explicitly requested consistent reporters."
    },
    "LS-157": {
      "issue": "Historical's storage label replaces the source-neutral murder unit.",
      "fix": "Set murder unit=victim and add D18. Preserve Historical, Chicago PD, 2024, P01/P16 and source/agency statements."
    },
    "LS-158": {
      "issue": "Historical's storage label replaces the source-neutral murder unit.",
      "fix": "Apply exactly the corrected LS-157 meaning: murder unit=victim under D18, with all other fields retained."
    },
    "LS-159": {
      "issue": "The city option and clarification dependencies are untracked.",
      "fix": "Add P16/D28/P22. Preserve both New York geographies, 2023 and anti-Jewish bias. Name NYPD for the city option and distinguish bias motivation from victims' actual religion."
    },
    "LS-161": {
      "issue": "Murder is labeled as offenses instead of victims.",
      "fix": "Set murder unit=victim and add D18. Preserve Dallas, RTCI, year-to-date and the explicit month range."
    },
    "LS-167": {
      "issue": "Rate scale, murder unit and tie policy are incomplete.",
      "fix": "Set murder unit=victim and denominator='agency residents, per 100,000'. Add P17 and alphabetical agency-name ties. Preserve full-year eligibility, exclusion count and source_sample."
    },
    "LS-168": {
      "issue": "The proposed tie policy is missing.",
      "fix": "Add P17 and require alphabetical agency-name ties after motor-vehicle-theft count. Preserve full-year reporters, excluded count and the default 20 rows."
    },
    "LS-169": {
      "issue": "Murder units, ties and default-limit disclosure are incomplete.",
      "fix": "Set murder unit=victim; add P17; require alphabetical agency-name ties and an explicit 20-row limit statement. Preserve latest complete year, full-year reporters and source sample."
    },
    "LS-171": {
      "issue": "P16's agency naming is absent from statements.",
      "fix": "Require naming Houston Police Department, alongside the year range and missing-year disclosure."
    },
    "LS-173": {
      "issue": "The state-sample rule used by the label is missing.",
      "fix": "Add D27. Preserve calendar-year-before-today and explicitly identify the Texas agencies in the national RTCI sample."
    },
    "LS-175": {
      "issue": "The city ranking omits proposed completeness/tie rules and rate scale.",
      "fix": "Add P04/P17, restrict to full-year reporters, state the excluded count, use per 100,000 agency residents, and break ties alphabetically by agency name. Preserve Historical, 2023, the 250,000 threshold and top 1."
    },
    "LS-176": {
      "issue": "The principal-agency naming requirement is missing.",
      "fix": "Require naming Phoenix PD alongside the aggravated-assault interpretation. Retain victim units."
    },
    "LS-177": {
      "issue": "The person-crime unit and agency statement are incomplete.",
      "fix": "Set aggravated-assault unit=victim under D18 and require naming Phoenix PD. Preserve P09 and RTCI."
    },
    "LS-178": {
      "issue": "The label relies on P16 without requiring agency naming.",
      "fix": "Require naming Memphis PD. Preserve SHR, 2023 and murder/non-negligent-manslaughter victims."
    },
    "LS-179": {
      "issue": "The label relies on P16 without requiring agency naming.",
      "fix": "Require naming Memphis PD. Preserve NIBRS, 2023 and murder/non-negligent-manslaughter victims."
    },
    "LS-183": {
      "issue": "Options omit tie policy and rate scale; murder uses the wrong semantic unit.",
      "fix": "Add P17/P22. Specify per 100,000 agency residents and alphabetical agency-name ties in every option; set murder unit=victim. Preserve latest complete year, full-year reporters, all three choices and bottom 1."
    },
    "LS-184": {
      "issue": "Options omit tie policy and rate scale; murder uses the wrong semantic unit.",
      "fix": "Apply the corrected LS-183 option semantics, retaining this case's top-1 direction."
    },
    "LS-185": {
      "issue": "Murder units and required agency naming are incomplete.",
      "fix": "Set murder unit=victim and require naming Chicago PD. Preserve the single Historical source and exact 1990-2024 span, with actual gaps disclosed."
    },
    "LS-186": {
      "issue": "The exact rate denominator is underspecified.",
      "fix": "Encode per 100,000 residents of reporting agencies, with population weighted by reported months as applicable. Preserve the required P15 wording."
    },
    "LS-187": {
      "issue": "The options omit the dependency governing preserved button meaning.",
      "fix": "Add P22. Preserve all three choices, LVMPD and 2024, and require the agency to be named when the selected option runs."
    },
    "LS-189": {
      "issue": "Murder units and P04's excluded-count explanation are incomplete.",
      "fix": "Set murder unit=victim and require the number excluded for fewer than twelve reporting months. Preserve exactly ten rows, alphabetical agency-name ties and sample disclosure."
    },
    "LS-192": {
      "issue": "The alternative's source choice is untracked.",
      "fix": "Add P01. Explicitly offer two separate Historical series, violent crime and property crime, not a single defined crime count. Preserve the forecast decline, Chicago PD and P20 ten-year period."
    },
    "LS-194": {
      "issue": "The alternative offers latest complete year instead of P24's latest available year.",
      "fix": "Offer Denver burglaries for the latest year actually available, through its latest month if partial. State the exact coverage and name Denver PD; do not substitute 2025 merely to obtain a complete year."
    },
    "LS-195": {
      "issue": "The sheriff agency is typed as a county geography.",
      "fix": "Set place.kind=agency for Cook County Sheriff's Office. Preserve 2022, the count and explicit sheriff naming."
    },
    "LS-196": {
      "issue": "The NIBRS violent-crime unit can be read as counting person-crime offense records.",
      "fix": "Add D18 and explicitly define violent crime in both affected options as murder/rape/aggravated-assault victims plus robbery offenses. Keep property crime by offense. Apply the identical meaning to LS-216."
    },
    "LS-197": {
      "issue": "Murder units and coverage limits of the alternative are incomplete.",
      "fix": "Set murder unit=victim. Preserve ten complete years but name any years RTCI does not hold as missing and identify its reporting sample. Do not imply ten years of national estimates."
    },
    "LS-198": {
      "issue": "Partial coverage is treated as a proved explanation of the lower count, and D17 is missing.",
      "fix": "Add D17 and set murder unit=victim. Explain that the displayed periods differ and cannot establish an annual decline; do not assert partial coverage is the sole cause of the lower count."
    },
    "LS-202": {
      "issue": "The cross-source proxy is untracked and can be mistaken for people actually shot.",
      "fix": "Add P01/D28. Keep the D14 clarification, but explicitly label firearm aggravated assault as a proxy including victims not hit. Preserve Chicago, 2024, firearm and P22."
    },
    "LS-203": {
      "issue": "The meaning does not explicitly retain Austin alongside its peers or specify rate scale.",
      "fix": "Encode Austin plus peers selected on population alone. Use per 100,000 agency residents and require naming Austin PD, every peer and the population band."
    },
    "LS-207": {
      "issue": "D22 requires monthly coverage, but the meaning encodes an undefined annual share.",
      "fix": "Group by month; measure covered residents, unit=resident, statistic=share, denominator=Florida resident population for the corresponding calculation. Return January-December 2024 percentages and name missing months."
    },
    "LS-212": {
      "issue": "Absolute versus percentage increase can produce different state rankings.",
      "fix": "Set action=clarify under D28 with 'Increase in count' and 'Percentage increase'. Both options retain NIBRS murder victims, state grouping, 2022 versus 2024, agencies reporting completely throughout 2022-2024, and top 20. Specify each ranking metric; percentage change divides by 2022 count and excludes undefined zero baselines. Add D05/P17/P22; retain D07/P03 and exclusion-count disclosure."
    },
    "LS-213": {
      "issue": "The draft misreads D11; a direct rape series crossing 2013 requires the note.",
      "fix": "Require the FBI's 2013 rape-definition-change statement, consistent with GC-085, and set rape unit=victim. Preserve the national 2010-2016 series."
    },
    "LS-216": {
      "issue": "The button reproduces LS-196's ambiguous counting unit.",
      "fix": "Apply exactly the corrected LS-196 violent-crime meaning under D18. Preserve Denver, 2024 and no repeated clarification."
    },
    "LS-217": {
      "issue": "The inherited P16 agency naming is absent.",
      "fix": "Require naming Chicago PD. Preserve firearm murder victims and the prohibition on re-asking the resolved choice."
    },
    "LS-218": {
      "issue": "The button lacks the parent's tie rule, rate scale and P04 exclusion-count explanation.",
      "fix": "Add P17 and preserve exactly LS-183's corrected violent-rate meaning, including per-100,000 scale and alphabetical agency-name ties. Name Historical and the full-year exclusion count. Do not re-ask the measure."
    }
  },
  "unresolved": {
    "LS-003": "State-level 'where' is invented; agency versus state is material and D28 provides no default. GC-003 requires an answer and a 20-row ranking. Owner resolution is needed rather than silently choosing geography.",
    "LS-025": "The alternative drops women and lacks P03's default cohort and P02 coverage handling. Preserve female victims, add those dependencies, and independently establish that the national alternative can run.",
    "LS-026": "Chicago robbery-arrest availability for the proposed default year is explicitly unverified. Establish a runnable agency/year independently; P16 is also missing.",
    "LS-029": "The draft substitutes all juvenile arrests for juvenile crime, and Minneapolis NIBRS coverage for 2020-2025 is unverified. Neither the exact alternative nor its runnability is established.",
    "LS-030": "The national ten-year offender-count alternative omits P03's default cohort and P02's coverage condition. Establish the qualifying cohort before treating the alternative as runnable.",
    "LS-032": "The question asks for a share of crimes, but the draft counts offenders. It also disagrees with LS-121 about including unknown ages. Resolve attribution and denominator; GC-032 requires figures, so clarification cannot silently replace its gold answer.",
    "LS-039": "Rape is substituted for broader sexual assault. P04 is listed but not implemented, while implementing it conflicts with GC-039's prohibition on unrequested eligibility filters. Resolve both conflicts and the tie policy.",
    "LS-044": "The label assumes partial SHR 2026 coverage, while another draft cites a 2025 maximum. No independent Boston/month evidence establishes the answer branch.",
    "LS-045": "Retain unresolved. The gold rule says the old local artifact is not deployment-aligned; independently establish May 2026 coverage for Kalamazoo city before choosing answer or decline.",
    "LS-049": "NYPD's NIBRS coverage for the 2026 extension is unverified. A source-wide maximum does not establish this agency's branch. Preserve the monthly setup and add P23 once established.",
    "LS-050": "The partial SHR 2026 ranking is unsupported and conflicts with other draft coverage notes. Once established, also retain the follow-up dependency, P17 ties and source coverage caveats.",
    "LS-053": "Allentown's 2026 reporting is explicitly unverified. A source-wide maximum cannot establish its answer branch. The eventual rate also needs P15/P16.",
    "LS-057": "Gold forbids additional eligibility filters, while proposed P04 excludes incomplete agencies. Resolve that conflict rather than silently ignoring P04. The eventual ranking also needs P17.",
    "LS-058": "Gold forbids additional eligibility filters, while proposed P04 excludes incomplete agencies. Resolve that conflict and apply P17 to the resulting city ranking.",
    "LS-059": "Gold forbids additional eligibility filters, while proposed P04 excludes incomplete agencies. Resolve that conflict; also track P10/P17 and canonical murder units.",
    "LS-060": "Population rank versus homicide-rate rank is materially ambiguous. The draft admits both readings, while GC-060 requires the answer/limit. Resolve the metric; P10/P15 are also missing.",
    "LS-061": "The gold no-additional-filter requirement conflicts with P04 completeness eligibility. Resolve the conflict while preserving the requested 30-murder minimum, firearm share and ten cities.",
    "LS-062": "The gold no-additional-filter requirement conflicts with P04. Resolve it while preserving the requested 250,000 threshold; P15/P17 also apply.",
    "LS-063": "The gold no-additional-filter requirement conflicts with P04. Resolve it, use the same carjacking unit as LS-140, and track P15/P17.",
    "LS-064": "The gold no-additional-filter requirement conflicts with P04. Also resolve whether 'currently' means YTD rather than a completed year, and preserve the strict 'over 100k' threshold rather than silently changing it to at least 100k.",
    "LS-065": "Absolute versus percentage decrease can select different offenses. The label also omits the gold-required excluded count and explicit full reporting in both years. Resolve the ranking metric without dropping the gold answer.",
    "LS-066": "No offense is named. Clarification fits D28, but GC-066 requires a completeness-filtered ranking and exclusion-count explanation on the scored turn. These cannot silently be deferred to a future button.",
    "LS-067": "The draft invents 2020 versus 2023 for early 2020s. Other endpoints or an every-year test can select different cities. Gold requires a comparison, so resolve the period and test.",
    "LS-070": "The setup changes the year to '20206' and then says only 'range'. Nothing establishes that this restores 2018-present. Preserve Detroit and the rolling rate but leave the period unresolved.",
    "LS-074": "Lewis County sheriff membership/coverage in RTCI is explicitly unverified. Gold requires county-agency rows; establish the runnable source independently and use kind=agency.",
    "LS-075": "The unconditional national ten-year answer bypasses P02's threshold. The consistent cohort's coverage is unknown and gold requires an answer. Resolve P02/P03 and define the nonviolent remainder without double-counting.",
    "LS-077": "The options assert Mesa RTCI coverage for 2017-present without verification. P01/P14 do not justify this source without the requisite span coverage. Resolve every option's runnable source while preserving D09.",
    "LS-080": "Essex sheriff 2022 clearance coverage is unverified, and arrests cleared has been changed to offenses cleared. Establish the intended metric and the exact county identity required by GC-081.",
    "LS-081": "The draft invents violent-plus-property clearance without an offense default, and county-sheriff availability is unverified. Gold requires county-agency rows; resolve the measure and entities.",
    "LS-089": "The explanation depends on an unseen chart/setup result. The draft invents the overview measure and period and suggests unverified causes. Independent question-side/setup evidence is needed.",
    "LS-090": "The setup's top-ten metric is unspecified. Equal counts do not prove an app error. The gold substantive explanation cannot be established from the question alone or inferred from candidate output.",
    "LS-100": "Retain unresolved. No offense, age role or usable context is supplied, but GC-101 requires a substantive answer. Do not manufacture a measure.",
    "LS-102": "The mandatory proxy is identified correctly, but Baltimore NIBRS availability is unverified. Establish a runnable span; a monthly trend should use P06's trend span, and the cross-source alternative needs P01.",
    "LS-103": "Baltimore NIBRS coverage for the firearm-assault rate alternative is unverified. Establish the span independently and add P01/P15 while preserving the requested years and firearm filter.",
    "LS-104": "The claim that NIBRS has no 2026 data conflicts with other drafts and is unproved for Aurora. Establish its coverage before moving the alternative to another year under P24.",
    "LS-112": "Identical wording in LS-145 uses a different offense set. Gun crimes can also mean weapons-law violations. No approved default resolves this; agree one shared meaning while retaining GC-113's answer/failure requirements.",
    "LS-113": "The unconditional national arrest series bypasses P02; Group A/Group B availability and the threshold are unestablished. P03's default cohort is also missing. Resolve without dropping gold answerability.",
    "LS-117": "Comparison years, absolute versus percentage decline, and national/peer average weighting are unspecified. The meaning does not encode actual averages or the gold-required individual peer rows.",
    "LS-120": "Apply the same unresolved treatment as LS-045. The gold coverage rule expressly rejects using the old local artifact alone to establish Flagstaff May 2026 outside-coverage status.",
    "LS-121": "Same unresolved meaning as LS-032: crimes versus offenders and the unknown-age denominator are not decided. Identical wording cannot have different denominators.",
    "LS-123": "This replay fragment has no setup. Missing context is not an unanswerable-data decline, and two complete runnable clarification meanings cannot be constructed without inventing the missing question.",
    "LS-124": "Possession/distribution arrests are narrowed activities, but the draft counts all drug/narcotic violations. The supplied material does not establish an arrest-level activity filter or equivalence to all 35A arrests.",
    "LS-126": "The default Maine consistent-reporter series has no established qualifying cohort or coverage. P02 is missing and may change the action. Do not interpret an empty cohort as zero or silently shorten the span.",
    "LS-127": "The national count requires P02's coverage condition, which is explicitly unknown. Listing P02 does not justify an unconditional answer.",
    "LS-130": "D22 defines monthly covered population, but no annual aggregation is specified. December population, mean monthly coverage and population reporting at any time differ. Resolve the annual definition; add D22/P12.",
    "LS-132": "The national count's P02 condition is unestablished. Independently, explicit victims requires P11 and actual robbery victims, not the draft's mixed victim/offense unit.",
    "LS-135": "As in LS-124, the requested possession/distribution subset is not established as equivalent to all drug/narcotic arrests. Preserve Tucson and 2025 while resolving the runnable measure.",
    "LS-136": "The replay continuation has no setup. A decline is the wrong diagnosis, and complete runnable clarification options cannot be invented from the fragment.",
    "LS-137": "The default Texas consistent-reporter series lacks an established cohort and P02 coverage treatment. Preserve the rolling windows, including prerequisite months, rather than silently shortening the series.",
    "LS-138": "The default Maryland consistent-reporter series lacks an established cohort and P02 coverage treatment. Preserve arrestee ages and the requested 2022-2026 monthly span.",
    "LS-139": "Rate-point change versus percentage change is unresolved, rate scale is absent, and state coverage is unestablished. Preserve the five named measures; do not invent a sixth or silently choose normalization.",
    "LS-142": "The proposed national 2010-present offender-count alternative has unverified consistent-cohort coverage and omits P02. Establish runnability while preserving D03/P03/P12.",
    "LS-143": "The state clearance count omits D01 and P02; Virginia coverage is unestablished. Encode exceptional-clearance murders explicitly and use a consistent murder counting unit once the action is supportable.",
    "LS-145": "Same wording as LS-112 but a narrower violent-crime offense set. Resolve one shared gun-crime meaning; neither draft is sufficient authority.",
    "LS-146": "The possession/distribution restriction is not established as runnable or equivalent to all 35A arrests. Preserve Yuma and 2025 while resolving the exact or explicitly broader alternative.",
    "LS-147": "Unlike LS-115, this replay continuation has no setup. Missing context cannot be labeled as a data decline or replaced by invented comparison details.",
    "LS-153": "The unconditional national 2025 burglary count requires independently established P02 coverage. Location grouping does not establish that condition.",
    "LS-156": "The possession/distribution restriction is not established as runnable or equivalent to all 35A arrests. Preserve Avondale and 2025 while resolving the measure.",
    "LS-162": "The meaning fixes officers while statements permit employees. D26's fallback depends on whether an officer count exists. Establish the agency-year condition and encode the actual measure/unit.",
    "LS-164": "The below-80% California 2018 claim is explicitly assumed, not independently established. Verify P02 before choosing decline; the alternative's rape semantic unit also needs correction.",
    "LS-165": "The default consistent-reporter Texas comparison lacks established cohort coverage and omits P02. Resolve the P02/P03 interaction; a cohort sentence alone does not support the unconditional answer.",
    "LS-166": "The Florida cohort may be empty or small, but the draft unconditionally answers. Establish the cohort and P02/P03 treatment; never present an empty cohort as zero.",
    "LS-174": "Retain unresolved. Establish whether Texas NIBRS holds 2025 and satisfies P02 before choosing P07's answer or decline branch; add P02.",
    "LS-180": "Ohio 2024 coverage clearing P02 is explicitly assumed. Establish it and list P02; retain the requested theft-victim unit under P11.",
    "LS-181": "The statewide theft total requires the same independently established P02 condition as LS-180. Preserve offense units once the action is supportable.",
    "LS-182": "Retain unresolved. P12 establishes the United States, but independent 2024 NIBRS coverage is required for P02's 80% decision.",
    "LS-190": "P18 requires two alternatives, but decline.alternative permits one. The draft drops Ohio NIBRS cleared burglaries. Preserve decline and both options through an approved representation correction; do not relabel it clarify to evade the limitation.",
    "LS-191": "Seizure/property-record count and incident count can differ. The draft assumes incidents with drug violations without establishing that unit. Resolve the runnable synthetic-narcotics seizure measure and applicable P02 treatment.",
    "LS-193": "P21's decline is valid, but the no-current-month-data claim is unsupported and shooting remains fatal/nonfatal ambiguous. Establish whether a same-city/month alternative can run before deciding null.",
    "LS-200": "The D03 decline is valid, but Chicago 2024 NIBRS availability is explicitly unverified. Establish a runnable alternative and preserve the Black-victim filter rather than broadening to all races.",
    "LS-201": "The Georgia robbery-arrest alternative lacks P02 and independently established statewide reporting coverage. Preserve the conviction decline, but do not promise an unsupported runnable state total.",
    "LS-204": "The drug-crime definition follows D19, but the statewide NIBRS total lacks P02 and established Kentucky 2024 coverage. That condition can change the expected action.",
    "LS-205": "The relationship definition follows D20, but the statewide NIBRS total lacks P02 and established Texas 2023 coverage.",
    "LS-206": "The D21 definition is represented, but California 2024 coverage is not established under P02. A note that coverage applies is not a threshold check.",
    "LS-208": "The city/state question is appropriate, but NYPD 2021 availability and New York State's P02 condition are unestablished. Both unconditional answer buttons are unjustified. Add D28/P16/P02 and preserve D23's exact exclusions.",
    "LS-210": "As in LS-162, officer versus employee availability determines the actual measure. A text marker cannot make employee counts satisfy unit=officer; establish the independent agency-year condition."
  },
  "cross_case": [
    {
      "issue": "Identical youth-share wording has incompatible denominators.",
      "cases": ["LS-032", "LS-121"],
      "correction": "Resolve crimes versus offenders, multi-offender attribution and unknown-age handling once, then use the identical meaning."
    },
    {
      "issue": "Identical gun-crime wording has incompatible offense sets.",
      "cases": ["LS-112", "LS-145"],
      "correction": "Choose one independently justified measure; preserve the gold requirements rather than treating either draft as authoritative."
    },
    {
      "issue": "Context differences must not be mistaken for label inconsistency.",
      "cases": ["LS-071", "LS-090", "LS-115", "LS-123", "LS-147", "LS-214"],
      "correction": "Preserve supplied setup. The replay fragments lacking setup cannot inherit the gold cases' meaning merely because their final wording matches."
    },
    {
      "issue": "County police substitutions violate the binding sheriff default.",
      "cases": ["LS-074", "LS-076", "LS-079", "LS-080", "LS-144", "LS-149", "LS-195"],
      "correction": "Apply D10 without inventing county-PD exceptions. Type named sheriff entities as agencies, and do not imply countywide geographic totals."
    },
    {
      "issue": "Source-neutral person-crime units vary between victim and offense across drafters.",
      "correction": "Apply D18 consistently across NIBRS, SHR, Historical and RTCI. Storage terminology does not determine semantic units. Preserve the FBI composite counting convention for violent crime; explicit victims invokes P11."
    },
    {
      "issue": "Offender grouping is repeatedly treated as an instruction to count offenders.",
      "cases": ["LS-083", "LS-111", "LS-122", "LS-155"],
      "correction": "Distinguish crimes grouped by linked offender characteristics from counts of offenders, and define deduplication and cross-group overlap."
    },
    {
      "issue": "Carjacking units disagree.",
      "cases": ["LS-063", "LS-140"],
      "correction": "Use one approved offense/incident definition in both; D18 supports offense units for the robbery-based measure unless an explicit exception is established."
    },
    {
      "issue": "Binding gold eligibility requirements conflict with proposed P04.",
      "cases": ["LS-039", "LS-057", "LS-058", "LS-059", "LS-061", "LS-062", "LS-063", "LS-064"],
      "correction": "Keep these conflicts unresolved for the owner. Do not silently drop either the gold no-extra-filter requirement or proposed completeness exclusion."
    },
    {
      "issue": "Equivalent coverage uncertainty receives different treatment.",
      "cases": ["LS-045", "LS-120", "LS-174", "LS-182"],
      "correction": "Use the same independent-evidence standard wherever coverage determines action. Source-wide maxima, old nonaligned artifacts, empty rows and candidate prose are insufficient."
    },
    {
      "issue": "Draft coverage assertions contradict one another.",
      "cases": ["LS-043", "LS-044", "LS-049", "LS-050", "LS-053", "LS-061", "LS-104"],
      "correction": "Establish agency-specific periods independently. SHR partial-2026 claims, SHR max-2025 claims and the assertion that NIBRS has no 2026 cannot all be adopted as facts."
    },
    {
      "issue": "D11 is interpreted inconsistently.",
      "cases": ["LS-084", "LS-213"],
      "correction": "Direct rape series crossing 2013 require the definition-change note, as the gold example establishes. The user need not separately ask about the definition change."
    },
    {
      "issue": "Clearance fractions have inconsistent units, statistics and implicit numerators.",
      "correction": "Encode cleared numerator, matching reported-crime denominator, and percentage/share presentation consistently. Do not use percent-cleared as a base counting unit or conflate these fractions with per-capita rates."
    },
    {
      "issue": "Clarification and button pairs must share exactly one selected meaning.",
      "cases": ["LS-183", "LS-196", "LS-202", "LS-216", "LS-217", "LS-218"],
      "correction": "Apply every parent-option correction to its continuation. Preserve source, place, period, units, filters, ranking and denominator; only the action changes after selection."
    },
    {
      "issue": "Policy references are inconsistently complete.",
      "correction": "Track every proposed behavior actually used, especially P02/P03/P15/P16/P17/P22/P23. Listing an open row does not establish its condition or implement its behavior."
    },
    {
      "issue": "Schema limitations can erase required behavior.",
      "cases": ["LS-022", "LS-066", "LS-190"],
      "correction": "Do not force data-definition answers into decline, postpone scored gold obligations to future turns, or discard a mandatory second alternative merely to fit the current schema."
    },
    {
      "issue": "Acceptance is not numeric verification or policy approval.",
      "correction": "Accepted pending_build labels still lack verified values; open P rows remain undecided and unscored. This review does not authorize changing those statuses."
    }
  ]
}
```

Reviewed all 218 IDs exactly once: 42 accept, 100 change, 76 unresolved.  
Verified commit 9e145a8; edited nothing and read no candidate responses or outcomes.  
Acceptance covers label meaning, not pending numeric values or approval of open policy rows.  
Uncorrected issues could score the wrong measure, promise unavailable answers, or omit binding gold requirements.  
**Necessity check:** Correct those labeling failures and retain unresolved cases unscored; defer product changes, broader certification and optional polish.
