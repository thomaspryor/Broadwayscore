/**
 * Task #782: validateUrlDomain() cousin vacuous-guard on the write path.
 *
 * Same bug class as #766 (isOutletEligibleForSerpDiscovery on the SERP-discovery
 * read path): for any of the ~360 domainless registry outlets (domain: null),
 * OUTLET_DOMAINS[outletId] resolves empty, so validateUrlDomain used to return a
 * bare { valid: true } no matter what host the URL carried — real domain
 * mismatches were still caught, but domainless outlets got zero validation and
 * zero trace. Fix: return { valid: true, unvalidated: true, reason } for the
 * domainless case, and review-file-writer.js's Guard: domain validation stamps
 * fields.domainUnvalidated + logs a warning so these stay visible for
 * outlet-registry backfill instead of disappearing into a silent pass.
 *
 * Runs via the scripts/lib/*.test.mjs CI glob.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { validateUrlDomain } = require('./url-discovery.js');
const { createOrMergeReviewFile } = require('./review-file-writer.js');

const quiet = (fn) => {
  const w = console.warn, l = console.log;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  console.log = () => {};
  try { return { result: fn(), warnings }; } finally { console.warn = w; console.log = l; }
};

// --- Pure validateUrlDomain() tests ---

test('domainless outlet: URL passes but is flagged unvalidated (not a silent bare pass)', () => {
  // the-journal is genuinely domainless by design (task #766 re-triage,
  // 2026-08-17) — its historical domain went 410, and its live content now
  // sits on evening-chronicle's registered domain, so it's deliberately kept
  // domainless rather than colliding two outletIds onto one host.
  const r = validateUrlDomain('https://www.facebook.com/some/post', 'the-journal');
  assert.equal(r.valid, true);
  assert.equal(r.unvalidated, true);
  assert.match(r.reason, /no registered domain/);
});

test('real-domain outlet: mismatched host still returns valid:false (no regression)', () => {
  const r = validateUrlDomain('https://www.newsshopper.co.uk/some-review', 'telegraph');
  assert.equal(r.valid, false);
  assert.equal(r.unvalidated, undefined);
  assert.match(r.reason, /doesn't match outlet telegraph/);
});

test('real-domain outlet: matching host returns valid:true, no unvalidated flag', () => {
  const r = validateUrlDomain('https://www.telegraph.co.uk/theatre/some-review/', 'telegraph');
  assert.equal(r.valid, true);
  assert.equal(r.unvalidated, undefined);
});

test('mixed-case outletId still resolves its registered domain (case-insensitive lookup)', () => {
  // A mixed-case outletId for a REAL domained outlet must not be wrongly
  // stamped unvalidated:true — that would poison the domainless-backfill signal.
  const matching = validateUrlDomain('https://www.telegraph.co.uk/theatre/some-review/', 'Telegraph');
  assert.equal(matching.valid, true);
  assert.equal(matching.unvalidated, undefined);

  const mismatched = validateUrlDomain('https://www.newsshopper.co.uk/some-review', 'Telegraph');
  assert.equal(mismatched.valid, false);
  assert.equal(mismatched.unvalidated, undefined);
});

test('no url or no outletId: valid:true, no unvalidated flag (unchanged)', () => {
  assert.deepEqual(validateUrlDomain('', 'telegraph'), { valid: true });
  assert.deepEqual(validateUrlDomain('https://example.com/x', ''), { valid: true });
});

// --- Integration: review-file-writer.js surfaces the signal on write ---

function withTempReviewTextsDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'domain-validation-guard-'));
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('createOrMergeReviewFile stamps domainUnvalidated + warns for a domainless outlet', () => {
  withTempReviewTextsDir((reviewTextsDir) => {
    const { result, warnings } = quiet(() => createOrMergeReviewFile(
      'some-west-end-show-2026',
      {
        outlet: 'The Journal',
        outletId: 'the-journal',
        criticName: 'Some Critic',
        url: 'https://www.facebook.com/some/post',
        source: 'test',
        fields: { showScoreExcerpt: 'A four-star review of the production.' },
      },
      { reviewTextsDir }
    ));
    assert.equal(result.action, 'new');
    const written = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));
    assert.equal(written.domainUnvalidated, true);
    assert.match(written.domainUnvalidatedReason, /no registered domain for outlet "the-journal"/);
    assert.ok(warnings.some(w => /Unvalidated domain/.test(w)), 'expected a console.warn about the unvalidated domain');
  });
});

test('createOrMergeReviewFile does NOT stamp domainUnvalidated for a real-domain outlet', () => {
  withTempReviewTextsDir((reviewTextsDir) => {
    const { result } = quiet(() => createOrMergeReviewFile(
      'some-west-end-show-2026',
      {
        outlet: 'The Telegraph',
        outletId: 'telegraph',
        criticName: 'Some Critic',
        url: 'https://www.telegraph.co.uk/theatre/some-review/',
        source: 'test',
        fields: { showScoreExcerpt: 'A four-star review of the production.' },
      },
      { reviewTextsDir }
    ));
    assert.equal(result.action, 'new');
    const written = JSON.parse(fs.readFileSync(result.filepath, 'utf8'));
    assert.equal(written.domainUnvalidated, undefined);
  });
});

test('createOrMergeReviewFile still rejects a real host mismatch (no regression on write path)', () => {
  withTempReviewTextsDir((reviewTextsDir) => {
    const { result } = quiet(() => createOrMergeReviewFile(
      'some-west-end-show-2026',
      {
        outlet: 'The Telegraph',
        outletId: 'telegraph',
        criticName: 'Some Critic',
        url: 'https://www.newsshopper.co.uk/some-review',
        source: 'test',
        fields: { showScoreExcerpt: 'A four-star review of the production.' },
      },
      { reviewTextsDir }
    ));
    assert.equal(result.action, 'skipped');
    assert.match(result.reason, /domain-mismatch/);
  });
});
