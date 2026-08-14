import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { evaluateDatePlausibility, DAYS_IMPLAUSIBLE_BEFORE } = require('./date-plausibility.js');
const { safeWriteReview, _setShowsCacheForTest } = require('./review-write-guard.js');

function mkReviewTextsRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'date-plausibility-'));
}

// --- Pure evaluateDatePlausibility() ---------------------------------------

test('#832 cyrano replay: Guardian review dated 2025-08-01 (RSC Swan pre-transfer run) is implausible against a 2026 opening with no priorRuns', () => {
  const show = { id: 'cyrano-de-bergerac-west-end-2026', previewsStartDate: '2026-03-10', openingDate: '2026-03-25' };
  const review = { publishDate: '2025-08-01', criticName: 'Arifa Akbar' };
  const verdict = evaluateDatePlausibility({ review, show });
  assert.equal(verdict.implausible, true);
  assert.equal(verdict.reason, 'date_implausible');
  assert.ok(verdict.daysBefore > DAYS_IMPLAUSIBLE_BEFORE);
});

test('#832 cyrano replay, fixed: the same review is plausible once the RSC Swan run is declared as a priorRun covering 2025-08-01', () => {
  const show = {
    id: 'cyrano-de-bergerac-west-end-2026',
    previewsStartDate: '2026-03-10',
    openingDate: '2026-03-25',
    priorRuns: [{ venue: 'RSC Swan Theatre', openingDate: '2025-07-01', closingDate: '2025-09-01' }],
  };
  const review = { publishDate: '2025-08-01', criticName: 'Arifa Akbar' };
  const verdict = evaluateDatePlausibility({ review, show });
  assert.equal(verdict.implausible, false);
});

test('#832 crocodile replay: WhatsOnStage /tours/ page dated far before the WE opening, no priorRuns, is implausible', () => {
  const show = { id: 'the-enormous-crocodile-west-end-2026', previewsStartDate: '2026-04-01', openingDate: '2026-04-14' };
  const review = { publishDate: '2025-06-01', criticName: 'Ron Simpson' };
  const verdict = evaluateDatePlausibility({ review, show });
  assert.equal(verdict.implausible, true);
});

test('an LLM-guessed date (dateSource: llm-scoring) never makes a review implausible', () => {
  // ensemble-scorer.ts fills a missing publishDate from the scoring model's own
  // guess. Nothing verifies it, and a hallucinated year previously turned this
  // guard into a phantom wrong-production detector — that is what held main red.
  // Same fixture as the cyrano replay above, which IS implausible on a real date.
  const show = { id: 'cyrano-de-bergerac-west-end-2026', previewsStartDate: '2026-03-10', openingDate: '2026-03-25' };
  const guessed = { publishDate: '2025-08-01', dateSource: 'llm-scoring' };
  const verdict = evaluateDatePlausibility({ review: guessed, show });
  assert.equal(verdict.implausible, false, 'an unverified model guess is not evidence of a wrong production');
  assert.equal(verdict.reason, null);

  // Control: the identical date from a real extractor is still caught, so this
  // exemption is scoped to the guess and has not disarmed the guard.
  for (const src of ['url', 'text-regex', 'html-cookies', 'text-llm', undefined]) {
    const real = { publishDate: '2025-08-01', ...(src ? { dateSource: src } : {}) };
    assert.equal(
      evaluateDatePlausibility({ review: real, show }).implausible, true,
      `dateSource=${String(src)} must still be judged on its date`
    );
  }
});

test('same-window review writes normally: publishDate a few days before opening is plausible', () => {
  const show = { previewsStartDate: '2026-04-01', openingDate: '2026-04-14' };
  const review = { publishDate: '2026-04-13' };
  const verdict = evaluateDatePlausibility({ review, show });
  assert.equal(verdict.implausible, false);
});

test('priorRun-covered date writes normally even far before the current run opens', () => {
  const show = {
    openingDate: '2026-04-14',
    priorRuns: [{ openingDate: '2024-01-01', closingDate: '2024-03-01' }],
  };
  const review = { publishDate: '2024-02-01' };
  const verdict = evaluateDatePlausibility({ review, show });
  assert.equal(verdict.implausible, false);
});

