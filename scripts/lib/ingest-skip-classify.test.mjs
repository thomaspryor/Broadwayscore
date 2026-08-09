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
const { classifyIngestSkip, describeConflict, CONFLICT_REASONS, BENIGN_REASONS } =
  require_('./ingest-skip-classify.js');

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

test('conflict and benign reason lists are disjoint', () => {
  const overlap = CONFLICT_REASONS.filter((r) => BENIGN_REASONS.includes(r));
  assert.deepEqual(overlap, [], 'a reason cannot be both benign and a conflict');
});

// The contract test. review-file-writer.js is the ONLY producer of these
// strings; if someone adds a skip reason there and does not classify it here,
// it would silently default to quiet — the exact bug this module removes.
// Greps the real file so the two cannot drift apart unnoticed.
test('every skip reason review-file-writer.js emits is classified', () => {
  const writer = fs.readFileSync(path.join(__dirname, 'review-file-writer.js'), 'utf8');
  const emitted = new Set();
  // Plain literals: `reason: 'no-changes'`
  for (const m of writer.matchAll(/reason:\s*'([a-z0-9-]+)'/g)) emitted.add(m[1]);
  // Template forms: `reason: \`domain-mismatch: ${...}\`` / `cross-show-url-owned:${...}`
  for (const m of writer.matchAll(/reason:\s*`([a-z0-9-]+)[:`]/g)) emitted.add(m[1]);
  assert.ok(emitted.size >= 5, `expected to find skip reasons in review-file-writer.js, found ${emitted.size}`);
  const known = new Set([...CONFLICT_REASONS, ...BENIGN_REASONS]);
  const unclassified = [...emitted].filter((r) => !known.has(r));
  assert.deepEqual(
    unclassified,
    [],
    `review-file-writer.js emits skip reason(s) that ingest-skip-classify.js does not classify: ${unclassified.join(', ')}. `
      + 'Add each to CONFLICT_REASONS (two records disagree; a human must resolve) or BENIGN_REASONS '
      + '(desired end state already holds). Leaving one out makes it default to quiet.',
  );
});

test('describeConflict names the owning show AND the fix, not just the symptom', () => {
  const msg = describeConflict(
    'im-every-woman-off-west-end-2026',
    'https://www.theguardian.com/stage/2026/aug/05/im-every-woman',
    { reason: 'cross-show-url-owned', detail: 'the-car-man-west-end-2026' },
  );
  assert.match(msg, /the-car-man-west-end-2026/, 'must name the other side');
  assert.match(msg, /wrongShowReason/, 'must state the action that releases ownership');
  assert.doesNotMatch(msg, /no-op/i, 'a conflict must never be described as a no-op');
});

test('every conflict reason has a bespoke describeConflict message', () => {
  for (const reason of CONFLICT_REASONS) {
    const msg = describeConflict('some-show-2026', 'https://example.com/r', { reason, detail: null });
    assert.doesNotMatch(
      msg,
      /^some-show-2026: https:\/\/example\.com\/r skipped as /,
      `${reason} falls through to the generic message — give it an actionable one`,
    );
  }
});
