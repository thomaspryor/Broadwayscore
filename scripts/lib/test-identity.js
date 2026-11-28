'use strict';
/**
 * test-identity.js — BRO-7102 item 4: ONE identity for a failing test, shared by
 * every filer that opens a card for one.
 *
 * Before this, the same red test got three unrelated keys:
 *   - main test.yml red (route-main-streak-signatures.js): test-yml:red:<job>:<sha1(step::name)>
 *   - live-data lane (live-data-routing.js):               live-data-test:<file>::<name>
 *   - digest-autofix:                                      the row title
 * None could find the others' card. The common overlap is the router's digest
 * line ("Live-data test failing: X") against digest-autofix's card ("BSC Daily:
 * Live-data test failing: X"): the exact-title fallback never matched them. The
 * live-data and test.yml lanes are disjoint by design, so they overlap only while
 * a test moves lanes, which this also covers.
 *
 * Shared-card limits: the card keeps the first filer's VERIFY; a card closed
 * while the other condition stays red is refiled by the router's existing
 * tracker-refile check (owner-alert-router trackerRefileDue), not by this.
 *
 * Every filer now writes `[testId:<id>]` into the card it files, and looks for
 * that marker before filing (owner-alert-router findLinearDuplicate,
 * digest-autofix fileCard). Sharing a card is safe: the resolved-alert-card
 * sweep cancels a card only when NO open condition still points at it.
 *
 * PURE. The id is `<repo-relative file>::<test title>`. A title with no file is
 * not an identity (titles repeat across files), so it returns null.
 */
const crypto = require('crypto');

const MARKER_PREFIX = '[testId:';
const MAX_ID_LEN = 200;
// Playwright's breadcrumb separator in list/line reporter output.
const PW_SEP = ' › ';

function normFile(file) {
  let f = String(file || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
  f = f.replace(/:\d+(?::\d+)?$/, ''); // spec.ts:12:3 -> spec.ts
  if (!f || f === '?') return null;
  return f;
}

function normName(name) {
  let n = String(name || '').replace(/\s+/g, ' ').trim();
  n = n.replace(/\s*\(retry #\d+\)\s*$/i, '').replace(/\s*\(\d+(?:\.\d+)?m?s\)\s*$/, '').trim();
  return n || null;
}

/** PURE. `<file>::<name>` (capped at MAX_ID_LEN with a hash tail), or null when either part is missing. */
function testIdentity(file, name) {
  const f = normFile(file);
  const n = normName(name);
  if (!f || !n) return null;
  const id = `${f}::${n}`;
  if (id.length <= MAX_ID_LEN) return id;
  const h = crypto.createHash('sha1').update(id).digest('hex').slice(0, 8);
  return `${id.slice(0, MAX_ID_LEN - 9)}#${h}`;
}

/**
 * PURE. A Playwright name as main-red-streak's firstFailingPlaywrightTestInJobLog
 * returns it (`<spec> › Suite › Title`, project and line:col already dropped)
 * -> its test identity. Tolerates a leftover `[project]` prefix or `:L:C`.
 */
function testIdFromPlaywright(pwName) {
  const parts = String(pwName || '').replace(/^\s*\[[^\]]+\]\s*›?\s*/, '').split(PW_SEP);
  if (parts.length < 2) return null;
  return testIdentity(parts[0], parts.slice(1).join(PW_SEP));
}

/**
 * PURE. The identity of the test a main test.yml signature names: Playwright
 * names carry their spec; a TAP title needs the file from the job log.
 */
function testIdForSignature({ testName, testFile }) {
  if (!testName) return null;
  if (String(testName).includes(PW_SEP)) return testIdFromPlaywright(testName);
  return testIdentity(testFile, testName);
}

function testIdMarker(id) {
  return id ? `${MARKER_PREFIX}${id}]` : '';
}

module.exports = { testIdentity, testIdFromPlaywright, testIdForSignature, testIdMarker, MARKER_PREFIX, MAX_ID_LEN };
