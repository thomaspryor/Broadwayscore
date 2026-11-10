// BRO-7291 class 7 (coverage gaps): the dual-model coverage check feeds the ingest queue instead of a list.
// Replays the BRO-7256 DC/LA coverage run: shapes and hosts are the real ones the models returned.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('./city-hub-coverage.js');
const { resolveOutletFromUrl } = require('./review-normalization.js');

const shows = [
  { id: 'the-score-regional-2026', openingDate: '2026-09-12' },
  { id: 'what-became-of-us-regional-2026', openingDate: '2026-09-20' },
];
const have = new Map([['the-score-regional-2026', { urls: new Set(), hosts: new Set(['dcmetrotheaterarts.com']) }]]);
const cov = new Map([
  ['the-score-regional-2026', {
    gemini: { reviews: [
      { url: 'https://www.washingtonpost.com/theater-dance/2026/09/15/the-score-review/', outlet: 'The Washington Post', date: '2026-09-15' },
      { url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/AbC', outlet: 'DC Theater Arts' },
      { url: 'https://dcmetrotheaterarts.com/2026/09/14/the-score/', outlet: 'DC Metro Theater Arts' },
      { url: 'https://www.washingtonpost.com/theater-dance/2026/05/01/season-announcement/', outlet: 'The Washington Post', date: '2026-05-01' },
    ] },
    openai: { reviews: [
      { url: 'https://www.washingtonpost.com/theater-dance/2026/09/15/the-score-review/', outlet: 'Washington Post' },
      { url: 'https://www.washington-unbound.com/bookreviews/the-score', outlet: 'Washington Unbound' },
      { url: 'not a url', outlet: 'x' },
    ] },
  }],
  ['what-became-of-us-regional-2026', { openai: { reviews: [{ url: 'https://dcdigest.com/what-became-of-us-signature-theatre-review/', outlet: 'DC Digest' }] } }],
]);

test('gaps: skips hosts we have, pre-run dates and non-URLs; merges the two models', () => {
  const gaps = C.coverageGaps(shows, cov, have);
  const urls = gaps.map((g) => g.url);
  assert.ok(!urls.some((u) => u.includes('dcmetrotheaterarts')), 'host already listed');
  assert.ok(!urls.some((u) => u.includes('season-announcement')), 'dated 4 months before opening');
  assert.ok(!urls.includes('not a url'));
  const wp = gaps.find((g) => g.url.includes('the-score-review'));
  assert.deepEqual(wp.models.sort(), ['gemini', 'openai']);
});

test('plan: a registered outlet becomes a dispatch-ingest-batch row; unknown host becomes a candidate; redirects never planned', () => {
  const r = C.ingestPlan(C.coverageGaps(shows, cov, have), resolveOutletFromUrl);
  assert.deepEqual(r.plan['the-score-regional-2026'], [{ url: 'https://www.washingtonpost.com/theater-dance/2026/09/15/the-score-review/', outlet: 'washpost' }]);
  assert.equal(r.redirects, 1);
  assert.ok(r.registryCandidates['washington-unbound.com']);
  assert.ok(r.registryCandidates['dcdigest.com']);
});

test('dead links (404/410) are dropped; bot walls and no-answer are kept (real run: dcdigest 404, moderatelymoco 406)', () => {
  const status = new Map([
    ['https://dcdigest.com/what-became-of-us-signature-theatre-review/', 404],
    ['https://www.washington-unbound.com/bookreviews/the-score', 406],
    ['https://www.washingtonpost.com/theater-dance/2026/09/15/the-score-review/', 0],
  ]);
  const r = C.ingestPlan(C.coverageGaps(shows, cov, have), resolveOutletFromUrl, { status });
  assert.equal(r.dead, 1);
  assert.equal(r.registryCandidates['dcdigest.com'], undefined);
  assert.ok(r.registryCandidates['washington-unbound.com']);
  assert.equal(r.plan['the-score-regional-2026'].length, 1);
});

test('perShow caps the plan', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ showId: 's', url: `https://www.washingtonpost.com/a/${i}` }));
  assert.equal(C.ingestPlan(many, resolveOutletFromUrl, { perShow: 6 }).plan.s.length, 6);
});

test('outlets added for this card resolve (angelestage substack link was the live one)', () => {
  assert.equal(resolveOutletFromUrl('https://angelestage.substack.com/p/local-local-local').outletId, 'angeles-stage');
  assert.equal(resolveOutletFromUrl('https://laist.com/news/arts-and-culture/x').outletId, 'laist');
  assert.equal(resolveOutletFromUrl('https://www.baltimorebanner.com/culture/arts/x').outletId, 'baltimore-banner');
});

test('outletHint lists the hub outlets by review count (replaces the hand list only two hubs had)', () => {
  const rows = [{ outlet: 'DC Theater Arts' }, { outlet: 'DC Theater Arts' }, { outlet: 'DC Theater Arts' }, { outlet: 'The Washington Post' }, { outlet: 'The Washington Post' }, { outletId: 'mdtheatreguide' }];
  assert.equal(C.outletHint(rows, 2), 'DC Theater Arts, The Washington Post');
});

test('replay los-angeles-ca: a TheatreInLA production listing is a roundup, never planned for ingest', () => {
  const gaps = [{ showId: 'dupin', url: 'https://www.theatreinla.com/the-case-book-of-c-auguste-dupin/11417/' }, { showId: 'dupin', url: 'https://www.washingtonpost.com/a/1' }];
  const r = C.ingestPlan(gaps, resolveOutletFromUrl);
  assert.equal(r.roundups, 1);
  assert.deepEqual(r.plan.dupin.map((x) => x.url), ['https://www.washingtonpost.com/a/1']);
});
