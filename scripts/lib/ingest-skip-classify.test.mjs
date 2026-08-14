// Tests for ingest-skip-classify.js — the benign-vs-conflict split that stops
// a cross-show URL ownership veto from being logged as a harmless no-op.
// Regression anchor: I'm Every Woman's Guardian/Times/Standard reviews were
// filed under the-car-man-west-end-2026, so ownership refused every hourly
// ingest attempt and the audit recorded "no-op" each time (2026-08-09).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const {
  classifyIngestSkip,
  classifyReason,
  describeSkip,
  CONFLICT_REASONS,
  EXPECTED_REJECTION_REASONS,
  BENIGN_REASONS,
} = require_('./ingest-skip-classify.js');

test('cross-show URL ownership is a conflict, not a benign no-op', () => {
  // Real emitted shape: `cross-show-url-owned:<showId>` — no space, so the
  // detail group captures the owning show.
  const stdout = [
    '  ⛔ Cross-show URL ownership: https://www.theguardian.com/stage/2026/aug/05/im-every-woman'
      + ' is live at the-car-man-west-end-2026/guardian--ammar-kalia.json — refusing new file',
    '⚠️  Skipped: cross-show-url-owned:the-car-man-west-end-2026',
    'Done.',
  ].join('\n');
  const got = classifyIngestSkip(stdout);
  assert.equal(got.kind, 'conflict');
  assert.equal(got.reason, 'cross-show-url-owned');
  assert.equal(got.detail, 'the-car-man-west-end-2026', 'owning show must be surfaced for the alert');
});

test('domain-mismatch is a conflict in its REAL prose shape (space after colon)', () => {
  // Captured verbatim from a live run against 1minutecritic.substack.com.
  // The space after the colon means the detail group must not capture prose.
  const stdout = '⚠️  Skipped: domain-mismatch: URL domain 1minutecritic.substack.com '
    + "doesn't match outlet one-minute-critic (expected 1minutecritic.com)\nDone.";
  const got = classifyIngestSkip(stdout);
  assert.equal(got.kind, 'conflict', 'prose detail must not break the conflict verdict');
  assert.equal(got.reason, 'domain-mismatch');
  assert.equal(got.detail, null, 'prose after ": " is not a machine-readable detail');
});

test('no-changes stays benign so the chronic hourly alarm stays silenced', () => {
  const got = classifyIngestSkip('⚠️  Skipped: no-changes\nDone.');
  assert.equal(got.kind, 'benign');
  assert.equal(got.reason, 'no-changes');
});

test('junk-outlet (ticket sellers) stays benign', () => {
  assert.equal(classifyIngestSkip('⚠️  Skipped: junk-outlet').kind, 'benign');
});

test('an unrecognised skip reason is unclassified — NEVER silently benign', () => {
  const got = classifyIngestSkip('⚠️  Skipped: some-future-reason');
  assert.equal(got.kind, 'unclassified');
  assert.equal(got.reason, 'some-future-reason');
});

test('no skip line at all is unclassified with a null reason', () => {
  const got = classifyIngestSkip('✅ Created: /path/to/file.json\nDone.');
  assert.equal(got.kind, 'unclassified');
  assert.equal(got.reason, null);
});

test('empty/undefined stdout does not throw', () => {
  assert.equal(classifyIngestSkip('').kind, 'unclassified');
  assert.equal(classifyIngestSkip(undefined).kind, 'unclassified');
  assert.equal(classifyIngestSkip(null).kind, 'unclassified');
});

// ── classifyReason: the raw-result entry point BRO-205 added for the 6
// scrape-*.js callers that hold `result.reason` directly (never round-trip
// through a child process's stdout) — same contract as classifyIngestSkip,
// different input shape, so it needs its own coverage of the same real
// review-file-writer.js literal shapes.
test('classifyReason: cross-show-url-owned (machine-readable detail, no space)', () => {
  const got = classifyReason('cross-show-url-owned:the-car-man-west-end-2026');
  assert.equal(got.kind, 'conflict');
  assert.equal(got.reason, 'cross-show-url-owned');
  assert.equal(got.detail, 'the-car-man-west-end-2026');
});