test('already-flagged reviews (wrongProduction/wrongShow/etc.) are out of scope regardless of date', () => {
  const show = { openingDate: '2026-04-14' };
  const base = { publishDate: '2020-01-01' };
  for (const flag of ['wrongShow', 'wrongProduction', 'wrongUrl', 'duplicateOf', 'isRoundupArticle', 'isNotReview']) {
    const verdict = evaluateDatePlausibility({ review: { ...base, [flag]: true }, show });
    assert.equal(verdict.implausible, false, `flag ${flag} should exempt`);
  }
});

test('a genuine humanReviewScore override exempts the review from the date check', () => {
  const show = { openingDate: '2026-04-14' };
  const review = { publishDate: '2020-01-01', humanReviewScore: 85 };
  const verdict = evaluateDatePlausibility({ review, show });
  assert.equal(verdict.implausible, false);
});

test('missing publishDate or missing show data is a no-op, not a crash', () => {
  assert.equal(evaluateDatePlausibility({ review: {}, show: { openingDate: '2026-01-01' } }).implausible, false);
  assert.equal(evaluateDatePlausibility({ review: { publishDate: '2020-01-01' }, show: {} }).implausible, false);
  assert.equal(evaluateDatePlausibility({ review: null, show: null }).implausible, false);
});

test('exactly at the 180-day boundary is plausible; one day past is implausible', () => {
  const show = { openingDate: '2026-07-01' };
  const atBoundary = evaluateDatePlausibility({ review: { publishDate: '2026-01-02' }, show });
  assert.equal(atBoundary.implausible, false);
  const pastBoundary = evaluateDatePlausibility({ review: { publishDate: '2026-01-01' }, show });
  assert.equal(pastBoundary.implausible, true);
});

// --- safeWriteReview() ingest-time quarantine routing -----------------------

