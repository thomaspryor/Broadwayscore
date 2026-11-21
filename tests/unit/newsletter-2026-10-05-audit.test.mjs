// BRO-4998: durable acceptance coverage of the newsletter audit's four guards.
// These exercise production helpers; the private-data repair is a pending plan.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const { crossCheckOpeningDate, needsPressNightCrossCheck, mergePressNightChanges, westEndOpeningSource } = require('../../scripts/lib/press-night-cross-check');
const { evaluateDateGuard } = require('../../scripts/lib/date-guard');
const { evaluateRepublishedReview } = require('../../scripts/lib/run-contamination');
const { inheritPriorRunReviews } = require('../../scripts/lib/prior-run-sibling');
const { currentRunOnly } = require('../../scripts/lib/prior-production-citations');
const { classifyGapCandidateUrl } = require('../../scripts/lib/non-review-url-patterns');
const { executeReviewFieldEditIn } = require('../../scripts/lib/review-field-edit');

const ghost = { id: 'a-ghost-in-your-ear-off-broadway-2026', category: 'off-broadway',
  openingDate: '2026-10-09', previewsStartDate: '2026-10-03', closingDate: '2026-12-12', openingDateSource: 'playbill' };
const heart = { id: 'from-the-heart-west-end-2026', category: 'west-end',
  openingDate: '2026-10-08', previewsStartDate: '2026-10-08', closingDate: '2026-10-18', openingDateSource: 'review-derived-press-night' };

test('an independent OB listing corrects a Playbill date without moving previews', () => {
  const result = crossCheckOpeningDate(ghost, { source: 'lortel', opening: '2026-10-14', firstPreview: '2026-10-03' });
  assert.equal(result.status, 'corrected');
  assert.deepEqual(result.changes, [
    { field: 'openingDate', old: '2026-10-09', new: '2026-10-14' },
    { field: 'openingDateSource', old: 'playbill', new: 'lortel' },
  ]);
  assert.equal(ghost.openingDate, '2026-10-09', 'planning does not mutate the input');
});

test('a cold open can be confirmed without changing its date', () => {
  const result = crossCheckOpeningDate(heart, { source: 'theatremonkey', opening: '2026-10-08', firstPreview: '2026-10-08' });
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(result.changes, [{ field: 'openingDateSource', old: 'review-derived-press-night', new: 'theatremonkey' }]);
});

test('Playbill cannot confirm itself, nor can another review-derived date', () => {
  for (const source of ['playbill', 'playbill-production-page', 'both', 'inferred-from-reviews', 'lortel']) {
    const result = crossCheckOpeningDate(heart, { source, opening: '2026-10-08' });
    assert.equal(result.status, 'unverified', source);
    assert.deepEqual(result.changes, []);
  }
  assert.equal(crossCheckOpeningDate(ghost, null).status, 'unverified');
  assert.equal(crossCheckOpeningDate(heart, { source: 'theatremonkey', opening: null }).status, 'unverified');
});

test('manual, independently sourced and Broadway dates stay untouched', () => {
  for (const source of ['human-correction', 'manual', 'theatremonkey', 'lortel', 'playbill+lortel', 'press-release']) {
    assert.equal(needsPressNightCrossCheck({ ...heart, openingDateSource: source }), false, source);
  }
  assert.equal(crossCheckOpeningDate({ ...ghost, category: 'broadway' }, { source: 'lortel', opening: '2026-10-14' }), null);
  assert.equal(crossCheckOpeningDate({ ...ghost, openingDate: null }, null), null);
});

test('every review-derived source remains eligible for independent confirmation', () => {
  for (const source of ['inferred-from-reviews', 'inferred-from-reviews-reverse', 'inferred-from-reviews-mode',
    'review-derived-press-night', 'review-open-signal', 'discovery-open-signal', 'aggregator-roundup', 'bww-roundup', 'wet-roundup', 'audit-review-evidence', 'guardian-review']) {
    assert.equal(needsPressNightCrossCheck({ ...heart, openingDateSource: source }), true, source);
  }
});

test('wrong-run bounds and invalid dates cannot silently replace an opening', () => {
  for (const opening of ['2026-10-02', '2026-12-13', '2027-10-14']) {
    assert.equal(crossCheckOpeningDate(ghost, { source: 'lortel', opening }).status, 'conflict');
  }
  for (const opening of ['2026-10', '2026-02-30', 'October 14', null]) {
    assert.equal(crossCheckOpeningDate(ghost, { source: 'lortel', opening }).status, 'unverified');
  }
  for (const firstPreview of ['2026-10-15', '2026-02-01', '2026-10']) {
    assert.equal(crossCheckOpeningDate(ghost, { source: 'lortel', opening: '2026-10-14', firstPreview }).status, 'conflict');
  }
});

