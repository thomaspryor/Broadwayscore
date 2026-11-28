// Null-URL aggregator-relay guard (2026 data audit S6-T1, BRO-4204).
//
// Dual-market outlets (Variety, FT, The Times, Guardian, Daily Mail, The
// Stage …) are exempt from both region-based cross-market guards, and every
// URL-based guard is a no-op on a file with no URL — which is exactly what a
// Theatre Record relay is. Nine 2026-04 West End "Romeo and Juliet" relays
// (Marmion, Hemming, Saville, Davis …) were rerouted onto
// romeo-and-juliet-off-broadway-2026 (the Delacorte production) and scored it.
//
// The rebuild now builds a (normalized title → market → critic) publishDate
// index in its pre-pass and asks cross-market-guard.js's pure classifier
// whether a URL-less relay on a dual-market outlet is the same critic's
// review of the same-title production in the OTHER market. The symmetry
// breaker is the run window: only the copy whose own show window EXCLUDES
// the date (while the sibling's includes it) is the relay — otherwise the
// legitimate West End side of every pair would be flagged too (23 of them on
// the 2026-09-28 corpus).
//
// Per CLAUDE.md §15 this requires the REAL functions, never a copy, and then
// asserts the rebuild is actually wired to them.
//
// Run: node --test tests/unit/cross-market-null-url.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.join(import.meta.dirname, '..', '..');
const {
  classifyDualMarketNullUrl,
  buildCrossMarketCriticIndex,
  findSiblingInOtherMarket,
  isAggregatorRelaySource,
  relayRunWindowContains,
  crossMarketOfCategory,
  RELAY_SIBLING_TOLERANCE_DAYS,
} = require(path.join(ROOT, 'scripts/lib/cross-market-guard.js'));
const { isAggregatorReviewSource } = require(path.join(ROOT, 'scripts/lib/aggregator-domains.js'));
const { parseDate } = require(path.join(ROOT, 'scripts/lib/date-utils.js'));

// shows.json snapshot, 2026-09-28.
const RJ_NYC = {
  id: 'romeo-and-juliet-off-broadway-2026', title: 'Romeo and Juliet', category: 'off-broadway',
  previewsStartDate: '2026-05-22', openingDate: '2026-06-11', closingDate: '2026-06-28', status: 'closed',
};
const RJ_WE = {
  id: 'romeo-and-juliet-west-end-2026', title: 'Romeo and Juliet', category: 'west-end',
  previewsStartDate: '2026-03-16', openingDate: '2026-03-31', closingDate: '2026-06-20', status: 'closed',
};
const PLAYBOY_WE = {
  id: 'the-playboy-of-the-western-world-west-end-2025', title: 'The Playboy of the Western World', category: 'west-end',
  previewsStartDate: '2025-12-04', openingDate: '2025-12-11', closingDate: '2026-02-28', status: 'closed',
};
const PLAYBOY_NYC_1971 = {
  id: 'the-playboy-of-the-western-world-1971', title: 'The Playboy of the Western World', category: 'broadway',
  previewsStartDate: '1970-12-26', openingDate: '1971-01-07', closingDate: '1971-02-20', status: 'closed',
};
const NOW = Date.parse('2026-09-28T00:00:00Z');
const OPTS = { parseDate, nowMs: NOW };

const RJ_ENTRIES = [
  // The relay (NYC folder) and the real review (WE folder), same critic, same date.
  { showId: RJ_NYC.id, file: 'daily-mail--patrick-marmion.json', criticName: 'Patrick Marmion', publishDate: '2026-04-03', show: RJ_NYC },
  { showId: RJ_WE.id, file: 'daily-mail--patrick-marmion.json', criticName: 'Patrick Marmion', publishDate: '2026-04-03', show: RJ_WE },
  // Two days apart (Theatre Record's date vs the outlet's own).
  { showId: RJ_NYC.id, file: 'thestage--sam-marlowe.json', criticName: 'Sam Marlowe', publishDate: '2026-04-01', show: RJ_NYC },
  { showId: RJ_WE.id, file: 'thestage--sam-marlowe.json', criticName: 'Sam Marlowe', publishDate: '2026-04-03', show: RJ_WE },
  // A genuine in-window NYC review by a critic who also reviewed the WE run months earlier.
  { showId: RJ_NYC.id, file: 'variety--ellise-shafer.json', criticName: 'Ellise Shafer', publishDate: '2026-06-11', show: RJ_NYC },
  { showId: RJ_WE.id, file: 'variety--ellise-shafer.json', criticName: 'Ellise Shafer', publishDate: '2026-04-01', show: RJ_WE },
];
const INDEX = buildCrossMarketCriticIndex(RJ_ENTRIES, parseDate);

