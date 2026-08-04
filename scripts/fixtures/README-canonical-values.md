# Canonical source values fixture

`shr-canonical-values.json` holds the distinct label values that detector D6
compares narrative text against, captured from production `/opt/nibrs/shr.db`.

It exists because the local `shr.db` is a 0-byte stub, so `loadCanonicalValues()`
returns an empty list and D6 silently cannot fire — it reported a MISS on
production row 7780 while its logic was correct. Calibration now fails loudly
when no canonical values are available rather than reporting an inert detector
as merely failing.

Regenerate when the source schema or its label vocabulary changes:

```bash
ssh root@178.156.243.51 'sqlite3 -json /opt/nibrs/shr.db "
SELECT DISTINCT race AS value FROM victims WHERE race IS NOT NULL
UNION SELECT DISTINCT ethnicity FROM victims WHERE ethnicity IS NOT NULL
UNION SELECT DISTINCT off_race FROM incidents WHERE off_race IS NOT NULL
UNION SELECT DISTINCT relationship FROM incidents WHERE relationship IS NOT NULL
UNION SELECT DISTINCT circumstance FROM incidents WHERE circumstance IS NOT NULL
ORDER BY value;"'
```

Preference order at calibration time: `--canonical-values <file>`, then a real
source database, then this fixture.
