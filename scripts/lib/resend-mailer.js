/**
 * The one place this repository addresses and sends mail from.
 *
 * WHY THIS EXISTS. scripts/daily-query-analysis.js already sends through Resend, with the sender and
 * recipient written inline. Adding a freshness alert with its own copy of that would be a second mail
 * client: two places to change the recipient, two places for the sender to drift, and two places for
 * an API key to leak into a log. The constants and the send now live here.
 *
 * The digest is deliberately NOT refactored onto this module in the same increment -- it is a working
 * production path and changing it is separate scope. Instead scripts/test-rtci-freshness.js asserts
 * that the digest's inline FROM/TO still match the constants below, so the two cannot drift apart
 * while they coexist.
 *
 * SANDBOX LIMITATION, recorded deliberately: FROM is still the Resend sandbox sender. Until the
 * domain is verified, delivery is reliable only to the account owner's own address, which is what TO
 * is. See docs/superpowers/2026-08-27-rtci-freshness-monitoring-contract.md.
 */
"use strict";

const TO_EMAIL = "jasher@ahdatalytics.com";
const FROM_EMAIL = "Crime Data Assistant <onboarding@resend.dev>";

/** Anything that could carry the key is scrubbed before it can reach a log or an email body. */
function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let out = text;
  const key = process.env.RESEND_API_KEY;
  if (key && key.length >= 8) out = out.split(key).join("[redacted RESEND_API_KEY]");
  // Resend keys are `re_` followed by an opaque token. Redact the shape as well as the known value,
  // so a key arriving from somewhere else -- a quoted error, a copied command -- is caught too.
  return out.replace(/\bre_[A-Za-z0-9_-]{8,}/g, "[redacted resend key]");
}

/**
 * Send one plain-text message. Returns {sent:true,id} or throws.
 *
 * `dryRun` renders and returns without contacting Resend, so tests and rehearsals exercise the whole
 * path -- subject, body, redaction -- without spending quota or mailing anyone.
 */
async function sendPlainMail({ subject, body, dryRun = false, client = null }) {
  if (!subject || typeof subject !== "string") throw new Error("subject is required");
  if (typeof body !== "string") throw new Error("body is required");
  const safeSubject = redactSecrets(subject);
  const safeBody = redactSecrets(body);
  if (dryRun) return { sent: false, dryRun: true, from: FROM_EMAIL, to: TO_EMAIL, subject: safeSubject, body: safeBody };

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error("RESEND_API_KEY is not set; refusing to send");
  let resend = client;
  if (!resend) {
    const { Resend } = require("resend");
    resend = new Resend(apiKey);
  }
  const result = await resend.emails.send({
    from: FROM_EMAIL,
    to: TO_EMAIL,
    subject: safeSubject,
    text: safeBody,
  });
  if (result && result.error) throw new Error(redactSecrets(`Resend rejected the message: ${JSON.stringify(result.error)}`));
  return { sent: true, id: result && result.data ? result.data.id : null };
}

module.exports = { TO_EMAIL, FROM_EMAIL, redactSecrets, sendPlainMail };
