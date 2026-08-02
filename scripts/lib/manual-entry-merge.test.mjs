/**
 * manual-entry-merge — regression cover for the phantom-duplicate class.
 *
 * Both "live" cases below were real double-counted reviews in reviews.json on
 * 2026-08-02, surfaced by owner feedback on Wonder (Regional). The old matcher
 * lowercased the byline and nothing else, so any byline drift appended a second
 * copy of the same article that no dedup pass could ever collapse.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { criticKey, findPipelineTwin, mergeManualEntries } = require('./manual-entry-merge.js');

// Mirrors normalizeUrlForDedup in rebuild-all-reviews.js closely enough for matching.
const normalizeUrl = (u) =>
  !u ? null : u.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '').toLowerCase();

const BWW_URL =
  'https://www.broadwayworld.com/boston/article/Review-American-Repertory-Theaters-World-Premiere-is-a-Musical-WONDER-20251231';

test('criticKey folds punctuation so byline drift still matches', () => {
  assert.equal(criticKey('R. Scott Reedy'), criticKey('R Scott Reedy'));
  assert.equal(criticKey("Kelly O'Hara"), criticKey('Kelly OHara'));
  assert.equal(criticKey('Renée Fleming'), criticKey('Renee Fleming'));
  assert.equal(criticKey('  Chris   Jones '), 'chris jones');
  assert.equal(criticKey(null), 'unknown');
});

test('criticKey does NOT collapse genuinely different critics', () => {
  assert.notEqual(criticKey('Chris Jones'), criticKey('Christopher Borrelli'));
  assert.notEqual(criticKey('Ben Brantley'), criticKey('Jesse Green'));
});

test('LIVE CASE wonder-regional-2026: punctuation drift replaces, never appends', () => {
  const reviews = [
    { showId: 'wonder-regional-2026', outletId: 'broadwayworld', criticName: 'R Scott Reedy',
      assignedScore: 82, scoreSource: 'llmScore', url: BWW_URL },
    { showId: 'wonder-regional-2026', outletId: 'wbur', criticName: 'Unknown',
      assignedScore: 85, scoreSource: 'llmScore', url: 'https://www.wbur.org/x' },
  ];
  const manual = [
    { showId: 'wonder-regional-2026', outletId: 'broadwayworld', criticName: 'R. Scott Reedy',
      assignedScore: 82, scoreSource: 'human-review', manualEntry: true, url: BWW_URL },
  ];

  const res = mergeManualEntries(reviews, manual, normalizeUrl);

  assert.equal(reviews.length, 2, 'must stay 2 reviews — the manual entry replaces, not appends');
  const bww = reviews.filter(r => r.outletId === 'broadwayworld');
  assert.equal(bww.length, 1, 'exactly one BroadwayWorld review');
  assert.equal(bww[0].manualEntry, true, 'the human entry won');
  assert.equal(res.appended, 0);
});

test('LIVE CASE iceboy-regional-2026: byline disagreement falls back to URL', () => {
  const url = 'https://www.chicagotribune.com/2026/01/iceboy-review';
  const reviews = [
    { showId: 'iceboy-regional-2026', outletId: 'chicagotribune', criticName: 'Christopher Borrelli',
      assignedScore: 70, scoreSource: 'llmScore', url },
  ];
  const manual = [
    { showId: 'iceboy-regional-2026', outletId: 'chicagotribune', criticName: 'Chris Jones',
      assignedScore: 90, scoreSource: 'human-review', manualEntry: true, url },
  ];

  const res = mergeManualEntries(reviews, manual, normalizeUrl);

  assert.equal(reviews.length, 1, 'same article + same outlet = one review regardless of byline');
  assert.equal(reviews[0].criticName, 'Chris Jones');
  assert.equal(res.matchedByUrl, 1, 'reported as a URL-matched merge, not a silent append');
});

test('a genuinely pipeline-less manual review is still appended', () => {
  const reviews = [
    { showId: 's', outletId: 'a', criticName: 'A Critic', assignedScore: 50, url: 'https://a.com/1' },
  ];
  const manual = [
    { showId: 's', outletId: 'b', criticName: 'B Critic', assignedScore: 80,
      manualEntry: true, url: 'https://b.com/1' },
  ];

  const res = mergeManualEntries(reviews, manual, normalizeUrl);

  assert.equal(reviews.length, 2, 'a real new outlet must survive');
  assert.equal(res.appended, 1);
});

test('pipeline scoreSource=human-review is authoritative — manual entry skipped', () => {
  const reviews = [
    { showId: 's', outletId: 'a', criticName: 'A Critic', assignedScore: 77,
      scoreSource: 'human-review', url: 'https://a.com/1' },
  ];
  const manual = [
    { showId: 's', outletId: 'a', criticName: 'A. Critic', assignedScore: 50,
      manualEntry: true, url: 'https://a.com/1' },
  ];

  const res = mergeManualEntries(reviews, manual, normalizeUrl);

  assert.equal(reviews.length, 1);
  assert.equal(reviews[0].assignedScore, 77, 'pipeline-processed source file wins');
  assert.equal(res.preserved, 0);
});

test('multi-critic outlet: manual entry replaces only its own critic', () => {
  const reviews = [
    { showId: 's', outletId: 'nysr', criticName: 'Bob Verini', assignedScore: 40,
      scoreSource: 'llmScore', url: 'https://nysr.com/verini' },
    { showId: 's', outletId: 'nysr', criticName: 'David Finkle', assignedScore: 60,
      scoreSource: 'llmScore', url: 'https://nysr.com/finkle' },
  ];
  const manual = [
    { showId: 's', outletId: 'nysr', criticName: 'Bob Verini', assignedScore: 35,
      manualEntry: true, url: 'https://nysr.com/verini' },
  ];

  mergeManualEntries(reviews, manual, normalizeUrl);

  assert.equal(reviews.length, 2, 'the other NYSR critic is untouched');
  assert.equal(reviews.find(r => r.criticName === 'Bob Verini').assignedScore, 35);
  assert.equal(reviews.find(r => r.criticName === 'David Finkle').assignedScore, 60);
});

test('no URL on either side cannot fabricate a match', () => {
  const reviews = [
    { showId: 's', outletId: 'a', criticName: 'Someone Else', assignedScore: 50 },
  ];
  const manual = [
    { showId: 's', outletId: 'a', criticName: 'Different Person', assignedScore: 80, manualEntry: true },
  ];

  assert.equal(findPipelineTwin(manual[0], reviews, normalizeUrl), null);
});
