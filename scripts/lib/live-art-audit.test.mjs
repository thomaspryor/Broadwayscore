import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectLiveShows, classifyResult, buildReport, buildLiveArtAlert } =require('./live-art-audit.js');

test('selectLiveShows keeps live statuses with a thumbnail only', () => {
  const shows = [
    { id: 'a', status: 'open', images: { thumbnail: '/images/shows/a/thumbnail.webp' } },
    { id: 'b', status: 'closed', images: { thumbnail: '/x.webp' } },
    { id: 'c', status: 'previews', images: {} },
    { id: 'd', status: 'announced', images: { thumbnail: '/images/shows/d/thumbnail.webp' } },
  ];
  assert.deepEqual(selectLiveShows(shows).map(s => s.id), ['a', 'd']);
  assert.deepEqual(selectLiveShows(shows, { showId: 'd' }).map(s => s.id), ['d']);
});

test('classifyResult flags wrong-work art and ignores press stills / low confidence', () => {
  assert.equal(classifyResult({ match: true, confidence: 'high', issues: [] }), null);
  assert.deepEqual(classifyResult({ match: false, confidence: 'high', issues: ['wrong_show'], imageType: 'other' }), { kind: 'wrong_show', errored: false });
  assert.equal(classifyResult({ match: false, confidence: 'medium', issues: ['non_theatre_work'], imageType: 'other' }).kind, 'non_theatre_work');
  assert.equal(classifyResult({ match: false, confidence: 'high', issues: ['production_photo'], imageType: 'production_still' }), null);
  // A press still of ANOTHER show is still wrong-work art.
  assert.equal(classifyResult({ match: false, confidence: 'high', issues: ['wrong_show'], imageType: 'headshot_cast' }).kind, 'wrong_show');
  assert.equal(classifyResult({ match: false, confidence: 'low', issues: ['wrong_show'], imageType: 'other' }), null);
  assert.equal(classifyResult({ match: false, confidence: 'high', issues: ['closing_ad'], imageType: 'other' }), null);
});

test('classifyResult reports verifier errors as errored, never as wrong art', () => {
  assert.deepEqual(classifyResult({ match: true, confidence: 'low', issues: ['api_error'] }), { kind: 'error', errored: true });
  assert.equal(classifyResult({ skipped: true, match: true }).errored, true);
  assert.equal(classifyResult({ match: null, confidence: 'error', issues: [] }).errored, true);
});

test('buildReport separates flagged rows from errors and counts kinds', () => {
  const rep = buildReport([
    { id: 'a', title: 'A', kind: 'wrong_show', errored: false },
    { id: 'b', title: 'B', kind: 'wrong_show', errored: false },
    { id: 'c', title: 'C', kind: 'error', errored: true, description: 'x' },
  ], { totalChecked: 10, generatedAt: 'T' });
  assert.equal(rep.flaggedCount, 2);
  assert.equal(rep.errorCount, 1);
  assert.deepEqual(rep.byKind, { wrong_show: 2 });
  assert.equal(rep.advisory, true);
});

test('buildLiveArtAlert is null with no rows and one stable-key rollup otherwise', () => {
  assert.equal(buildLiveArtAlert([]), null);
  const a = buildLiveArtAlert([{ id: 'a', title: 'A', kind: 'wrong_show', description: 'ring' }]);
  assert.equal(a.conditionKey, 'live-show-art:wrong-work');
  assert.equal(a.disposition, 'auto');
  assert.match(a.description, /\(a\) \[wrong_show\]/);
});
