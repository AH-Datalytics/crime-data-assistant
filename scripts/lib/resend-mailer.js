/**
 * The one place this repository addresses and sends mail from -- and it depends on nothing but the
 * Node runtime.
 *
 * WHY THIS EXISTS. scripts/daily-query-analysis.js already sends through Resend, with the sender and
 * recipient written inline. Adding a freshness alert with its own copy of that would be a second mail
 * client: two places to change the recipient, two places for the sender to drift, and two places for
 * an API key to leak into a log. The constants and the send now live here.
 *
 * WHY IT USES fetch AND NOT THE resend PACKAGE. The freshness monitor is pinned outside the release
 * directory precisely so it survives an application rollback. Requiring `resend` would have pulled it
 * straight back through /opt/nibrs/current/node_modules, so a rollback to a release without that
 * package would have left the detector still detecting and the alerts silently undeliverable. On this
 * host cron output is discarded -- there is no MTA -- so "the send failed" would have reached a log
 * file and no human. A monitor that operates without reaching anyone is the exact failure it exists
 * to prevent, so the send is built on the runtime's own global fetch and the pinned stack resolves
 * nothing through the release.
 *
 * WHERE THE KEY COMES FROM. cron runs with almost no environment, so a scheduled invocation cannot
 * rely on RESEND_API_KEY being exported: it is read from a root-owned 0600 credential file, and that
 * file's ownership and mode are verified on every read rather than assumed. An unsafe file is refused
 * outright and is never quietly replaced by an environment variable, because falling back would turn
 * "the credential is world-readable" into a silent success. The value never reaches argv, a log line,
 * an error message or an email body: it is registered with the redactor the moment it is read.
 *
 * The digest is deliberately NOT refactored onto this module in the same increment -- it is a working
 * production path and changing it is separate scope. scripts/test-rtci-freshness.js asserts that the
 * digest's inline FROM/TO still match the constants below, so the two cannot drift while they coexist.
 *
 * SANDBOX LIMITATION, recorded deliberately: FROM is still the Resend sandbox sender. Until the
 * domain is verified, delivery is reliable only to the account owner's own address, which is what TO
 * is. See docs/superpowers/2026-08-27-rtci-freshness-monitoring-contract.md.
 */
"use strict";

const nodeFs = require("node:fs");

const TO_EMAIL = "jasher@ahdatalytics.com";
const FROM_EMAIL = "Crime Data Assistant <onboarding@resend.dev>";
const RESEND_ENDPOINT = "https://api.resend.com/emails";
const DEFAULT_TIMEOUT_MS = 20000;

/** The reviewed credential file. Root-owned, 0600, and read inside the pinned stack. */
const DEFAULT_ENV_FILE = "/opt/nibrs/shared/.env.cron";
/** A response body larger than this is not read any further. Resend's are a few hundred bytes. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/**
 * Resend keys are `re_` followed by an opaque token. Accepting only this shape is not cosmetic: the
 * redactor's shape rule below is what protects a key that arrives from somewhere unexpected, and it
 * only recognises `re_`. Accepting a key the redactor could not recognise would put the two out of
 * step, so a value of any other shape is refused rather than used.
 */
const KEY_SHAPE = /^re_[A-Za-z0-9_-]{8,}$/;

/** Every secret value this process has handled, so redaction covers keys that never sat in env. */
const knownSecrets = new Set();

function registerSecret(value) {
  if (typeof value === "string" && value.length >= 8) knownSecrets.add(value);
}

/** Anything that could carry the key is scrubbed before it can reach a log or an email body. */
function redactSecrets(text) {
  if (typeof text !== "string") return text;
  let out = text;
  const key = process.env.RESEND_API_KEY;
  if (key && key.length >= 8) out = out.split(key).join("[redacted RESEND_API_KEY]");
  for (const secret of knownSecrets) out = out.split(secret).join("[redacted RESEND_API_KEY]");
  // Redact the shape as well as the known values, so a key arriving from somewhere else -- a quoted
  // error, a copied command -- is caught too.
  out = out.replace(/\bre_[A-Za-z0-9_-]{8,}/g, "[redacted resend key]");
  // And never echo an Authorization header back, whatever it contains.
  return out.replace(/(Bearer\s+)\S+/gi, "$1[redacted]");
}

/**
 * Refuse a credential file that anyone but root can read.
 *
 * Each property is checked separately and named separately, so a mutation test can prove that each
 * one on its own is capable of failing. None of the messages carries the file's contents.
 */