test('safeWriteReview quarantines a brand-new date-implausible review to _pending/{showId}/ instead of the show dir', () => {
  const root = mkReviewTextsRoot();
  const showId = 'cyrano-de-bergerac-west-end-2026';
  _setShowsCacheForTest(new Map([[showId, { id: showId, previewsStartDate: '2026-03-10', openingDate: '2026-03-25' }]]));

  const targetPath = path.join(root, showId, 'guardian--arifa-akbar.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const result = safeWriteReview(targetPath, { publishDate: '2025-08-01', criticName: 'Arifa Akbar', url: 'https://example.com/x' });

  assert.equal(result.wrote, false);
  assert.equal(result.skipped, 'date_implausible');
  assert.equal(fs.existsSync(targetPath), false);

  const pendingPath = path.join(root, '_pending', showId, 'guardian--arifa-akbar.json');
  assert.equal(fs.existsSync(pendingPath), true);
  const quarantined = JSON.parse(fs.readFileSync(pendingPath, 'utf-8'));
  assert.equal(quarantined.pendingReason, 'date_implausible');
});

test('safeWriteReview writes a same-window new review normally (no quarantine)', () => {
  const root = mkReviewTextsRoot();
  const showId = 'the-enormous-crocodile-west-end-2026';
  _setShowsCacheForTest(new Map([[showId, { id: showId, previewsStartDate: '2026-04-01', openingDate: '2026-04-14' }]]));

  const targetPath = path.join(root, showId, 'whatsonstage--ron-simpson.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const result = safeWriteReview(targetPath, { publishDate: '2026-04-13', criticName: 'Ron Simpson', url: 'https://example.com/y' });

  assert.equal(result.wrote, true);
  assert.equal(fs.existsSync(targetPath), true);
  assert.equal(fs.existsSync(path.join(root, '_pending', showId, 'whatsonstage--ron-simpson.json')), false);
});

test('safeWriteReview writes a priorRun-covered new review normally (no quarantine)', () => {
  const root = mkReviewTextsRoot();
  const showId = 'cyrano-de-bergerac-west-end-2026-priorrun';
  _setShowsCacheForTest(new Map([[showId, {
    id: showId,
    previewsStartDate: '2026-03-10',
    openingDate: '2026-03-25',
    priorRuns: [{ venue: 'RSC Swan Theatre', openingDate: '2025-09-15', closingDate: '2025-11-01' }],
  }]]));

  const targetPath = path.join(root, showId, 'guardian--arifa-akbar.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const result = safeWriteReview(targetPath, { publishDate: '2025-10-08', criticName: 'Arifa Akbar', url: 'https://example.com/z' });

  assert.equal(result.wrote, true);
  assert.equal(fs.existsSync(targetPath), true);
});

test('safeWriteReview does not re-quarantine an already-dated file on an unrelated field update', () => {
  const root = mkReviewTextsRoot();
  const showId = 'sylvia-off-west-end-2026';
  _setShowsCacheForTest(new Map([[showId, { id: showId, openingDate: '2026-05-01' }]]));

  const targetPath = path.join(root, showId, 'stub--critic.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify({ publishDate: '2020-01-01', criticName: 'Stub Critic' }));

  const result = safeWriteReview(targetPath, { publishDate: '2020-01-01', criticName: 'Stub Critic', someUnrelatedFieldUpdate: true });
  assert.equal(result.wrote, true);
  assert.equal(fs.existsSync(targetPath), true);
});

test('#832 ship-check gap: an existing DATELESS stub (saveAggregatorStub pattern) getting an implausible publishDate for the FIRST time is quarantined, not silently admitted', () => {
  const root = mkReviewTextsRoot();
  const showId = 'the-enormous-crocodile-west-end-2026';
  _setShowsCacheForTest(new Map([[showId, { id: showId, previewsStartDate: '2026-04-01', openingDate: '2026-04-14' }]]));

  const targetPath = path.join(root, showId, 'whatsonstage--ron-simpson.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // Registration/discovery pass writes a dateless placeholder first (no publishDate yet).
  fs.writeFileSync(targetPath, JSON.stringify({ criticName: 'Ron Simpson', url: 'https://example.com/tours-page', isPreviewPlaceholder: true }));

  // A later fetch pass supplies the real (implausible) publishDate.
  const result = safeWriteReview(targetPath, { criticName: 'Ron Simpson', url: 'https://example.com/tours-page', publishDate: '2025-06-01' });

  assert.equal(result.wrote, false);
  assert.equal(result.skipped, 'date_implausible');
  const onDisk = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  assert.equal(onDisk.publishDate, undefined, 'the stale dateless stub at the show-dir path must stay untouched, not silently gain the bad date');
  const pending = JSON.parse(fs.readFileSync(path.join(root, '_pending', showId, 'whatsonstage--ron-simpson.json'), 'utf-8'));
  assert.equal(pending.pendingReason, 'date_implausible');
});

test('#832 an existing dateless stub getting a PLAUSIBLE publishDate for the first time writes normally', () => {
  const root = mkReviewTextsRoot();
  const showId = 'the-enormous-crocodile-west-end-2026-plausible';
  _setShowsCacheForTest(new Map([[showId, { id: showId, previewsStartDate: '2026-04-01', openingDate: '2026-04-14' }]]));

  const targetPath = path.join(root, showId, 'whatsonstage--ron-simpson.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify({ criticName: 'Ron Simpson', url: 'https://example.com/x' }));

  const result = safeWriteReview(targetPath, { criticName: 'Ron Simpson', url: 'https://example.com/x', publishDate: '2026-04-13' });
  assert.equal(result.wrote, true);
  const onDisk = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  assert.equal(onDisk.publishDate, '2026-04-13');
});

test('#832 a file that already carries scored/protected content is exempt — a date correction on an already-vetted review is a deliberate fixup, not new ingest', () => {
  const root = mkReviewTextsRoot();
  const showId = 'some-show-2026';
  _setShowsCacheForTest(new Map([[showId, { id: showId, openingDate: '2026-04-14' }]]));

  const targetPath = path.join(root, showId, 'outlet--critic.json');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  // Scored review with no date yet recorded on disk (edge case: assignedScore
  // present but publishDate somehow missing) — still must not be quarantined.
  fs.writeFileSync(targetPath, JSON.stringify({ criticName: 'Critic', assignedScore: 85 }));

  const result = safeWriteReview(targetPath, { criticName: 'Critic', assignedScore: 85, publishDate: '2020-01-01' });
  assert.equal(result.wrote, true);
  assert.equal(result.skipped, undefined);
});