test('classifyReason: domain-mismatch prose (space after colon defeats detail capture)', () => {
  const got = classifyReason("domain-mismatch: URL domain 1minutecritic.substack.com doesn't match outlet one-minute-critic (expected 1minutecritic.com)");
  assert.equal(got.kind, 'conflict');
  assert.equal(got.reason, 'domain-mismatch');
  assert.equal(got.detail, null);
});

test('classifyReason: plain conflict/expected/benign reasons with no detail', () => {
  for (const reason of ['no-outlet', 'suspicious-outlet-id', 'aggregator-url-mismatch', 'aggregator-url-refinement-refused']) {
    assert.equal(classifyReason(reason).kind, 'conflict', reason);
  }
  assert.equal(classifyReason('cross-market').kind, 'expected');
  assert.equal(classifyReason('onMerge-aborted').kind, 'expected');
  assert.equal(classifyReason('tour-review').kind, 'expected');
  assert.equal(classifyReason('no-changes').kind, 'benign');
  assert.equal(classifyReason('junk-outlet').kind, 'benign');
});

test('classifyReason: unrecognised reason is unclassified, never silently benign', () => {
  const got = classifyReason('some-future-reason');
  assert.equal(got.kind, 'unclassified');
  assert.equal(got.reason, 'some-future-reason');
});

test('classifyReason: empty/undefined/null does not throw', () => {
  assert.equal(classifyReason('').kind, 'unclassified');
  assert.equal(classifyReason(undefined).kind, 'unclassified');
  assert.equal(classifyReason(null).kind, 'unclassified');
});

test('classifyReason and classifyIngestSkip agree on every real reason review-file-writer.js emits', () => {
  for (const reason of [...CONFLICT_REASONS, ...EXPECTED_REJECTION_REASONS, ...BENIGN_REASONS]) {
    const viaReason = classifyReason(reason);
    const viaStdout = classifyIngestSkip(`⚠️  Skipped: ${reason}`);
    assert.equal(viaReason.kind, viaStdout.kind, reason);
  }
});

// ── Expected rejections: visible, never residual (ship-check finding C) ──────
// A cross-market refusal is CORRECT and PERMANENT. Classifying it as a conflict
// made every legitimately-refused review inflate the residual tally on every
// hourly run — the chronic alarm the 2026-08-06 ship-check deliberately removed.
test('cross-market is an expected rejection, not a conflict', () => {
  const got = classifyIngestSkip('⚠️  Skipped: cross-market');
  assert.equal(got.kind, 'expected');
  assert.equal(got.reason, 'cross-market');
});

// The two literals the first version of the contract grep could not see.
test('onMerge-aborted (capital M) classifies — the grep used to be lowercase-only', () => {
  const got = classifyIngestSkip('⚠️  Skipped: onMerge-aborted');
  assert.equal(got.kind, 'expected', 'must not fall through to unclassified');
  assert.equal(got.reason, 'onmerge-aborted', 'reason is lower-cased for lookup');
});

test('empty-unknown with its real prose tail classifies — the grep used to reject colons', () => {
  const got = classifyIngestSkip('⚠️  Skipped: empty-unknown: no URL, no text, unknown critic');
  assert.equal(got.kind, 'expected');
  assert.equal(got.reason, 'empty-unknown');
  assert.equal(got.detail, null, 'prose after ": " is not a machine-readable detail');
});

test('the three reason lists are pairwise disjoint', () => {
  const lists = { CONFLICT_REASONS, EXPECTED_REJECTION_REASONS, BENIGN_REASONS };
  for (const [aName, a] of Object.entries(lists)) {
    for (const [bName, b] of Object.entries(lists)) {
      if (aName >= bName) continue;
      assert.deepEqual(
        a.filter((r) => b.includes(r)), [],
        `a reason cannot be in both ${aName} and ${bName}`,
      );
    }
  }
});

test('every classified reason is lower-case — classifyIngestSkip lower-cases before lookup', () => {
  for (const r of [...CONFLICT_REASONS, ...EXPECTED_REJECTION_REASONS, ...BENIGN_REASONS]) {
    assert.equal(r, r.toLowerCase(), `"${r}" can never match: lookups are lower-cased`);
  }
});

