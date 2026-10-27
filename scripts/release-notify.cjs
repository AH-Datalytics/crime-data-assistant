#!/usr/bin/env node
/**
 * release.sh's alert: one plain-text mail through the repository's one mail client (scripts/lib/resend-mailer.js,
 * the same sender, recipient and credential file as the freshness alerts). Exits non-zero if the mail was not
 * accepted, so release.sh can say so instead of assuming someone was told.
 *   node release-notify.cjs "<subject>" "<body>"
 */
"use strict";
const mailer = require("./lib/resend-mailer.js");
const [subject, body] = process.argv.slice(2);
mailer.sendPlainMail({ subject: subject || "nibrsai.com release alert", body: body || "" })
  .then((r) => { console.log(`alert sent (${r.status ?? "ok"})`); })
  .catch((e) => { console.error(mailer.redactSecrets(`ALERT DELIVERY FAILED: ${e.message}`)); process.exit(1); });
