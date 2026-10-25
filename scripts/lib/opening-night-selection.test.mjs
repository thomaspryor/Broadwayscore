import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { selectOpeningNightShows } = require('./opening-night-selection.js');
const { isTrustedPressNightSource } = require('./press-night-trust.js');

// The pre-extraction orchestrator inline predicate, verbatim (2026-07-24) —
// the parity fixture that locks the lib's DEFAULT behavior to the workflow's
// historical behavior. If the lib's defaults ever drift from this, the
// orchestrator's selection changed silently — exactly the bug class the
// extraction exists to prevent.
function legacyInlineSelect(shows, market, now) {
  const lookAhead = new Date(now.getTime() + 6 * 60 * 60 * 1000);
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - 21);
  cutoff.setHours(0, 0, 0, 0);
  return shows.filter(s => {
    const cat = s.category || 'broadway';
    const isColdOpenMarket = cat === 'off-broadway' || cat === 'off-west-end';
    const effectiveOpening = s.openingDate || (isColdOpenMarket ? s.previewsStartDate : null);
    if (!effectiveOpening) return false;
    const validStatus = s.status === 'open' || s.status === 'upcoming' ||
      (s.status === 'previews' && new Date(effectiveOpening) <= lookAhead);
    if (!validStatus) return false;
    if (market === 'broadway' && cat !== 'broadway' && cat !== 'off-broadway') return false;
    if (market === 'west-end' && cat !== 'west-end' && cat !== 'off-west-end') return false;
    if (cat === 'west-end' && !isTrustedPressNightSource(s.openingDateSource)
        && s.status !== 'open') {
      return false;
    }
    const d = new Date(effectiveOpening);
    d.setHours(0, 0, 0, 0);
    return d >= cutoff && d <= lookAhead;
  }).map(s => s.id);
}

const NOW = new Date('2026-07-24T04:00:00Z');
const day = offset => {
  const d = new Date(NOW); d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};

const FIXTURE = [
  { id: 'bw-open', category: 'broadway', status: 'open', openingDate: day(-2) },
  { id: 'bw-upcoming-tonight', category: 'broadway', status: 'upcoming', openingDate: day(0) },
  { id: 'bw-too-old', category: 'broadway', status: 'open', openingDate: day(-25) },
  { id: 'bw-too-far', category: 'broadway', status: 'upcoming', openingDate: day(3) },
  { id: 'bw-previews-past-open', category: 'broadway', status: 'previews', openingDate: day(-1) },
  { id: 'bw-previews-future-open', category: 'broadway', status: 'previews', openingDate: day(2) },
  { id: 'bw-no-date', category: 'broadway', status: 'open', openingDate: null },
  { id: 'ob-cold-open', category: 'off-broadway', status: 'open', openingDate: null, previewsStartDate: day(-3) },
  { id: 'we-trusted', category: 'west-end', status: 'upcoming', openingDate: day(0), openingDateSource: 'theatremonkey' },
  { id: 'we-untrusted-upcoming', category: 'west-end', status: 'upcoming', openingDate: day(0), openingDateSource: 'todaytix' },
  { id: 'we-untrusted-open', category: 'west-end', status: 'open', openingDate: day(-1), openingDateSource: 'todaytix' },
  { id: 'we-announced', category: 'west-end', status: 'announced', openingDate: day(-1), openingDateSource: 'theatremonkey' },
  { id: 'owe-cold-open', category: 'off-west-end', status: 'previews', openingDate: null, previewsStartDate: day(-1) },
  { id: 'no-category-defaults-broadway', status: 'open', openingDate: day(-5) },
];

test('parity: default options reproduce the legacy orchestrator inline predicate on every market', () => {
  for (const market of ['', 'broadway', 'west-end']) {
    const legacy = legacyInlineSelect(FIXTURE, market, NOW);
    const lib = selectOpeningNightShows(FIXTURE, { market, now: NOW }).map(s => s.id);
    assert.deepEqual(lib, legacy, `market='${market}'`);
  }
});