const marmionRelay = { show: RJ_NYC, criticName: 'Patrick Marmion', publishDate: '2026-04-03' };

test('the R&J shape: theatre-record relay, no URL, same critic same date on the West End sibling → flagged', () => {
  const sibling = findSiblingInOtherMarket(INDEX, marmionRelay, OPTS);
  assert.ok(sibling, 'sibling found');
  assert.equal(sibling.showId, RJ_WE.id);
  assert.equal(sibling.file, 'daily-mail--patrick-marmion.json');
  assert.equal(sibling.diffDays, 0);
  const v = classifyDualMarketNullUrl({ hasUrl: false, outletIsDualMarket: true, siblingInOtherMarket: sibling, source: 'theatre-record' });
  assert.equal(v.shouldFlag, true);
  assert.match(v.reason, /theatre-record/);
  assert.match(v.reason, new RegExp(RJ_WE.id));
});

test('the same file with a variety.com URL is not flagged by this rule (the URL guards apply)', () => {
  const sibling = findSiblingInOtherMarket(INDEX, marmionRelay, OPTS);
  const v = classifyDualMarketNullUrl({ hasUrl: true, outletIsDualMarket: true, siblingInOtherMarket: sibling, source: 'theatre-record' });
  assert.equal(v.shouldFlag, false);
  assert.match(v.reason, /has-url/);
});

test('a NYC-only outlet is not applicable (the region guards handle non-dual-market outlets)', () => {
  const sibling = findSiblingInOtherMarket(INDEX, marmionRelay, OPTS);
  const v = classifyDualMarketNullUrl({ hasUrl: false, outletIsDualMarket: false, siblingInOtherMarket: sibling, source: 'theatre-record' });
  assert.equal(v.shouldFlag, false);
  assert.match(v.reason, /not-dual-market/);
});

test('a non-relay source (manual / RSS / submit form) is not applicable', () => {
  const sibling = findSiblingInOtherMarket(INDEX, marmionRelay, OPTS);
  for (const source of ['rss-discovery', 'manual-entry', 'submit-review-form', undefined, null]) {
    const v = classifyDualMarketNullUrl({ hasUrl: false, outletIsDualMarket: true, siblingInOtherMarket: sibling, source });
    assert.equal(v.shouldFlag, false, `source ${source}`);
    assert.match(v.reason, /not-an-aggregator-relay/);
  }
});

test('no sibling → not flagged', () => {
  const v = classifyDualMarketNullUrl({ hasUrl: false, outletIsDualMarket: true, siblingInOtherMarket: null, source: 'theatre-record' });
  assert.equal(v.shouldFlag, false);
  assert.match(v.reason, /no-cross-market-sibling/);
});

test('the legitimate West End side of the pair is never a sibling match (its own run window contains the date)', () => {
  assert.equal(findSiblingInOtherMarket(INDEX, { show: RJ_WE, criticName: 'Patrick Marmion', publishDate: '2026-04-03' }, OPTS), null);
  assert.equal(findSiblingInOtherMarket(INDEX, { show: RJ_WE, criticName: 'Sam Marlowe', publishDate: '2026-04-03' }, OPTS), null);
  // the-playboy-of-the-western-world: the real WE review vs the 1971 NYC folder's relay copy.
  const idx = buildCrossMarketCriticIndex([
    { showId: PLAYBOY_WE.id, file: 'daily-mail--robert-gore-langton.json', criticName: 'Robert Gore-Langton', publishDate: '2025-12-28', show: PLAYBOY_WE },
    { showId: PLAYBOY_NYC_1971.id, file: 'daily-mail--robert-gore-langton.json', criticName: 'Robert Gore-Langton', publishDate: '2025-12-28', show: PLAYBOY_NYC_1971 },
  ], parseDate);
  assert.equal(findSiblingInOtherMarket(idx, { show: PLAYBOY_WE, criticName: 'Robert Gore-Langton', publishDate: '2025-12-28' }, OPTS), null, 'real WE review kept');
  const relay = findSiblingInOtherMarket(idx, { show: PLAYBOY_NYC_1971, criticName: 'Robert Gore-Langton', publishDate: '2025-12-28' }, OPTS);
  assert.equal(relay && relay.showId, PLAYBOY_WE.id, '1971 folder copy is the relay');
});

test('a genuine in-window NYC review by a critic who also covered the WE run is not a relay', () => {
  assert.equal(findSiblingInOtherMarket(INDEX, { show: RJ_NYC, criticName: 'Ellise Shafer', publishDate: '2026-06-11' }, OPTS), null);
});

