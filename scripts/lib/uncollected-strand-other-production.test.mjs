// BRO-5077: prior-production URLs (rejected wrongProduction) must not look like a blackout.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { assessShow } = createRequire(import.meta.url)('./uncollected-strand.js');

const nowMs = Date.parse('2026-10-11T22:00:00Z');
const wp = (note, extra = {}) => ({ url: 'https://x.test/' + note.length, fullText: '', wrongProduction: true, wrongProductionNote: note, contentTier: 'invalid', ...extra });
const files = (...rs) => rs.map((review, i) => ({ file: `f${i}.json`, review }));

const tour = { id: 't', status: 'open', openingDate: '2024-10-12', market: 'tour', category: 'tour' };
const bway = { id: 'b', status: 'open', openingDate: '2024-10-12', market: 'broadway', category: 'play' };

test('tour: NYC-run URLs (dated before the tour, or verdict names the earlier run) are not a blackout', () => {
  const r = assessShow(tour, files(
    wp('anticipatory', { publishDate: '2023-10-17' }),
    wp('Collector LLM: wrong production (high) — This review evaluates the original Broadway production at DR2 Theatre in New York, not the national tour'),
  ), { nowMs });
  assert.equal(r.discovered, 0);
  assert.equal(r.totalBlackout, false);
});

// BRO-5115: ordinal dates ("October 17th, 2023") are NaN to Date.parse; toDateMs reads them.
test('tour: an ordinal-dated pre-tour URL is still recognized as the earlier run', () => {
  const r = assessShow(tour, files(wp('anticipatory', { publishDate: 'October 17th, 2023' })), { nowMs });
  assert.equal(r.discovered, 0);
  assert.equal(r.totalBlackout, false);
});

test('tour: bare LLM wrongProduction on local reviews still pages (and-juliet / mrs-doubtfire shape)', () => {
  const r = assessShow(tour, files(
    wp('Collector LLM: wrong production (high) — different cast', { publishDate: '2025-02-01' }),
    wp('Collector LLM: wrong production (high) — wrong venue', { publishDate: '2025-02-03' }),
  ), { nowMs });
  assert.equal(r.discovered, 2);
  assert.equal(r.totalBlackout, true);
});

test('non-tour: deterministic date-guard rejections are discounted', () => {
  const r = assessShow(bway, files(
    wp('Pre-opening guard: pre-window date — review dated 2023-10-16 is 60+ days before show starts 2024-10-12'),
    wp('Auto-flagged: URL date 2023-10-17 is 361 days before show earliest date 2024-10-12. Likely prior production.'),
  ), { nowMs });
  assert.equal(r.totalBlackout, false);
});

test('non-tour: LLM-only wrongProduction still counts (wrongly flagged real set must still page)', () => {
  const r = assessShow(bway, files(wp('Collector LLM: wrong production (high)'), wp('Collector LLM: wrong production (high) b')), { nowMs });
  assert.equal(r.discovered, 2);
  assert.equal(r.totalBlackout, true);
});

test('unflagged discovered URLs on a tour still count', () => {
  const r = assessShow(tour, files({ url: 'https://a.test', fullText: '' }, { url: 'https://b.test', fullText: '' }), { nowMs });
  assert.equal(r.totalBlackout, true);
});

test('staleBlackoutKeys: only open blackout keys for shows no longer in blackout', () => {
  const { staleBlackoutKeys } = createRequire(import.meta.url)('./uncollected-strand.js');
  const c = {
    'uncollected-blackout:a': { status: 'open' },
    'uncollected-blackout:b': { status: 'open' },
    'uncollected-blackout:c': { status: 'resolved' },
    'gap:x': { status: 'open' },
  };
  assert.deepEqual(staleBlackoutKeys(c, ['b']), ['uncollected-blackout:a']);
  assert.deepEqual(staleBlackoutKeys(null, []), []);
});