test('parity fixture exercises the interesting gates (sanity on the fixture itself)', () => {
  const all = selectOpeningNightShows(FIXTURE, { market: '', now: NOW }).map(s => s.id);
  assert.ok(all.includes('we-untrusted-open'), 'untrusted WE source polls once open');
  assert.ok(!all.includes('we-untrusted-upcoming'), 'untrusted WE source suppressed pre-open');
  assert.ok(!all.includes('we-announced'), 'announced status excluded by default');
  assert.ok(all.includes('ob-cold-open'), 'cold-open market falls back to previewsStartDate');
  assert.ok(!all.includes('bw-no-date'), 'press-night market requires openingDate');
  assert.ok(all.includes('bw-previews-past-open'), 'previews with passed opening date included');
  assert.ok(!all.includes('bw-previews-future-open'), 'previews with far-future opening excluded');
});

test('monitor options: includeUntrusted + ignoreStatus catch the orchestrator-skipped classes', () => {
  const monitor = selectOpeningNightShows(FIXTURE, {
    market: '', now: NOW, includeUntrusted: true, ignoreStatus: true,
  }).map(s => s.id);
  assert.ok(monitor.includes('we-untrusted-upcoming'), 'untrusted WE pre-open (A Life in Four Seasons class)');
  assert.ok(monitor.includes('we-announced'), 'stuck-announced (Sherlock Holmes class)');
  assert.ok(monitor.includes('bw-previews-future-open') === false, 'date window still applies');
});

test('market filter includes the off- sibling market', () => {
  const bw = selectOpeningNightShows(FIXTURE, { market: 'broadway', now: NOW }).map(s => s.id);
  assert.ok(bw.includes('ob-cold-open'));
  assert.ok(!bw.includes('we-trusted'));
});

// ── Sprint A (v2 reconciler plan): evidence-anchored selection arm ──
// Golden fixture: the Broad Strokes miss (2026-07-29). openingDate null +
// wrong stale previewsStartDate + status previews meant the show was NEVER
// selected while 11 reviews sat published. With roundup evidence, selection
// must fire; without it, the legacy gates still exclude it (parity).

test('evidence-anchored arm: Broad Strokes class selected WITH evidence, not without', () => {
  const broadStrokes = {
    id: 'cat-cohen-broad-strokes-off-broadway-2026',
    title: 'Cat Cohen: Broad Strokes',
    category: 'off-broadway',
    status: 'previews',
    openingDate: null,
    previewsStartDate: '2026-04-16', // wrong TodayTix stub date, outside lookback
  };
  const now = new Date('2026-07-29T12:00:00Z');
  const evidence = {
    'cat-cohen-broad-strokes-off-broadway-2026': {
      latest: '2026-07-28',
      items: [{ source: 'playbill-roundup', url: 'https://playbill.com/article/reviews-what-do-critics-think-of-cat-cohens-broad-strokes-off-broadway', date: '2026-07-28' }],
    },
  };

  // Without evidence: the historical blind spot (locks legacy behavior).
  assert.equal(selectOpeningNightShows([broadStrokes], { market: 'broadway', now }).length, 0);
  // With evidence: selected.
  assert.deepEqual(
    selectOpeningNightShows([broadStrokes], { market: 'broadway', now, evidence }).map(s => s.id),
    ['cat-cohen-broad-strokes-off-broadway-2026']
  );
  // Market filter still applies under the evidence arm.
  assert.equal(selectOpeningNightShows([broadStrokes], { market: 'west-end', now, evidence }).length, 0);
});

test('evidence-anchored arm: stale evidence and closed shows do not select', () => {
  const now = new Date('2026-07-29T12:00:00Z');
  const show = { id: 'old-show-2025', title: 'Old Show', category: 'off-broadway', status: 'previews', openingDate: null, previewsStartDate: null };
  const staleEvidence = { 'old-show-2025': { latest: '2026-05-01', items: [] } };
  assert.equal(selectOpeningNightShows([show], { market: 'broadway', now, evidence: staleEvidence }).length, 0, 'evidence outside lookback must not select');
  const closed = { ...show, status: 'closed' };
  const freshEvidence = { 'old-show-2025': { latest: '2026-07-28', items: [] } };
  assert.equal(selectOpeningNightShows([closed], { market: 'broadway', now, evidence: freshEvidence }).length, 0, 'closed shows stay excluded');
});
