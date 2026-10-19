import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { currentRunUncollected } = require('./audit-show-review-gap');
const { classifyGapCandidateUrl } = require('./non-review-url-patterns');
const { syndicatedReprintOf } = require('./syndicated-reprint-match');
const { gapDisclosureDecisions } = require('./newsletter-preflight');

const URL = 'https://www.theguardian.com/stage/2026/oct/05/de-profundis-review-oscar-wilde-coronet-theatre-london';
const row = (result) => ({ showId: 'rose-kingston', missing: [{ url: URL }], ingestResults: [result] });

test('a confirmed reroute is resolved for its source show even if the destination merge fails', () => {
  const result = { url: URL, ok: false, reason: '⚠️  Cross-market reroute: rose-kingston → southwark (same-title-sibling: publish-date)\n❌ Stale merge: fullText still holds a pre-existing value' };
  assert.equal(currentRunUncollected(row(result)), 0);
  assert.equal(currentRunUncollected({ ...row(result), showId: 'southwark' }), 1);
});

test('truncated, same-show and unconfirmed reroutes stay visible', () => {
  for (const reason of [
    'Cross-market reroute: rose-kingston',
    'Cross-market reroute: rose-kingston → rose-kingston (unchanged)',
    'Cross-market reroute failed: no sibling found',
  ]) assert.equal(currentRunUncollected(row({ url: URL, reason })), 1, reason);
});

test('legacy permanent reasons resolve without an expected flag', () => {
  for (const reason of [
    'Skipped: timeout-listing-capsule: not a full review',
    'timeout-listing-capsule',
    'unknown-outlet-aggregator-host (theatre.reviews)',
    'syndicated-reprint',
  ]) assert.equal(currentRunUncollected(row({ url: URL, ok: false, reason })), 0, reason);
});

test('structured expected reasons resolve and conflicts or unknown failures remain gaps', () => {
  assert.equal(currentRunUncollected(row({ url: URL, expectedReason: 'timeout-listing-capsule' })), 0);
  assert.equal(currentRunUncollected(row({ url: URL, expected: true })), 0);
  assert.equal(currentRunUncollected(row({ url: URL, ok: true })), 0);
  for (const result of [
    { reason: 'Fetch failed: All scraping methods failed' },
    { reason: 'some-future-reason', unclassified: true },
    { reason: 'unknown-outlet-no-host' },
    { conflict: true, conflictReason: 'cross-show-url-owned' },
    { conflict: true, conflictReason: 'aggregator-url-mismatch' },
  ]) assert.equal(currentRunUncollected(row({ url: URL, ...result })), 1);
});

test('the result must belong to the missing URL', () => {
  assert.equal(currentRunUncollected(row({ url: 'https://other.example/review', expected: true })), 1);
});

test('newsletter banner uses the filtered checkpoint count and preserves real gaps', () => {
  const now = Date.parse('2026-10-19T12:00:00Z');
  const source = row({ url: URL, reason: 'Cross-market reroute: rose-kingston → southwark (publish-date)' });
  const opening = { id: source.showId, title: 'Jane Eyre' };
  const checkpoint = r => ({ [opening.id]: { at: new Date(now).toISOString(), uncollected: currentRunUncollected(r) } });
  assert.deepEqual(gapDisclosureDecisions([opening], checkpoint(source), now).gapped, []);
  const stillMissing = { ...source, missing: [...source.missing, { url: 'https://real.example/review' }] };
  const disclosure = gapDisclosureDecisions([opening], checkpoint(stillMissing), now);
  assert.equal(disclosure.gapped[0].uncollected, 1);
  assert.match(disclosure.notes[0], /missing 1 review/);
});

test('listing and production sites are filtered while editorial reviews remain candidates', () => {
  for (const url of [
    'https://shouldgoto.com/theatre/berliner-ensemble-de-profundis-by-oscar-wilde',
    'https://www.berliner-ensemble.de/en/production/de-profundis',
    'https://theatre.reviews/reviews-roundup/whos-afraid-of-virginia-woolf-sohoplace-reviews/',
  ]) {
    assert.equal(classifyGapCandidateUrl(url).ok, false, url);
    assert.equal(currentRunUncollected({ missing: [{ url }] }), 0, url);
  }
  for (const url of [URL, 'https://www.londonboxoffice.co.uk/news/post/jane-eyre-review']) {
    assert.equal(classifyGapCandidateUrl(url).ok, true, url);
    assert.equal(currentRunUncollected({ missing: [{ url }] }), 1, url);
  }
});

test('prior-run citations stay report-only and current citations without URLs stay gaps', () => {
  assert.equal(currentRunUncollected({
    missing: [{ url: URL, priorRun: true }, { url: 'https://timeout.com/newyork/theater/the-ask', priorRun: true }],
    citedNoUrl: [{ outlet: 'exeunt', priorRun: true }, { outlet: 'collectable' }],
  }), 1);
});

test('census holds, blocklists and successful ingests share the same count', () => {
  const r = {
    missing: [
      { url: URL, serpCensus: true }, { url: 'https://real.example/review' },
      { url: 'https://blocked.example/review' }, { url: 'https://held.example/review' },
    ],
    weIngestBlocked: [{ url: URL, reason: 'we-gate-off', censusGateOn: false }],
    ingestResults: [{ url: 'https://held.example/review', ok: true }],
  };
  const options = { isCollectable: m => !m.url.includes('blocked.example') };
  assert.equal(currentRunUncollected(r, options), 1);
  assert.equal(currentRunUncollected({ ...r, weIngestBlocked: [] }, options), 2);
  assert.equal(currentRunUncollected({ ...r, weIngestBlocked: [] }, { ...options, ignoreCensusTagged: true }), 1);
});

test('syndicated headline identity tolerates a moved Review label but requires held evidence', () => {
  const candidateUrl = 'https://www.aol.co.uk/articles/profundis-review-oscar-wilde-brought-122622000.html';
  const guardian = { url: URL, fullText: 'Review De Profundis: Oscar Wilde brought to life in a mesmerising performance' };
  const heldFiles = [guardian, ...Array.from({ length: 5 }, (_, i) => ({
    url: `https://outlet${i}.example/review`, fullText: 'De Profundis by Oscar Wilde at the Coronet Theatre. Another interpretation.',
  }))];
  const match = syndicatedReprintOf({ candidateUrl, heldFiles, showTitle: 'De Profundis' });
  assert.equal(match.dup, true);
  assert.equal(match.matchedUrl, URL);
  assert.equal(syndicatedReprintOf({ candidateUrl, heldFiles: heldFiles.slice(1), showTitle: 'De Profundis' }).dup, false);
  assert.equal(syndicatedReprintOf({ candidateUrl, heldFiles: [guardian], showTitle: 'De Profundis' }).dup, false);
  const reordered = { ...guardian, fullText: 'Review De Profundis Oscar Wilde. A different critic brought fresh ideas.' };
  assert.equal(syndicatedReprintOf({ candidateUrl, heldFiles: [reordered, ...heldFiles.slice(1)], showTitle: 'De Profundis' }).dup, false);
  // A second matching headline makes the relaxed match ambiguous.
  assert.equal(syndicatedReprintOf({ candidateUrl, heldFiles: [...heldFiles, { ...guardian, url: 'https://other.example/review' }], showTitle: 'De Profundis' }).dup, false);
});
