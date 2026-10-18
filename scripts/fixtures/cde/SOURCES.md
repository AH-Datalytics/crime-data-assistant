# CDE codebook fixtures (copied 2026-10-13)

Every file here comes from the FBI Crime Data Explorer (CDE), the codebook authority for this app (Jeff, 2026-10-13).
- `NIBRS_*.csv`, `REF_*.csv`: the reference tables inside CDE's 'NIBRS data by state' download, key `nibrs/incident/2023/DE-2023.zip`.
- `shr-codebook.json`: see its `_source`.
Hate crime location and bias codes use the NIBRS tables: CDE's own decoded hate crime dataset agrees with them on every code (audit/hate-crime-location-check-2026-10-13/crosswalk.json).

sha256:
- `e31c8a9d9890d167f79c7ffe9523f56e73768e580b917732993eda64f24c4441` NIBRS_BIAS_LIST.csv
- `0af469f549d533a9f61a6e34b91b7e90ad7d6fa07a70490567e57a7e82f12d98` NIBRS_CLEARED_EXCEPT.csv
- `50f1926ad1793e8328d76e4b60afd7a6d96559f088acbbaabcab5ef1e0099c89` NIBRS_ETHNICITY.csv
- `540b00a888875b5e9c7ce2bc50d7ca73e54338bd4f3a126f1786871bbae7a69c` NIBRS_LOCATION_TYPE.csv
- `84615cdf9b0023cd336391014addf8aa06da568314a4e67bcfde8f9903ef7360` NIBRS_OFFENSE_TYPE.csv
- `419ec651be02a82d1e3244eb84be40d5ebd05cc23be0fa8a1d2f937b2cf0a477` NIBRS_PROP_DESC_TYPE.csv
- `76cb6e2f3e0ed02dba97dcedb46db4dad6274c3f4d319f2d1fc248386640f31f` NIBRS_PROP_LOSS_TYPE.csv
- `139ed02793439092fd47b6b5a142f460b32fdd3e586a93f1137382c8e42ab501` NIBRS_RELATIONSHIP.csv
- `d7874de8da8a02a8b552eef9606ee67ae68211b55a58ffb10036fe488b7259d8` NIBRS_SUSPECTED_DRUG_TYPE.csv (added by amendment 3)
- `2e38e37d7db20a4a22c7f23f29b67d96d033c9f55a131273dcd65e54b5d34230` NIBRS_VICTIM_TYPE.csv
- `337c30b5cdfa41c2a3d1ec397e7e6820ec327772171c1f07958761322751764c` NIBRS_WEAPON_TYPE.csv
- `a2fa086ff640665101774e45736df3d1f11a18b1ddeaa456e0fd63e894003646` REF_RACE.csv
- `afa998d3f3e01d42c7c35c3e3128c897af7567eef99bd2ba839e14192f0204e5` REF_STATE.csv
- `dc92bd1f39be8ff63d6d2834bbdb95639e301cd9ee31386641a0da3549fb4e33` shr-codebook.json (LF; was 8944ea52... with CRLF in 899193b: historical national rape fix amendment 2)
