/**
 * The website (src/lib/engine.ts) and the app feed (scripts/generate-mobile-data.js,
 * scripts/lib/mobile-critic-score.js) correct shows.json's status against the
 * market's date with one helper. On opening night shows.json can still say
 * "previews"; the site then shows the score, so the app feed must too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const { normalizeShowStatus, effectiveShowStatus, getMarketDate } = require('./effective-status.js');
const { buildMobileCriticScore } = require('./mobile-critic-score.js');

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = p => readFileSync(join(ROOT, p), 'utf8');

test('previews becomes open on the opening date, not before', () => {
  const show = { status: 'previews', openingDate: '2026-10-21', previewsStartDate: '2026-09-30' };
  assert.equal(effectiveShowStatus(show, '2026-10-20'), 'previews');
  assert.equal(effectiveShowStatus(show, '2026-10-21'), 'open');
  assert.equal(effectiveShowStatus(show, '2026-10-22'), 'open');
});

test('open becomes closed the day after the closing date', () => {
  const show = { status: 'open', openingDate: '2025-01-01', closingDate: '2026-10-20' };
  assert.equal(effectiveShowStatus(show, '2026-10-20'), 'open');
  assert.equal(effectiveShowStatus(show, '2026-10-21'), 'closed');
});

test('previews before the first preview is upcoming; normalizeShowStatus leaves it previews', () => {
  const show = { status: 'previews', openingDate: '2026-12-01', previewsStartDate: '2026-11-10' };
  assert.equal(effectiveShowStatus(show, '2026-10-21'), 'upcoming');
  assert.equal(normalizeShowStatus(show, '2026-10-21'), 'previews');
  assert.equal(effectiveShowStatus(show, '2026-11-10'), 'previews');
});

test('one step only: a previews show past both dates reads open, as engine.ts always did', () => {
  const show = { status: 'previews', openingDate: '2026-10-01', closingDate: '2026-10-10' };
  assert.equal(effectiveShowStatus(show, '2026-10-21'), 'open');
});

test('no dates, other statuses: unchanged', () => {
  assert.equal(effectiveShowStatus({ status: 'previews' }, '2026-10-21'), 'previews');
  assert.equal(effectiveShowStatus({ status: 'closed', closingDate: '2020-01-01' }, '2026-10-21'), 'closed');
  assert.equal(effectiveShowStatus({ status: 'announced', openingDate: '2026-01-01' }, '2026-10-21'), 'announced');
});

test('market date: 23:30 UTC is the next day in London, the same day in New York', () => {
  const now = new Date('2026-10-21T23:30:00Z');
  assert.equal(getMarketDate('west-end', now), '2026-10-22');
  assert.equal(getMarketDate('broadway', now), '2026-10-21');
  assert.equal(getMarketDate(undefined, now), '2026-10-21');
});

// Enough T1 reviews to clear the review-count gate in every market.
const OUTLETS = { nyt: { tier: 1 }, vulture: { tier: 1 }, variety: { tier: 1 }, guardian: { tier: 1 }, times: { tier: 1 }, telegraph: { tier: 1 } };
const reviews = Object.keys(OUTLETS).map((outletId, i) => ({ outletId, outlet: outletId, assignedScore: 80 + i, criticName: `Critic ${i}` }));

test('app feed show-page gate (cr.pq) opens on opening night while shows.json still says previews', () => {
  const now = Date.parse('2026-10-21T23:30:00Z'); // 7:30pm ET, 12:30am London
  const base = { id: 'fixture-show', type: 'musical', status: 'previews', previewsStartDate: '2026-09-30' };

  const bway = buildMobileCriticScore({ ...base, category: 'broadway', openingDate: '2026-10-21' }, reviews, OUTLETS, { now });
  assert.ok(bway, 'fixture reviews must score');
  assert.equal(bway.q, 1, 'fixture must clear the review-count gate');
  assert.equal(bway.pq, 1, 'Broadway opening night: website shows the score, so must the app');

  const notYet = buildMobileCriticScore({ ...base, category: 'broadway', openingDate: '2026-10-22' }, reviews, OUTLETS, { now });
  assert.equal(notYet.pq, 0, 'the night before opening stays TBD');

  // Same instant is already 2026-10-22 in London.
  const we = buildMobileCriticScore({ ...base, category: 'west-end', openingDate: '2026-10-22' }, reviews, OUTLETS, { now });
  assert.equal(we.pq, 1, 'West End uses the London date');
});

test('the website and the feed both use the helper (no local copy of the rule)', () => {
  const engine = read('src/lib/engine.ts');
  assert.match(engine, /const normalizedStatus = normalizeShowStatus\(show, today\)/);
  assert.match(engine, /status: effectiveShowStatus\(show, today\)/);
  assert.doesNotMatch(engine, /openingDate <= today/, 'engine.ts must not keep its own status rule');
  const gen = read('scripts/generate-mobile-data.js');
  assert.match(gen, /const status = effectiveShowStatus\(show\)/);
  assert.match(gen, /buildMobileCriticScore\(show, /, 'the builder corrects status itself; pass the raw entry (the rule is not idempotent)');
  assert.doesNotMatch(gen, /toISOString\(\)\.slice\(0, 10\)/, 'the feed must not use the UTC date for status');
  const lookup = read('scripts/generate-show-lookup.js');
  assert.match(lookup, /const status = effectiveShowStatus\(show\)/, 'My Shows and shared lists read show-lookup.json');
  assert.doesNotMatch(lookup, /entry\.st = show\.status|show\.status === 'upcoming'/, 'show-lookup must not use the raw status');
});

test('every place that hides a score for old shows also hides it for announced shows', () => {
  // engine.ts hides reviews of an announced show (they belong to a prior
  // production); a feed that skips this shows a score the website hides.
  const callers = execFileSync('git', ['grep', '-l', 'shouldHideReviews(show', '--', 'scripts', 'src'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(rel => rel && !/\.test\.|should-hide-reviews\.js$|config\/scoring\.ts$/.test(rel));
  assert.ok(callers.includes('scripts/generate-mobile-data.js'), `caller scan is broken: ${callers}`);
  for (const rel of callers) {
    assert.match(read(rel), /shouldHideReviews\(show\) \|\| show\.status === 'announced'/, rel);
  }
});
