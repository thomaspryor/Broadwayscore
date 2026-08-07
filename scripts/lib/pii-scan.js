#!/usr/bin/env node

/**
 * Task #1074. Structural scan for submitter PII (name/email) leaking into
 * JSON files committed to the PUBLIC thomaspryor/Broadwayscore repo.
 *
 * The rule "never store submitter name/email; cap free text" existed only as
 * a prose comment in scripts/lib/feedback-request-ledger.js:54-60 until a
 * session violated it in a fresh code path: notify-feedback-outcomes.js's
 * buildAlert() put submitter name + email + an uncapped message into a
 * routeAlert() description, and that description gets queued into
 * data/audit/alert-digest-queue.json — a file 12 workflows commit to this
 * repo. Caught by an adversarial reviewer pre-merge, not by any lint.
 *
 * Two independent checks, because the #1064 bug shape (an email address
 * baked into a free-text "description" field, not a field literally named
 * "email") would NOT be caught by a key-name check alone:
 *   1. EMAIL_RE — any string value anywhere in the tree that looks like an
 *      email address.
 *   2. PII key names — a key literally named like a submitter field
 *      (submitterEmail, requesterName, submitter_email, ...), or a bare
 *      name/email key nested one level under a submitter/requester/
 *      reporter/contributor object.
 * Deliberately does NOT flag bare "name"/"email"/"from" keys everywhere —
 * those are legitimate all over data/audit/*.json (critic names, outlet
 * names, slug-migration "from" fields in slug-misroute-audit.json) and
 * flagging every one would make this an unmaintainable-noise gate instead
 * of a real one.
 */

'use strict';

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PII_COMPOUND_KEY_RE = /^(submitter|requester|reporter|contributor|user)[_-]?(name|email)$/i;
const PII_PARENT_KEY_RE = /^(submitter|requester|reporter|contributor)s?$/i;
const NESTED_PII_KEYS = new Set(['name', 'email']);

/** j***@nystagereview.com — never echo a full address into (public) CI logs. */
function maskEmail(value) {
  const m = EMAIL_RE.exec(value);
  if (!m) return value;
  const [local, domain] = m[0].split('@');
  const maskedLocal =
    local.length <= 2 ? `${local[0]}*` : `${local[0]}${'*'.repeat(local.length - 2)}${local[local.length - 1]}`;
  return `${maskedLocal}@${domain}`;
}

function formatPath(pathSegs) {
  return pathSegs.reduce(
    (acc, seg) => (typeof seg === 'number' ? `${acc}[${seg}]` : acc ? `${acc}.${seg}` : String(seg)),
    ''
  );
}

function walk(value, pathSegs, onFinding) {
  if (value == null) return;
  if (typeof value === 'string') {
    if (EMAIL_RE.test(value)) {
      onFinding({ type: 'email-shaped-string', path: pathSegs, snippet: maskEmail(value) });
    }
    const leafKey = pathSegs[pathSegs.length - 1];
    const grandparentKey = pathSegs[pathSegs.length - 2];
    if (typeof leafKey === 'string' && value.trim()) {
      if (PII_COMPOUND_KEY_RE.test(leafKey)) {
        onFinding({ type: 'pii-key', path: pathSegs, key: leafKey });
      } else if (
        NESTED_PII_KEYS.has(leafKey.toLowerCase()) &&
        typeof grandparentKey === 'string' &&
        PII_PARENT_KEY_RE.test(grandparentKey)
      ) {
        onFinding({ type: 'pii-key', path: pathSegs, key: leafKey });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => walk(item, [...pathSegs, i], onFinding));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, v] of Object.entries(value)) {
      walk(v, [...pathSegs, key], onFinding);
    }
  }
}

/** Scan an already-parsed JSON value; returns an array of findings (empty = clean). */
function scanJsonValue(root) {
  const findings = [];
  walk(root, [], (f) => findings.push(f));
  return findings;
}

/**
 * Scan JSON Lines text (one JSON value per line). Findings carry a leading
 * `line` path segment (1-indexed) so formatPath() output points at the
 * offending line, e.g. "line12.title". A line that fails to parse is
 * skipped for the walk (can't scan what doesn't parse), but its 1-indexed
 * line number is recorded on the non-enumerable `badLineNumbers` property
 * so callers can surface it — silently dropping a malformed line would be
 * a blind spot (a future write bug could inject non-JSON content past this
 * scan undetected; ship-check finding, 2026-08-06).
 */
function scanJsonlValue(text) {
  const findings = [];
  const badLineNumbers = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      badLineNumbers.push(i + 1);
      continue;
    }
    walk(parsed, [`line${i + 1}`], (f) => findings.push(f));
  }
  Object.defineProperty(findings, 'badLineNumbers', { value: badLineNumbers, enumerable: false });
  return findings;
}

module.exports = { EMAIL_RE, maskEmail, formatPath, scanJsonValue, scanJsonlValue };
