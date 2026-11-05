import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { selectLiveShows, artFilesToAudit, collapseRowsByShow, AUDITED_FORMATS, classifyResult, buildReport, buildLiveArtAlert } = require('./live-art-audit.js');

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

test('selectLiveShows keeps a live show that has only a poster (BRO-6995)', () => {
  const shows = [
    { id: 'p', status: 'open', images: { thumbnail: null, poster: '/images/shows/p/poster.jpg' } },
    { id: 'h', status: 'open', images: { hero: '/images/shows/h/hero.jpg' } },
  ];
  assert.deepEqual(selectLiveShows(shows).map(s => s.id), ['p']);
});

test('artFilesToAudit covers thumbnail and poster once per distinct path, never hero', () => {
  assert.deepEqual(AUDITED_FORMATS, ['thumbnail', 'poster']);
  const both = artFilesToAudit({ images: { thumbnail: '/t.jpg', poster: '/p.jpg', hero: '/h.jpg' } });
  assert.deepEqual(both, [{ format: 'thumbnail', path: '/t.jpg' }, { format: 'poster', path: '/p.jpg' }]);
  const same = artFilesToAudit({ images: { thumbnail: '/t.jpg', poster: '/t.jpg' } });
  assert.deepEqual(same, [{ format: 'thumbnail', path: '/t.jpg' }]);
  assert.deepEqual(artFilesToAudit({ images: {} }), []);
  assert.deepEqual(artFilesToAudit(null), []);
});

test('collapseRowsByShow gives one row per show and prefers a verdict over an error', () => {
  const rows = collapseRowsByShow([
    { id: 'a', format: 'thumbnail', kind: 'wrong_show', errored: false },
    { id: 'a', format: 'poster', kind: 'wrong_show', errored: false },
    { id: 'b', format: 'thumbnail', kind: 'error', errored: true },
    { id: 'b', format: 'poster', kind: 'wrong_show', errored: false },
    { id: 'c', format: 'poster', kind: 'error', errored: true },
  ]);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(r => r.id === 'a').formats, ['thumbnail', 'poster']);
  const b = rows.find(r => r.id === 'b');
  assert.equal(b.errored, false);
  assert.deepEqual(b.formats, ['poster']);
  assert.equal(rows.find(r => r.id === 'c').errored, true);
});

test('buildLiveArtAlert names the flagged formats', () => {
  const a = buildLiveArtAlert([{ id: 'r', title: 'Rope', kind: 'wrong_show', formats: ['poster'], description: 'Lost Boys' }]);
  assert.match(a.description, /\(r\) \[wrong_show\] \(poster\)/);
});

test('classifyResult ignores strictFieldsMissing: the sweep never asks for strict fields (BRO-6995)', () => {
  // What verifyImage returns for the sweep's non-strict call: no workConfirmed, strictFieldsMissing true.
  const base = { confidence: 'high', workConfirmed: false, strictFieldsMissing: true, productionMatch: 'unknown' };
  assert.deepEqual(classifyResult({ ...base, match: false, issues: ['wrong_show'], imageType: 'promotional_art' }), { kind: 'wrong_show', errored: false });
  assert.equal(classifyResult({ ...base, match: true, issues: [] }), null);
  // Real failures stay errors.
  assert.equal(classifyResult({ ...base, match: true, confidence: 'low', issues: ['download_error'] }).errored, true);
});