test(`sibling tolerance is ±${RELAY_SIBLING_TOLERANCE_DAYS} days: two days apart matches, ten does not`, () => {
  const two = findSiblingInOtherMarket(INDEX, { show: RJ_NYC, criticName: 'Sam Marlowe', publishDate: '2026-04-01' }, OPTS);
  assert.equal(two && two.showId, RJ_WE.id);
  assert.equal(two.diffDays, 2);
  const ten = findSiblingInOtherMarket(INDEX, { show: RJ_NYC, criticName: 'Sam Marlowe', publishDate: '2026-04-13' }, OPTS);
  assert.equal(ten, null);
});

test('critic must match; unknown / unnamed critics never match', () => {
  assert.equal(findSiblingInOtherMarket(INDEX, { show: RJ_NYC, criticName: 'Someone Else', publishDate: '2026-04-03' }, OPTS), null);
  assert.equal(findSiblingInOtherMarket(INDEX, { show: RJ_NYC, criticName: 'Unknown', publishDate: '2026-04-03' }, OPTS), null);
  assert.equal(findSiblingInOtherMarket(INDEX, { show: RJ_NYC, criticName: null, publishDate: '2026-04-03' }, OPTS), null);
});

test('an unknown run window is never read as "outside" (dateless show, unparseable date)', () => {
  assert.equal(relayRunWindowContains({ title: 'X' }, Date.parse('2026-04-03'), NOW), null);
  assert.equal(findSiblingInOtherMarket(INDEX, { show: { ...RJ_NYC, previewsStartDate: null, openingDate: null, closingDate: null }, criticName: 'Patrick Marmion', publishDate: '2026-04-03' }, OPTS), null);
  assert.equal(findSiblingInOtherMarket(INDEX, { show: RJ_NYC, criticName: 'Patrick Marmion', publishDate: 'not a date' }, OPTS), null);
});

test('run windows: closing + grace, open shows extend to now, closed-without-closing gets a year', () => {
  assert.equal(relayRunWindowContains(RJ_NYC, Date.parse('2026-07-12'), NOW), true, 'closing + 14d');
  assert.equal(relayRunWindowContains(RJ_NYC, Date.parse('2026-07-13'), NOW), false);
  assert.equal(relayRunWindowContains(RJ_NYC, Date.parse('2026-05-08'), NOW), true, 'previews − 14d');
  assert.equal(relayRunWindowContains(RJ_NYC, Date.parse('2026-05-07'), NOW), false);
  // The 1986 West End Phantom is still open: a 2021 Times review is inside its run.
  assert.equal(relayRunWindowContains({ openingDate: '1986-10-09', status: 'open' }, Date.parse('2021-08-15'), NOW), true);
  assert.equal(relayRunWindowContains({ openingDate: '2020-01-01', status: 'closed' }, Date.parse('2020-12-01'), NOW), true);
  assert.equal(relayRunWindowContains({ openingDate: '2020-01-01', status: 'closed' }, Date.parse('2021-06-01'), NOW), false);
});

test('markets: broadway / off-broadway ⇔ west-end / off-west-end; anything else is out of scope', () => {
  assert.equal(crossMarketOfCategory('broadway'), 'us');
  assert.equal(crossMarketOfCategory('off-broadway'), 'us');
  assert.equal(crossMarketOfCategory('west-end'), 'uk');
  assert.equal(crossMarketOfCategory('off-west-end'), 'uk');
  assert.equal(crossMarketOfCategory('tour'), null);
  assert.equal(crossMarketOfCategory('regional'), null);
  assert.equal(findSiblingInOtherMarket(INDEX, { show: { ...RJ_NYC, category: 'tour' }, criticName: 'Patrick Marmion', publishDate: '2026-04-03' }, OPTS), null);
});

test('relay sources: theatre-record plus every aggregator source aggregator-domains.js recognises (superset, cannot drift)', () => {
  assert.equal(isAggregatorRelaySource('theatre-record'), true);
  assert.equal(isAggregatorRelaySource('show-score-playwright'), true);
  assert.equal(isAggregatorRelaySource('bww-roundup'), true);
  assert.equal(isAggregatorRelaySource('nyc-theatre'), true);
  for (const s of ['rss-discovery', 'manual-entry', 'submit-review-form', 'opening-night-discovery', 'site-search', '', null, undefined]) {
    assert.equal(isAggregatorRelaySource(s), false, `source ${s}`);
  }
  const sample = [
    'westendtheatre', 'westendtheatre-star-rating', 'theatre-reviews', 'theatre-reviews-star-rating', 'stagedoor',
    'stagedoor-star-rating', 'thestage-roundup', 'thestage-roundup-star-rating', 'lbo', 'lbo-roundup', 'lbo-star-rating',
    'show-score', 'dtli', 'theatre-record', 'show-score-playwright', 'bww-roundup', 'bww-reviews', 'nyc-theatre',
    'playbill-verdict', 'rss-discovery', 'manual', 'submit-review-form', 'opening-night-discovery', 'web-search',
  ];
  for (const s of sample) {
    if (isAggregatorReviewSource(s)) assert.equal(isAggregatorRelaySource(s), true, `aggregator source "${s}" must also be a relay source`);
  }
});

