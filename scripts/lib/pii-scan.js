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

// A local part that SAYS it has been redacted is not a submitter's address.
// The case that forced this (BRO-2741 sweep, 2026-09-02): an audit row quoted
// a Linear issue whose body contained the credential-in-URL form
// `https://gho_REDACTED@github.com/owner/repo.git`. EMAIL_RE matches
// `gho_REDACTED@github.com`, so a card ABOUT not leaking a token was itself
// flagged as leaking an email, and it took the public repo's CI red.
//
// ANCHORED, and the anchoring is the whole safety argument. An unanchored
// /redacted/i substring test suppressed `notredacted@gmail.com`,
// `unredacted@gmail.com` and `REDACTED-jane.doe@nytimes.com` — all registerable
// real addresses — in exactly the free-text shape this lint was built for
// (#1064: an address baked into a `description` field). Caught in review; do
// not loosen this back to a substring test.
//
// The local part must BE "redacted" or end in "_redacted": gho_REDACTED,
// ghp_REDACTED, token_Redacted, redacted. Underscore only, deliberately —
// allowing `.` or `-` as the separator still suppressed
// `tom.pryor.redacted@gmail.com`, which is a perfectly registerable address.
// GitHub's token prefixes (gho_, ghp_, github_pat_) all use underscore, so
// nothing real is lost by refusing the other two separators.
//
// Masked forms like `****@example.com` deliberately have NO rule here: the
// local part of EMAIL_RE is [A-Za-z0-9._%+-]+, which excludes `*`, so those
// never matched and never needed excusing. A carve-out for them would have
// been dead code that read as protection.
const REDACTED_LOCAL_RE = /(?:^|_)redacted$/i;
const EMAIL_RE_G = new RegExp(EMAIL_RE.source, 'g');

/**
 * The first REAL (non-placeholder) address in `value`, or null when every
 * EMAIL_RE hit is a redaction placeholder.
 *
 * Scans EVERY match, not just the first. An earlier single-match version was
 * caught by its own test: "ref gho_REDACTED@github.com and contact
 * entrant@gmail.com" looked redacted because the placeholder happened to come
 * first, which would have suppressed a genuine address sitting right after it.
 *
 * Walks the '@' characters and judges each one inside a BOUNDED window, rather
 * than running the regex over the whole string. Two defects forced this shape,
 * both found by adversarial review of the previous versions:
 *
 * 1. ReDoS. EMAIL_RE's `[A-Za-z0-9.-]+\.[A-Za-z]{2,}` backtracks
 *    catastrophically on long punctuation runs. The original code escaped it
 *    only by short-circuiting on the first match; scanning every match
 *    re-exposed it. A whitespace-tokenising attempt looked fixed but only
 *    helped when the junk was whitespace-SEPARATED — concatenated into the
 *    same token, `'redacted@ex.com' + 'a.-%+_'.repeat(30000)` still measured
 *    14,715 ms (0 ms before the change), and the test written to guard it used
 *    a space, so it passed at 0 ms and could not catch it. Capping each window
 *    at RFC lengths (64-char local, 255-char domain) bounds the regex's reach
 *    structurally, whatever the input looks like.
 *
 * 2. A placeholder could swallow a real address behind it. Advancing past a
 *    rejected match skipped any address beginning inside its span:
 *    `x_redacted@github.com.jane@gmail.com` returned NO findings while the
 *    pre-change code flagged it. Judging each '@' on its own, and resuming at
 *    `m.index + 1` while still short of the target '@', finds the later
 *    address. Resuming that way only INSIDE the window is what keeps it cheap.
 *
 * A match is only judged when its '@' is the one being examined, so a
 * sub-match of a rejected placeholder (`EDACTED@github.com` inside
 * `gho_REDACTED@github.com`) can never be mistaken for a real address.
 */
const MAX_LOCAL_PART = 64;   // RFC 5321 §4.5.3.1.1
const MAX_DOMAIN_PART = 255; // RFC 1035 §2.3.4

/**
 * Judge the single '@' at absolute index `at`, looking `domainSpan` chars past
 * it. Returns the real address, the string 'placeholder', or null (no match).
 */
function judgeAt(s, at, domainSpan) {
  const start = Math.max(0, at - MAX_LOCAL_PART);
  const win = s.slice(start, Math.min(s.length, at + 1 + domainSpan));
  const atInWin = at - start;
  EMAIL_RE_G.lastIndex = 0;
  let m;
  while ((m = EMAIL_RE_G.exec(win)) !== null) {
    const atPos = m.index + m[0].indexOf('@');
    if (atPos > atInWin) break;            // this '@' is not part of any match
    if (atPos === atInWin) {
      return REDACTED_LOCAL_RE.test(m[0].split('@')[0]) ? 'placeholder' : m[0];
    }
    EMAIL_RE_G.lastIndex = m.index + 1;    // overlapping candidate may follow
  }
  return null;
}

function firstRealEmail(value) {
  const s = String(value || '');

  // FAST PATH, and it is the whole cost story. This single exec is exactly the
  // work the pre-exemption code did (it called EMAIL_RE.test), so for every
  // input without a placeholder — which is all of them but the rare quoted
  // credential — this module is no slower and no less sensitive than before the
  // exemption existed. In particular it cannot truncate a long domain, which is
  // how a bounded-window-only version silently stopped flagging
  // 'jane@' + 'a'.repeat(253) + '.com' (found by fuzzing 220,026 cases).
  const first = EMAIL_RE.exec(s);
  if (!first) return null;
  if (!REDACTED_LOCAL_RE.test(first[0].split('@')[0])) return first[0];

  // SLOW PATH, reached only when the FIRST match is a redaction placeholder.
  // Now we must keep looking for a real address behind it, and that is the scan
  // that made a whole-string version quadratic. Bounded per-'@' windows keep it
  // cheap. The residual is narrow and deliberate: in this branch alone, a real
  // address whose domain runs past MAX_DOMAIN_PART could be missed. It requires
  // a placeholder first AND a 255-char domain in the same value; the longest
  // domain run after any '@' in the entire 925-file corpus is 24.
  let at = s.indexOf('@');
  while (at !== -1) {
    const verdict = judgeAt(s, at, MAX_DOMAIN_PART);
    if (verdict !== null && verdict !== 'placeholder') return verdict;
    at = s.indexOf('@', at + 1);
  }
  return null;
}

/** True when `value` contains at least one EMAIL_RE hit and none are real. */
function isRedactedPlaceholder(value) {
  return EMAIL_RE.test(String(value || '')) && firstRealEmail(value) === null;
}
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
    const realEmail = firstRealEmail(value);
    if (realEmail) {
      // Mask the REAL hit, not whatever EMAIL_RE matched first — otherwise a
      // string carrying a placeholder ahead of a genuine address would report
      // the placeholder and read as harmless.
      onFinding({ type: 'email-shaped-string', path: pathSegs, snippet: maskEmail(realEmail) });
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

module.exports = { EMAIL_RE, maskEmail, formatPath, scanJsonValue, scanJsonlValue, isRedactedPlaceholder, firstRealEmail };