// Scrape every skip reason review-file-writer.js can emit. Exported so the
// count assertion and the classification assertion below read the SAME set,
// and so a future caller can reuse it.
//
// The charset is [A-Za-z0-9-] (not [a-z0-9-]) and the literal may carry a
// `: prose` tail: the first version of this grep was lowercase-only and
// colon-intolerant, so it silently could not see `onMerge-aborted` (:752) or
// `empty-unknown: no URL, no text, unknown critic` (:532) — two real reasons
// that were therefore never contract-checked at all while this test reported
// full coverage (ship-check 2026-08-09, finding A). If you narrow this regex,
// you re-open that hole.
function emittedSkipReasons() {
  const writer = fs.readFileSync(path.join(__dirname, 'review-file-writer.js'), 'utf8');
  const emitted = new Set();
  // Quoted literals, with or without a `: prose` tail:
  //   reason: 'no-changes'
  //   reason: 'onMerge-aborted'
  //   reason: 'empty-unknown: no URL, no text, unknown critic'
  for (const m of writer.matchAll(/reason:\s*'([A-Za-z0-9-]+)(?::[^']*)?'/g)) emitted.add(m[1].toLowerCase());
  // Template forms: `reason: \`domain-mismatch: ${...}\`` / `cross-show-url-owned:${...}`
  for (const m of writer.matchAll(/reason:\s*`([A-Za-z0-9-]+)[:`]/g)) emitted.add(m[1].toLowerCase());
  return emitted;
}

// The contract test. review-file-writer.js is the ONLY producer of these
// strings; if someone adds a skip reason there and does not classify it here,
// it would silently default to quiet — the exact bug this module removes.
// Greps the real file so the two cannot drift apart unnoticed.
test('every skip reason review-file-writer.js emits is classified', () => {
  const emitted = emittedSkipReasons();
  assert.ok(emitted.size >= 8, `expected to find skip reasons in review-file-writer.js, found ${emitted.size}`);
  const known = new Set([...CONFLICT_REASONS, ...EXPECTED_REJECTION_REASONS, ...BENIGN_REASONS]);
  const unclassified = [...emitted].filter((r) => !known.has(r));
  assert.deepEqual(
    unclassified,
    [],
    `review-file-writer.js emits skip reason(s) that ingest-skip-classify.js does not classify: ${unclassified.join(', ')}. `
      + 'Add each to CONFLICT_REASONS (two records disagree; a human must resolve), EXPECTED_REJECTION_REASONS '
      + '(refusal is correct and permanent), or BENIGN_REASONS (desired end state already holds). '
      + 'Leaving one out makes it default to quiet.',
  );
});

// Anti-vacuity guard for the grep itself. The contract test above can only
// protect reasons its regex can SEE, and a silently-narrowed regex looks
// identical to a passing test. Name the two literals whose shapes broke it
// before, so re-narrowing the charset or the colon tolerance fails HERE with a
// message that says why, instead of quietly shrinking coverage.
test('the producer grep can see the awkward literal shapes (capital letter, colon tail)', () => {
  const emitted = emittedSkipReasons();
  for (const reason of ['onmerge-aborted', 'empty-unknown']) {
    assert.ok(
      emitted.has(reason),
      `the review-file-writer.js grep no longer sees "${reason}". Its literal has a capital letter and/or a `
        + '": prose" tail; a lowercase-only or colon-intolerant regex misses it and the contract test then '
        + 'reports coverage it does not have (the 2026-08-09 finding-A hole).',
    );
  }
});

test('describeSkip names the owning show AND the fix, not just the symptom', () => {
  const msg = describeSkip(
    'im-every-woman-off-west-end-2026',
    'https://www.theguardian.com/stage/2026/aug/05/im-every-woman',
    { reason: 'cross-show-url-owned', detail: 'the-car-man-west-end-2026' },
  );
  assert.match(msg, /the-car-man-west-end-2026/, 'must name the other side');
  assert.match(msg, /wrongShowReason/, 'must state the action that releases ownership');
  assert.doesNotMatch(msg, /no-op/i, 'a conflict must never be described as a no-op');
});

test('every conflict AND expected-rejection reason has a bespoke describeSkip message', () => {
  for (const reason of [...CONFLICT_REASONS, ...EXPECTED_REJECTION_REASONS]) {
    const msg = describeSkip('some-show-2026', 'https://example.com/r', { reason, detail: null });
    assert.doesNotMatch(
      msg,
      /^some-show-2026: https:\/\/example\.com\/r skipped as /,
      `${reason} falls through to the generic message — give it an actionable one`,
    );
  }
});
