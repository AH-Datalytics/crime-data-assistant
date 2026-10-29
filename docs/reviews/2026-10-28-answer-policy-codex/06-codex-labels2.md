```json
{
  "accept": [
    "LS-001","LS-006","LS-010","LS-021","LS-022","LS-023","LS-025","LS-028","LS-030","LS-031","LS-033","LS-035","LS-036","LS-038","LS-040","LS-041","LS-042","LS-043","LS-048","LS-051","LS-056","LS-059","LS-071","LS-073","LS-076","LS-078","LS-079","LS-082","LS-084","LS-086","LS-087","LS-092","LS-094","LS-097","LS-098","LS-119","LS-124","LS-129","LS-131","LS-135","LS-138","LS-141","LS-142","LS-146","LS-149","LS-151","LS-156","LS-157","LS-158","LS-159","LS-161","LS-163","LS-164","LS-166","LS-173","LS-174","LS-176","LS-177","LS-178","LS-179","LS-180","LS-181","LS-183","LS-184","LS-185","LS-187","LS-188","LS-190","LS-192","LS-194","LS-195","LS-196","LS-197","LS-198","LS-201","LS-204","LS-206","LS-207","LS-209","LS-212","LS-213","LS-214","LS-216","LS-217"
  ],
  "change": {
    "LS-002": {
      "issue": "Place-entry buttons promise an answer without a selected place.",
      "fix": "For 'A state', set leads_to='clarify', meaning=null, next_about='which state'. For 'A city or agency', set leads_to='clarify', meaning=null, next_about='which city or agency'. Preserve the United States option. Add D28 and P22 to policy."
    },
    "LS-003": {
      "issue": "The States option divides cleared offenses by reported offenses: it is a state clearance rate under P18, despite the exceptional-clearance subtype.",
      "fix": "Replace only the States option with {\"label\":\"States\",\"leads_to\":\"decline\",\"meaning\":null}. Preserve the city and agency options. Replace the coordinator's P18 exemption in label.notes with '[superseded by P18] State cleared-over-reported percentages decline with no substitute; agency and city percentages remain answerable.'"
    },
    "LS-004": {
      "issue": "Cleared-over-reported state percentages fall under P18; the coordinator's subtype exemption is not an owner decision.",
      "fix": "Replace expected with {\"action\":\"decline\",\"reason\":\"There is no state clearance rate in the data: the FBI publishes clearance for agencies and the nation, not states, and a percentage built from reporting agencies is not a state rate.\",\"alternative\":null}. Retain P18. Replace the coordinator exemption in label.notes with '[superseded by P18] Exceptional-clearance numerators over reported rapes remain state clearance rates.'"
    },
    "LS-034": {
      "issue": "The chained clarification omits its policy dependencies.",
      "fix": "Add D28 and P22 to policy. Preserve expected."
    },
    "LS-039": {
      "issue": "Another year cannot answer before a year is supplied.",
      "fix": "Replace the Another year option with {\"label\":\"Another year\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which year\"}. Add D28 and P22 to policy. Preserve the other options."
    },
    "LS-046": {
      "issue": "Violent crime uses offense units rather than the FBI composite.",
      "fix": "Set expected.meaning.measures[0].unit='FBI composite: victims of murder, rape and aggravated assault plus robbery offenses'. Add D18 to policy. Preserve all other fields."
    },
    "LS-047": {
      "issue": "Violent crime uses offense units rather than the FBI composite.",
      "fix": "Set expected.meaning.measures[0].unit='FBI composite: victims of murder, rape and aggravated assault plus robbery offenses'. Add D18 to policy. Preserve all other fields."
    },
    "LS-054": {
      "issue": "Completeness eligibility appears only in prose; counting and agency dependencies are missing.",
      "fix": "Append 'agencies that reported every available month of 2026' to expected.meaning.filters. Add D18 and P16 to policy. Preserve population-first selection, subsequent murder-rate sorting, sample scope and existing statements."
    },
    "LS-055": {
      "issue": "The US option uses offense units and does not encode the matching-month restriction on changes.",
      "fix": "Set the United States option's violent-crime unit to 'FBI composite: victims of murder, rape and aggravated assault plus robbery offenses'. Append filter 'Show full-year counts separately from partial 2026; compute or assert changes only for explicitly identified matching months, using the same Current Trends sample agencies'. Add D18, D28 and P22 to policy."
    },
    "LS-057": {
      "issue": "The murder-victim counting dependency is missing.",
      "fix": "Add D18 to policy. Preserve expected."
    },
    "LS-058": {
      "issue": "Violent crime uses offense units rather than the FBI composite.",
      "fix": "Set expected.meaning.measures[0].unit='FBI composite: victims of murder, rape and aggravated assault plus robbery offenses'. Add D18 to policy. Preserve all other fields."
    },
    "LS-060": {
      "issue": "Population rank versus homicide-rate rank remains materially ambiguous; P04 does not settle it.",
      "fix": "Replace expected with action='clarify', about='whether top 100 means most populous or highest homicide rate', and two options labeled '100 most populous cities' and '100 highest homicide rates'. Both options have leads_to='answer' and copy the current expected.meaning, appending filter 'agencies that reported every available month of 2026'. The first retains rank={\"by\":\"population\",\"direction\":\"top\",\"limit\":100}; the second uses rank={\"by\":\"murder rate per 100,000\",\"direction\":\"top\",\"limit\":100}. Add D18, D28, P16 and P22 to policy. Retain the existing partial-year, completeness, source and tie requirements in label.notes; specify that the population option selects by population before sorting by murder rate."
    },
    "LS-062": {
      "issue": "P15's required denominator wording is absent.",
      "fix": "Insert 'per 100,000 residents of the reporting agencies' before the final source statement in expected.statements. Add D18 and P16 to policy. Preserve the population threshold, completeness filter and top ten."
    },
    "LS-063": {
      "issue": "P15's required wording is absent, and the carjacking definition should match LS-140.",
      "fix": "Insert 'per 100,000 residents of the reporting agencies' before the final source statement. Set expected.meaning.measures[0].name='carjacking (robbery in which a motor vehicle was taken)'. Add P16 to policy. Preserve offense units and all ranking conditions."
    },
    "LS-064": {
      "issue": "The options omit counting, partial-year, agency and button dependencies.",
      "fix": "Add D06, D18, P16 and P22 to policy. Preserve expected."
    },
    "LS-065": {
      "issue": "The gold-required number of excluded incomplete reporters remains absent.",
      "fix": "Insert 'Requires all 12 reporting months in both 2024 and 2025; states the number of agencies excluded for incomplete reporting (0 or 1 here), and makes no ranked change claim if Chicago is excluded' before the final source statement. Preserve both count and percentage changes."
    },
    "LS-066": {
      "issue": "The crime buttons silently choose percentage decrease, unlike LS-212's treatment of the same material ambiguity.",
      "fix": "For every existing crime option, set leads_to='clarify', meaning=null and next_about='whether greatest decrease means decrease in count or percentage'. Preserve the selected crime, states, both twelve-month windows, same sample agencies and completeness exclusions in label.notes. Specify there that the eventual Violent crime meaning uses 'FBI composite: victims of murder, rape and aggravated assault plus robbery offenses'. Add D18 to policy."
    },
    "LS-068": {
      "issue": "The counting and clarification dependencies are missing.",
      "fix": "Add D18, D28 and P22 to policy. Preserve expected."
    },
    "LS-069": {
      "issue": "The place clarification omits P12's city/agency choice.",
      "fix": "Append {\"label\":\"A city or agency\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which city or agency\"} to expected.options. Add D28 and P22 to policy. Preserve the distinction between fixed-cohort incident counts and all-agency participation."
    },
    "LS-075": {
      "issue": "Both components use offense units, undercounting person crimes under D18.",
      "fix": "In the United States option, set the violent-crime unit to 'FBI composite: victims of murder, rape and aggravated assault plus robbery offenses'. Replace the other measure with {\"name\":\"all other Group A crimes excluding the violent-crime components\",\"unit\":\"victims for crimes against persons; offenses for property and society crimes\"}. Append filter 'Deduplicate within each offense type using its standard counting unit; violent and nonviolent offense sets are disjoint'. Add D28 and P22 to policy."
    },
    "LS-081": {
      "issue": "Null answer meanings conceal the required period clarification; the schema supports it.",
      "fix": "Set every option's leads_to='clarify', meaning=null and next_about='which period'. Preserve labels, about and retained question context. Remove the claim that the schema cannot express the next question from label.notes."
    },
    "LS-085": {
      "issue": "Place-entry buttons promise an answer without a selected place.",
      "fix": "For 'A state', set leads_to='clarify', meaning=null, next_about='which state'. For 'A city or agency', set leads_to='clarify', meaning=null, next_about='which city or agency'. Preserve the United States option."
    },
    "LS-091": {
      "issue": "The FBI-composite and advanced-source dependencies are omitted.",
      "fix": "Add D18 and P02 to policy. Preserve the definitional answer."
    },
    "LS-096": {
      "issue": "P05's custom-year choice is omitted.",
      "fix": "Append {\"label\":\"Another year\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which year\"} to expected.options. Preserve both existing choices."
    },
    "LS-099": {
      "issue": "P06's custom-year choice is omitted.",
      "fix": "Append {\"label\":\"Another year\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which year\"} to expected.options. Preserve both existing choices."
    },
    "LS-107": {
      "issue": "P06's custom-range choice is omitted.",
      "fix": "Append {\"label\":\"Another range\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which range of years\"} to expected.options. Preserve January-July in both existing meanings. Remove the note that another range is not encoded."
    },
    "LS-109": {
      "issue": "The victim-unit dependency is omitted.",
      "fix": "Add D18 to policy. Preserve expected."
    },
    "LS-110": {
      "issue": "Both buttons need a period clarification, not an answer with null meaning.",
      "fix": "Set every option's leads_to='clarify', meaning=null and next_about='which period'. Preserve both labels and Dallas context. Remove the claim that the schema cannot express the next question from label.notes."
    },
    "LS-111": {
      "issue": "The requested consistent-reporter behavior is implemented but its policy row is omitted.",
      "fix": "Add P03 to policy. Preserve the same_agencies cohort, crime counting, age attribution and gold failure statements."
    },
    "LS-113": {
      "issue": "P06's custom-range choice is omitted.",
      "fix": "Append {\"label\":\"Another range\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which range of years\"} to expected.options. Preserve both existing choices."
    },
    "LS-116": {
      "issue": "The crime buttons require a subsequent trend-period clarification.",
      "fix": "Set every option's leads_to='clarify', meaning=null and next_about='which range of years'. Preserve labels and the San Francisco peer-comparison context. Remove the claim that the schema cannot express the next question from label.notes."
    },
    "LS-126": {
      "issue": "The custom-range button promises an answer without a range.",
      "fix": "Replace Another range with {\"label\":\"Another range\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which range of years\"}. Add D28 and P22 to policy. Preserve the other options."
    },
    "LS-128": {
      "issue": "Cleared-over-reported state percentages fall under P18; the coordinator's subtype exemption is not an owner decision.",
      "fix": "Replace expected with {\"action\":\"decline\",\"reason\":\"There is no state clearance rate in the data: the FBI publishes clearance for agencies and the nation, not states, and a percentage built from reporting agencies is not a state rate.\",\"alternative\":null}. Retain P18. Replace the coordinator exemption in label.notes with '[superseded by P18] Exceptional-clearance numerators over reported rapes remain state clearance rates.'"
    },
    "LS-133": {
      "issue": "The alternative counts robbery victims, contrary to final P11's property-offense rule.",
      "fix": "Set expected.alternative.measures=[{\"name\":\"violent crime\",\"unit\":\"FBI composite: victims of murder, rape and aggravated assault plus robbery offenses\"}]. Set its groupings=['victim race (count each person-crime victim in its race; count each robbery offense once per linked victim-race category; unknown is a separate category; cross-race overlap disclosed)']. Set its denominator='all FBI-composite violent crimes at the same reporting agencies in the same year, before race restriction'. Append to expected.reason: 'Property crimes are counted by offense, not by victim; these are shares of crimes linked to each victim-race category and overlapping categories need not sum to 100%.' Add '[superseded by P11]' to label.notes."
    },
    "LS-137": {
      "issue": "The first rolling point requires 2017 months, but that prerequisite is not preserved.",
      "fix": "Append filter 'Each displayed month requires all twelve source months; January 2018 uses February 2017 through January 2018; never sum an incomplete window'. Insert 'Show any rolling window lacking required months as missing, not zero or a shorter-window total' before the final source statement."
    },
    "LS-140": {
      "issue": "The custom-range button promises an answer without a range.",
      "fix": "Replace Another range with {\"label\":\"Another range\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which range of years\"}. Add D28 and P22 to policy. Preserve the other options."
    },
    "LS-143": {
      "issue": "This murder-clearance count uses offense units while equivalent LS-073 uses D18's victim base.",
      "fix": "Set expected.meaning.measures[0].unit='victim'. Insert 'Counts murder victims whose offense was cleared by exceptional means, grouped by exceptional-clearance type' before the source statement. Preserve the count statistic, Virginia, 2025 and reporting-agency coverage."
    },
    "LS-148": {
      "issue": "Cleared-over-reported state percentages fall under P18; the coordinator's subtype exemption is not an owner decision.",
      "fix": "Replace expected with {\"action\":\"decline\",\"reason\":\"There is no state clearance rate in the data: the FBI publishes clearance for agencies and the nation, not states, and a percentage built from reporting agencies is not a state rate.\",\"alternative\":null}. Retain P18. Replace the coordinator exemption in label.notes with '[superseded by P18] Exceptional-clearance numerators over reported rapes remain state clearance rates.'"
    },
    "LS-150": {
      "issue": "The custom-range button promises an answer without a range.",
      "fix": "Replace Another range with {\"label\":\"Another range\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which range of years\"}. Add D28 and P22 to policy. Preserve the other options."
    },
    "LS-152": {
      "issue": "The count options use raw violent-crime offenses instead of D18's composite; clearance-percentage encoding does not change count units.",
      "fix": "In the Violent crime and Both options, set the violent-crime unit to 'FBI composite: victims of murder, rape and aggravated assault plus robbery offenses'. Preserve cleared filters, property offense units, all 36 separate agencies and clearance-type grouping. Add P22 to policy. Revise label.notes to distinguish clearance counts from offense-based clearance percentages."
    },
    "LS-153": {
      "issue": "Place-entry buttons promise an answer without a selected place.",
      "fix": "For 'A state', set leads_to='clarify', meaning=null, next_about='which state'. For 'A city or agency', set leads_to='clarify', meaning=null, next_about='which city or agency'. Preserve the United States option. Add D28 and P22 to policy."
    },
    "LS-154": {
      "issue": "The custom-range button promises an answer without a range.",
      "fix": "Replace Another range with {\"label\":\"Another range\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which range of years\"}. Add D28 and P22 to policy. Preserve the other options."
    },
    "LS-155": {
      "issue": "Place-entry buttons promise an answer without a selected place.",
      "fix": "For 'A state', set leads_to='clarify', meaning=null, next_about='which state'. For 'A city or agency', set leads_to='clarify', meaning=null, next_about='which city or agency'. Preserve the United States option. Add D28 and P22 to policy."
    },
    "LS-160": {
      "issue": "The offense-unit dependency is omitted.",
      "fix": "Add D18 to policy. Preserve the robbery-by-weapon meaning."
    },
    "LS-165": {
      "issue": "The single-source span dependency is omitted.",
      "fix": "Add P14 to policy. Preserve the Historical Texas estimates and 2018-2024 comparison."
    },
    "LS-167": {
      "issue": "The city-to-principal-agency dependency is omitted.",
      "fix": "Add P16 to policy. Preserve expected."
    },
    "LS-168": {
      "issue": "The city-to-principal-agency dependency is omitted.",
      "fix": "Add P16 to policy. Preserve expected."
    },
    "LS-169": {
      "issue": "Another year cannot answer before a year is supplied.",
      "fix": "Replace Another year with {\"label\":\"Another year\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which year\"}. Add D28 to policy. Preserve the other options."
    },
    "LS-170": {
      "issue": "Another year cannot answer before a year is supplied.",
      "fix": "Replace Another year with {\"label\":\"Another year\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which year\"}. Add D28 to policy. Preserve the other options."
    },
    "LS-171": {
      "issue": "The custom-range button promises an answer without a range.",
      "fix": "Replace Another range with {\"label\":\"Another range\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which range of years\"}. Add D28 to policy. Preserve the other options."
    },
    "LS-172": {
      "issue": "Another year cannot answer before a year is supplied.",
      "fix": "Replace Another year with {\"label\":\"Another year\",\"leads_to\":\"clarify\",\"meaning\":null,\"next_about\":\"which year\"}. Add D28 to policy. Preserve the other options."
    },
    "LS-175": {
      "issue": "The city-to-principal-agency dependency is omitted.",
      "fix": "Add P16 to policy. Preserve expected."
    },
    "LS-182": {
      "issue": "Place-entry buttons promise an answer without a selected place.",
      "fix": "For 'A state', set leads_to='clarify', meaning=null, next_about='which state'. For 'A city or agency', set leads_to='clarify', meaning=null, next_about='which city or agency'. Preserve the United States option. Add D28 to policy."
    },
    "LS-186": {
      "issue": "The offense-unit dependency is omitted.",
      "fix": "Add D18 to policy. Preserve expected."
    },
    "LS-189": {
      "issue": "The city-to-principal-agency dependency is omitted.",
      "fix": "Add P16 to policy. Preserve expected."
    },
    "LS-202": {
      "issue": "The nonfatal option does not disclose that firearm assault includes people not hit.",
      "fix": "Rename the second option to 'Aggravated assaults with a firearm (includes people not hit)'. Preserve its meaning and the Fatal shootings label used by LS-217."
    },
    "LS-203": {
      "issue": "The meaning does not explicitly include peer rows or population-only selection.",
      "fix": "Set expected.meaning.groupings=['agency (Austin Police Department and each peer as a separate row)']. Set expected.meaning.filters=['peer cities selected on population alone within the stated population band; retain Austin Police Department alongside them']. Preserve the rate, denominator, year and statements."
    },
    "LS-205": {
      "issue": "SHR's documented categories cannot identify all D20 relationships, including non-intimate cohabitants; NIBRS records the required detail.",
      "fix": "Set expected.meaning.source='nibrs', cohort='all_reporting', and filters=['linked victim-offender relationship in {SE, CS, BG, XS, XR, HR, CH, PA, SB, SC, SP, SS, GP, GC, IL, OF, CF, BE, FP, FC, CO}; count each qualifying murder victim once']. Add P03 to policy. Insert 'States what share of Texas population the reporting agencies cover' before the final source statement. Replace the source rationale in label.notes with 'D20 requires relationships recorded distinctly in NIBRS; P01 therefore routes this detail to NIBRS. Preserve the full D20 definition.'"
    },
    "LS-211": {
      "issue": "The offense-unit dependency is omitted.",
      "fix": "Add D18 to policy. Preserve expected."
    },
    "LS-215": {
      "issue": "The offense-unit dependency is omitted.",
      "fix": "Add D18 to policy. Preserve expected."
    }
  },
  "unresolved": {
    "LS-032": "D31 establishes the year clarification, not the known-age-only denominator or any-under-18 attribution. Identical LS-121 explicitly calls the denominator the drafter's choice. Resolve both consistently. Another year must also lead to clarify with next_about='which year'.",
    "LS-044": "P01 removes the SHR routing assumption but does not establish Boston's Current Trends monthly coverage for 2022-2026. The redraft explicitly assumes membership/coverage. Independent period evidence remains necessary to establish this answer branch.",
    "LS-052": "The first review conditioned the source switch on independently established Seattle period availability. P01 chooses Current Trends for current-year data but does not establish Seattle's 2026 coverage; the redraft still calls it an assumption.",
    "LS-061": "The draft expressly assumes SHR holds the requested 2025 ranking without independent coverage evidence. D32 concerns Historical, not SHR. P04 settles eligibility policy but cannot establish SHR's 2025 data or full-year reporting classification.",
    "LS-083": "The current-year option promises NIBRS answers for both agencies despite explicitly unverified 2026 coverage. Establish that branch. Also add P06's Another year option leading to clarify, retaining the corrected crime-by-age meaning.",
    "LS-106": "The Memphis current-year NIBRS answer and assertion that no other source holds current-year firearm detail remain unverified. P01 alone cannot establish this branch. Include P06's Another year option after resolving it.",
    "LS-114": "The current-year SFPD-plus-three-peers NIBRS clearance option is not established as runnable; the draft acknowledges the coverage doubt. Resolve source/period coverage and include Another year leading to clarify.",
    "LS-115": "Inherits LS-114's unverified current-year clearance branch, now requiring SFPD plus eight peers. D31 correctly retains the missing-period question but does not establish nine runnable agency answers. Include Another year after resolving the branch.",
    "LS-118": "The current-year NIBRS clearance comparison is explicitly unverified for Albuquerque, the national reporting-agency figure and peers. Establish the branch, retain reporting-agency scope and matching denominators, and add Another year leading to clarify.",
    "LS-121": "Same unresolved denominator and attribution as LS-032. D31 resolves the missing year, not exclusion of crimes with entirely unknown offender ages. Keep both labels identical; Another year must lead to another clarification.",
    "LS-125": "The Denver current-year NIBRS clearance option lacks established agency/peer coverage, like LS-114. Resolve consistently. Independently, Another year must lead to clarify with next_about='which year', not answer with null meaning.",
    "LS-191": "P19 establishes the synthetic-narcotics category, not the seizure counting unit. The raw schema permits multiple property/drug records per incident; the claimed one-record-per-incident equivalence is unsupported. Establish the incident-based seizure definition or appropriate record unit before promising the alternative."
  }
}
```

Reviewed all 156 requested IDs exactly once: 84 accept, 60 change, 12 unresolved.  
Owner decisions control; prior fixes and gold expectations were retained where not superseded.  
Remaining issues concern policy application, units, clarification transitions, dependencies and unsupported branches.  
No files edited; prohibited logged outcomes and reachability results were not read; numeric values remain unverified.  
**Necessity check:** correct the identified labels before scoring them; keep unresolved cases unscored. Broader product certification and polish are deferred.