function assertCredentialFileSafe(filePath, stat, platform) {
  if (platform === "win32") {
    throw new Error(`cannot verify the ownership and mode of ${filePath} on ${platform}; ` +
      "refusing to read a credential file where those cannot be checked");
  }
  if (typeof stat.isFile === "function" && !stat.isFile()) {
    throw new Error(`${filePath} is not a regular file; refusing to read a credential from it`);
  }
  if (stat.uid !== 0) {
    throw new Error(`${filePath} is not owned by root (uid ${stat.uid}); refusing to read it`);
  }
  if (stat.gid !== 0) {
    throw new Error(`${filePath} has group ${stat.gid}, not root; refusing to read it`);
  }
  const mode = stat.mode & 0o7777;
  if (mode !== 0o600) {
    throw new Error(`${filePath} has mode 0${mode.toString(8)}, not 0600; refusing to read it`);
  }
}

/** Pull RESEND_API_KEY out of an env-file body. First entry wins; the value never reaches an error. */
function parseCredentialFile(text, filePath) {
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?RESEND_API_KEY\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[1].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (value === "") throw new Error(`the RESEND_API_KEY entry in ${filePath} is empty`);
    if (!KEY_SHAPE.test(value)) {
      throw new Error(`the RESEND_API_KEY entry in ${filePath} does not have the expected Resend key ` +
        "shape (re_ followed by an opaque token); refusing it, because the redactor recognises no other shape");
    }
    return value;
  }
  throw new Error(`no RESEND_API_KEY entry in ${filePath}`);
}

/**
 * Where the key comes from, in order: the reviewed credential file if it exists, otherwise the
 * environment. A credential file that exists but is unsafe is a hard failure -- never a fallback.
 *
 * `fsFacade` and `platform` are injectable so ownership and mode can be driven directly in tests.
 * The canonical harness runs on windows-latest, where every real file reports uid 0 and mode 0666,
 * so asserting these against real files would assert nothing at all.
 */
function resolveApiKey({
  envFilePath = process.env.RTCI_FRESHNESS_ENV_FILE || DEFAULT_ENV_FILE,
  fsFacade = nodeFs,
  platform = process.platform,
} = {}) {
  let stat = null;
  if (envFilePath) {
    try {
      stat = fsFacade.statSync(envFilePath);
    } catch (err) {
      // ONLY genuine absence falls through. statSync fails for more reasons than "there is no file
      // here", and treating a permission error as absence would let a credential file that exists
      // but cannot be read be replaced by whatever happens to be in the environment -- a silent
      // downgrade at exactly the moment something is already wrong.
      const code = err && err.code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      stat = null;
    }
  }
  if (stat) {
    assertCredentialFileSafe(envFilePath, stat, platform);
    const key = parseCredentialFile(fsFacade.readFileSync(envFilePath).toString("utf8"), envFilePath);
    registerSecret(key);
    return { key, source: envFilePath };
  }
  const fromEnv = process.env.RESEND_API_KEY;
  if (fromEnv) {
    registerSecret(fromEnv);
    return { key: fromEnv, source: "environment" };
  }
  throw new Error("RESEND_API_KEY is not set; refusing to send");
}

/** A promise that rejects the moment the signal aborts, and never otherwise. */
function abortRejection(signal) {
  const p = new Promise((_, reject) => {
    if (!signal) return;
    const fail = () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    };
    if (signal.aborted) return fail();
    signal.addEventListener("abort", fail, { once: true });
  });
  p.catch(() => {});   // so an abort nobody raced against is not an unhandled rejection
  return p;
}

/**
 * Read a response body under both bounds that matter: the caller's timeout, which must stay armed
 * through body consumption, and a byte cap.
 *
 * A server can send headers immediately and then never finish the body. Clearing the timeout once
 * the headers arrive -- which is what an earlier version of this file did -- leaves a scheduled run
 * hanging forever on exactly that. So the read is raced against the abort signal, and a stream is
 * abandoned as soon as it exceeds the cap rather than buffered whole.
 */