test('missing press evidence preserves preview enrichment; independent corrections win over the merge', () => {
  const show = { ...ghost, previewsStartDate: null };
  const preview = { field: 'previewsStartDate', old: null, new: '2026-10-03' };
  const proposed = [preview, { field: 'openingDate', old: ghost.openingDate, new: '2026-10-10' },
    { field: 'openingDateSource', old: 'playbill', new: 'playbill-production-page' }];
  assert.deepEqual(mergePressNightChanges(show, proposed, crossCheckOpeningDate(show, null)), proposed);
  const check = crossCheckOpeningDate(show, { source: 'lortel', opening: '2026-10-14' });
  assert.deepEqual(mergePressNightChanges(show, proposed, check), [preview, ...check.changes]);
  assert.deepEqual(mergePressNightChanges(show, [{ ...preview, new: '2026-10-15' }], check), check.changes);
  const conflict = crossCheckOpeningDate(show, { source: 'lortel', opening: '2027-10-14' });
  assert.deepEqual(mergePressNightChanges(show, proposed, conflict), [preview]);
});

test('a merged listing with only a TM preview cannot stamp a Playbill opening as independently verified', () => {
  assert.equal(westEndOpeningSource({ source: 'both', pressNightEvidence: { opening: null }, opening: '2026-10-08' }), 'playbill');
  assert.equal(westEndOpeningSource({ source: 'both', pressNightEvidence: { opening: '2026-10-08' }, opening: '2026-10-08' }), 'theatremonkey');
  assert.equal(westEndOpeningSource({ source: 'playbill', opening: '2026-10-08' }), 'playbill');
});

test('old-run reviews and a republished 2025 review are caught by the real guards', () => {
  const show = { previewsStartDate: '2026-09-27', openingDate: '2026-10-04', category: 'off-broadway' };
  assert.equal(evaluateDateGuard({ pubDate: new Date('2026-02-15'), show }).flag, true);
  assert.equal(evaluateDateGuard({ pubDate: new Date('2026-10-04'), show }).flag, false);
  assert.equal(evaluateRepublishedReview({ fullText: 'This review is from 2025', show, publishDate: '2026-09-22' }).exclude, true);
});

test('owner-separated transfers do not inherit the earlier run', () => {
  const old = { id: 'old-run', openingDate: '2025-12-12', closingDate: '2026-01-25' };
  const transfer = { id: 'transfer', previewsStartDate: '2026-09-24', openingDate: '2026-10-07',
    priorRuns: [{ ...old, inheritReviews: false }] };
  const reviews = [{ showId: old.id, outletId: 'guardian', publishDate: '2025-12-12', url: 'https://example.org/review' }];
  assert.equal(inheritPriorRunReviews(reviews, [old, transfer]).inherited.length, 0);
});

test('earlier-run citations and venue listings are not actionable newsletter gaps', () => {
  const current = { url: 'https://www.thereviewshub.com/fences-lyric-hammersmith-london/' };
  assert.deepEqual(currentRunOnly([{ priorRun: true, url: 'https://example.org/old-review' }, current]), [current]);
  assert.equal(classifyGapCandidateUrl('https://www.show-score.com/west-end-shows/fences').ok, false);
  assert.equal(classifyGapCandidateUrl(current.url).ok, true);
});

test('a later production correction survives the actual write guard, including the stale clear note', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4998-clear-'));
  try {
    fs.mkdirSync(path.join(dir, 'fences'));
    const file = 'fences/british-theatre--critic.json';
    fs.writeFileSync(path.join(dir, file), JSON.stringify({
      showId: 'fences', outletId: 'british-theatre', criticName: 'Critic',
      wrongProductionOverride: true, wrongProductionManualClear: true,
      wrongProductionOverrideSetBy: 'clear-stale-wrong-production-flags.js',
      wrongProductionClearedNote: 'Earlier script clear',
    }));
    const result = executeReviewFieldEditIn(dir, {
      file, field: 'wrongProduction', oldValue: null, newValue: true,
    }, { fixId: 'bro-4998', at: '2026-10-30T00:00:00Z' });
    assert.equal(result.ok, true, result.reason);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, file)));
    assert.equal(saved.wrongProduction, true);
    assert.equal(saved.wrongProductionClearedNote, undefined);
    assert.equal(saved.wrongProductionManualClear, undefined);
    assert.equal(saved._previousWrongProductionClear.reason, 'Earlier script clear');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