test('wiring: the rebuild builds the index in its pre-pass and excludes through logExclusion("crossMarketNullUrlRelay")', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/rebuild-all-reviews.js'), 'utf8');
  assert.ok(src.includes('buildCrossMarketCriticIndex(crossMarketCriticIndexEntries, parseDate)'), 'index built once in the pre-pass');
  assert.ok(src.includes('findSiblingInOtherMarket(crossMarketCriticIndex, {'), 'sibling lookup in the main loop');
  assert.ok(src.includes('classifyDualMarketNullUrl({'), 'classifier called');
  assert.ok(src.includes('logExclusion("crossMarketNullUrlRelay", showId, file, data, {'), 'exclusion logged with the audit reason');
  const call = src.indexOf('classifyDualMarketNullUrl({');
  const listingGate = src.indexOf('logExclusion("skippedListingPage"');
  const forwardGuard = src.indexOf('evaluateForwardCrossMarketGuard({');
  assert.ok(listingGate > 0 && call > listingGate, 'runs after the listing-page gate');
  assert.ok(forwardGuard > 0 && call < forwardGuard, 'runs beside (before) the forward cross-market guard');
  assert.ok(src.includes('!data.url && !data.allowEarlyDate && !shouldSkipWrongProductionAudit(data)'), 'human clears honoured');
});

// Real-corpus layer: the private review-texts checkout is optional locally.
const REVIEW_TEXTS_DIR = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data', 'review-texts');
const SHOWS_PATH = path.join(ROOT, 'data', 'shows.json');
const REGISTRY_PATH = path.join(ROOT, 'data', 'outlet-registry.json');
const haveCorpus = fs.existsSync(path.join(REVIEW_TEXTS_DIR, RJ_NYC.id)) && fs.existsSync(path.join(REVIEW_TEXTS_DIR, RJ_WE.id)) && fs.existsSync(SHOWS_PATH);

test('real corpus: every theatre-record relay in the Delacorte folder is flagged; no West End file is', { skip: !haveCorpus && 'review-texts / shows.json not checked out' }, () => {
  const { normalizeOutlet } = require(path.join(ROOT, 'scripts/lib/review-normalization.js'));
  const registry = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  const dual = new Set();
  for (const [id, o] of Object.entries(registry.outlets)) {
    if (!o.isDualMarket) continue;
    dual.add(id);
    for (const a of o.aliases || []) dual.add(String(a).toLowerCase());
  }
  const shows = JSON.parse(fs.readFileSync(SHOWS_PATH, 'utf8')).shows;
  const byId = Object.fromEntries(shows.map((s) => [s.id, s]));
  const entries = [];
  for (const sid of [RJ_NYC.id, RJ_WE.id]) {
    for (const f of fs.readdirSync(path.join(REVIEW_TEXTS_DIR, sid)).filter((x) => x.endsWith('.json'))) {
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(REVIEW_TEXTS_DIR, sid, f), 'utf8')); } catch { continue; }
      entries.push({ showId: sid, file: f, criticName: d.criticName, publishDate: d.publishDate, show: byId[sid], d });
    }
  }
  const idx = buildCrossMarketCriticIndex(entries, parseDate);
  let relaysFlagged = 0;
  for (const e of entries) {
    if (e.d.url) continue;
    const raw = String(e.d.outletId || e.d.outlet || '').toLowerCase();
    const canon = normalizeOutlet(raw) || raw;
    const sibling = findSiblingInOtherMarket(idx, { show: e.show, criticName: e.criticName, publishDate: e.publishDate }, { parseDate });
    const v = classifyDualMarketNullUrl({ hasUrl: false, outletIsDualMarket: dual.has(canon) || dual.has(raw), siblingInOtherMarket: sibling, source: e.d.source });
    if (e.showId === RJ_WE.id) assert.equal(v.shouldFlag, false, `${e.showId}/${e.file} is the real review`);
    else if (e.d.source === 'theatre-record') { assert.equal(v.shouldFlag, true, `${e.showId}/${e.file} is a relay of the WE review`); relaysFlagged++; }
  }
  assert.ok(relaysFlagged >= 5, `expected the Theatre Record relays to be flagged, got ${relaysFlagged}`);
});