async function readBodyBounded(response, signal, maxBytes) {
  if (!response) return { text: "", truncated: false };
  const aborted = abortRejection(signal);
  const body = response.body;

  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    let truncated = false;
    try {
      for (;;) {
        const { value, done } = await Promise.race([reader.read(), aborted]);
        if (done) break;
        if (!value || value.length === 0) continue;
        const remaining = maxBytes - total;
        if (remaining <= 0 || value.length > remaining) {
          chunks.push(Buffer.from(value).subarray(0, Math.max(0, remaining)));
          truncated = true;
          break;
        }
        chunks.push(Buffer.from(value));
        total += value.length;
      }
    } finally {
      // Deliberately not awaited: cancelling a stream whose pull is still pending must not be able
      // to hold the timeout path open, which is the very thing this function exists to bound.
      try {
        const cancelled = reader.cancel();
        if (cancelled && typeof cancelled.catch === "function") cancelled.catch(() => {});
      } catch { /* the stream is already finished or gone */ }
    }
    return { text: Buffer.concat(chunks).toString("utf8"), truncated };
  }

  if (typeof response.text !== "function") return { text: "", truncated: false };
  let text;
  try {
    text = await Promise.race([response.text(), aborted]);
  } catch (err) {
    if (err && (err.name === "AbortError" || err.name === "TimeoutError")) throw err;
    return { text: "(response body unreadable)", truncated: false };
  }
  const full = String(text);
  return full.length > maxBytes
    ? { text: full.slice(0, maxBytes), truncated: true }
    : { text: full, truncated: false };
}

/**
 * Send one plain-text message. Returns {sent:true,id,status,truncated} or throws.
 *
 * `dryRun` renders and returns without contacting Resend, so tests and rehearsals exercise the whole
 * path -- subject, body, redaction -- without spending quota or mailing anyone. `fetchImpl` is
 * injectable so the failure modes below are testable offline.
 */
async function sendPlainMail({
  subject,
  body,
  dryRun = false,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  fetchImpl = null,
  envFilePath = undefined,
} = {}) {
  if (!subject || typeof subject !== "string") throw new Error("subject is required");
  if (typeof body !== "string") throw new Error("body is required");
  const safeSubject = redactSecrets(subject);
  const safeBody = redactSecrets(body);
  if (dryRun) {
    return { sent: false, dryRun: true, from: FROM_EMAIL, to: TO_EMAIL, subject: safeSubject, body: safeBody };
  }

  const { key: apiKey } = resolveApiKey(envFilePath === undefined ? {} : { envFilePath });

  const doFetch = fetchImpl || globalThis.fetch;
  if (typeof doFetch !== "function") {
    throw new Error("no fetch available in this runtime; Node 18 or newer is required");
  }

  // Bounded, and bounded through the body: a hung API call must not hold a scheduled run open.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let status = 0;
  let text = "";
  let truncated = false;
  try {
    const response = await Promise.race([
      doFetch(RESEND_ENDPOINT, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: FROM_EMAIL, to: [TO_EMAIL], subject: safeSubject, text: safeBody }),
        signal: controller.signal,
      }),
      abortRejection(controller.signal),
    ]);
    status = response && typeof response.status === "number" ? response.status : 0;
    ({ text, truncated } = await readBodyBounded(response, controller.signal, maxResponseBytes));
  } catch (err) {
    const timedOut = controller.signal.aborted ||
      (err && (err.name === "AbortError" || err.name === "TimeoutError"));
    throw new Error(redactSecrets(timedOut
      ? `the send timed out after ${timeoutMs}ms`
      : `the send failed: ${err && err.message ? err.message : String(err)}`));
  } finally {
    clearTimeout(timer);
  }

  // A 2xx is the only success. Resend answers 4xx/5xx with a JSON body that must not be trusted to
  // be small or free of the key, so it is capped, truncated and redacted before it goes anywhere.
  if (status < 200 || status >= 300) {
    throw new Error(redactSecrets(`Resend returned HTTP ${status}: ${String(text).slice(0, 500)}` +
      (truncated ? " (body truncated at the response cap)" : "")));
  }

  let id = null;
  try {
    const parsed = JSON.parse(text);
    id = parsed && parsed.id ? parsed.id : (parsed && parsed.data && parsed.data.id) || null;
  } catch {
    id = null;   // a 2xx with an unparseable or truncated body is still a send
  }
  return { sent: true, id, status, truncated };
}

module.exports = {
  TO_EMAIL,
  FROM_EMAIL,
  RESEND_ENDPOINT,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_ENV_FILE,
  MAX_RESPONSE_BYTES,
  redactSecrets,
  registerSecret,
  resolveApiKey,
  sendPlainMail,
};
