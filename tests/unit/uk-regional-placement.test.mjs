/**
 * BRO-5103 (owner decision 2026-10-13, option A): UK shows at flagship houses
 * outside London (RSC, Chichester, ...) are not Broadway-bound tryouts, so they
 * stay off the "Pre-Broadway: Out-of-Town Shows" shelf and page and appear under
 * "Beyond London" on the West End page. Real functions, real data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isUkRegionalShow } from '../../src/lib/market-utils';
import { isLocalOnlyShow } from '../../src/lib/local-market';
import { getRegionalShows, getUkRegionalShows, getAllShows } from '../../src/lib/data-core';
import { BROWSE_PAGES } from '../../src/config/browse-pages';
import { getBrowseList, getAllBrowseSlugs } from '../../src/lib/data-core';
import { getEffectiveMarket, getEffectiveMarketLabel } from '../../src/lib/show-market';
import { getMarketFromPath } from '../../src/hooks/useCurrentMarket';
import { isCategoryEnabled } from '../../src/lib/markets';

test('isUkRegionalShow: only regional shows at a listed UK house', () => {
  assert.equal(isUkRegionalShow({ category: 'regional', venue: 'Royal Shakespeare Theatre, Stratford-upon-Avon' }), true);
  assert.equal(isUkRegionalShow({ category: 'regional', venue: 'Chichester Festival Theatre, Chichester' }), true);
  assert.equal(isUkRegionalShow({ category: 'regional', venue: 'Goodman Theatre, Chicago, IL' }), false);
  // The Globe is West End, whatever its name: only category 'regional' counts.
  assert.equal(isUkRegionalShow({ category: 'west-end', venue: "Shakespeare's Globe" }), false);
  assert.equal(isUkRegionalShow({ category: 'regional' }), false);
});

test('the Pre-Broadway list and the UK list split every regional show exactly once', () => {
  const tryouts = getRegionalShows();
  const uk = getUkRegionalShows();
  // Local-only shows (BRO-6518) are on neither list by design; every other regional show is on exactly one.
  const allRegional = getAllShows().filter((s) => s.category === 'regional' && !isLocalOnlyShow(s));
  assert.equal(tryouts.length + uk.length, allRegional.length);
  const ids = new Set(tryouts.map((s) => s.id));
  for (const s of uk) assert.equal(ids.has(s.id), false, `${s.id} is on both lists`);
  for (const s of tryouts) assert.equal(isUkRegionalShow(s), false, `${s.id} is a UK show on the tryouts list`);
});

test('the Pre-Broadway browse page filters UK houses out through the data source', () => {
  const page = BROWSE_PAGES['pre-broadway-out-of-town-shows'];
  assert.ok(page, 'browse page exists');
  assert.equal(page.source, 'regional');
  // The browse list is built from getRegionalShows(), so it must not contain a UK show.
  for (const s of getRegionalShows().filter((x) => page.filter(x))) {
    assert.equal(isUkRegionalShow(s), false, `${s.id} would show on the Pre-Broadway page`);
  }
});

// ── Shelf helper and wording (review of BRO-5103) ───────────────────────────
import { pickRegionalShelf } from '../../src/lib/regional-shelf';
import { getDurationSuffix } from '../../src/lib/date-utils';

const shelfShow = (id, over = {}) => ({
  id, status: 'closed', category: 'regional', openingDate: '2026-01-01',
  criticScore: { score: 80, reviewCount: 6, tier1Count: 2, tier2Count: 1 }, ...over,
});

test('pickRegionalShelf: scored only, live first, newest first, capped', () => {
  const shows = [
    shelfShow('old-closed', { openingDate: '2025-01-01' }),
    shelfShow('new-closed', { openingDate: '2026-06-01' }),
    shelfShow('live-older', { status: 'open', openingDate: '2026-02-01' }),
    shelfShow('live-newer', { status: 'previews', openingDate: '2026-09-01' }),
    shelfShow('unscored', { criticScore: { score: null, reviewCount: 1 } }),
    shelfShow('no-score-object', { criticScore: null }),
  ];
  assert.deepEqual(pickRegionalShelf(shows).map((s) => s.id), ['live-newer', 'live-older', 'new-closed', 'old-closed']);
  assert.deepEqual(pickRegionalShelf(shows, { limit: 2 }).map((s) => s.id), ['live-newer', 'live-older']);
});

test('pickRegionalShelf with requireEnoughReviews drops a scored show whose score the card would hide', () => {
  const thin = shelfShow('thin', { criticScore: { score: 85, reviewCount: 1, tier1Count: 0, tier2Count: 0 } });
  const solid = shelfShow('solid');
  assert.deepEqual(pickRegionalShelf([thin, solid]).map((s) => s.id).sort(), ['solid', 'thin']);
  assert.deepEqual(pickRegionalShelf([thin, solid], { requireEnoughReviews: true }).map((s) => s.id), ['solid']);
});

test('getDurationSuffix: a UK regional show is not "in tryout"; a US one still is', () => {
  assert.equal(getDurationSuffix('regional', 'Royal Shakespeare Theatre, Stratford-upon-Avon'), 'in Stratford-upon-Avon');
  assert.equal(getDurationSuffix('regional', 'Goodman Theatre, Chicago, IL'), 'in tryout');
  assert.equal(getDurationSuffix('regional'), 'in tryout');
  assert.equal(getDurationSuffix('west-end'), 'in London');
  assert.equal(getDurationSuffix('tour'), 'on tour');
});

// ── Show page and related shows (ship-check of BRO-5103) ────────────────────
import { getRelatedShowsOpen, getRelatedShowsClosed } from '../../src/lib/data-core';
import { getUkRegionalVenueCity } from '../../src/lib/market-utils';

test('isUkRegionalShow accepts the aliases the pipeline accepts', () => {
  assert.equal(isUkRegionalShow({ category: 'regional', venue: 'Sheffield Crucible, Sheffield' }), true);
  assert.equal(isUkRegionalShow({ category: 'regional', venue: 'Royal Exchange Manchester' }), true);
  assert.equal(isUkRegionalShow({ category: 'regional', venue: 'Lyceum Edinburgh' }), true);
  assert.equal(getUkRegionalVenueCity('regional', 'Sheffield Crucible'), 'Sheffield');
  assert.equal(isUkRegionalShow({ category: 'regional', venue: 'Crucible Studio, Anytown, OH' }), false);
});

import { getShowFAQs } from '../../src/lib/seo';

test('FAQ copy: a UK flagship show is "in the UK", a US tryout stays "in a regional production"', () => {
  const faqText = (s) => getShowFAQs(s).map((f) => `${f.question} ${f.answer}`).join(' ');
  const uk = getUkRegionalShows().find((s) => s.status === 'open' || s.status === 'closed');
  const us = getRegionalShows()[0];
  assert.ok(uk && us, 'fixtures exist');
  assert.match(faqText(uk), /in the UK/);
  assert.doesNotMatch(faqText(uk), /regional production/);
  assert.match(faqText(us), /regional production/);
});

test('related shows never mix UK flagship shows with US tryouts', () => {
  const isUs = (s) => s.category === 'regional' && !isUkRegionalShow(s);
  for (const s of getUkRegionalShows()) {
    for (const r of [...getRelatedShowsOpen(s), ...getRelatedShowsClosed(s)]) {
      assert.equal(isUs(r), false, `${s.id} (UK) recommends US tryout ${r.id}`);
    }
  }
  for (const s of getRegionalShows()) {
    for (const r of [...getRelatedShowsOpen(s), ...getRelatedShowsClosed(s)]) {
      assert.equal(isUkRegionalShow(r), false, `${s.id} (US tryout) recommends UK show ${r.id}`);
    }
  }
});

test('second stages of listed UK houses count as UK, and the scoring prompt agrees (BRO-5103 retro)', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { isUkRegionalVenue } = require('../../scripts/lib/market-label.js');
  for (const venue of ['Swan Theatre, Stratford-upon-Avon', 'The Other Place, Stratford-upon-Avon', 'Minerva Theatre, Chichester', 'Sheffield Crucible', 'Royal Exchange Manchester']) {
    assert.equal(isUkRegionalShow({ category: 'regional', venue }), true, `site: ${venue}`);
    assert.equal(isUkRegionalVenue(venue), true, `pipeline: ${venue}`);
  }
  // Same-named houses elsewhere stay US tryouts.
  assert.equal(isUkRegionalShow({ category: 'regional', venue: 'Swan Theatre, Worcester' }), false);
});

test('show page <title> labels a UK house "in the UK", not as a regional (US) production', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync('src/app/show/[slug]/page.tsx', 'utf8');
  assert.match(src, /isUkRegionalMeta \? 'in the UK' : isRegionalMeta \? 'in a regional production'/);
});

test('UK flagship shows read "UK Regional" in search/alt text; the US shelf applies the review floor (BRO-5269)', async () => {
  const { readFileSync } = await import('node:fs');
  const { getRegionalLabel, getMarketLabel } = await import('../../src/lib/market-utils.ts');
  assert.equal(getMarketLabel('regional', 'Royal Exchange Theatre, Manchester'), 'UK Regional');
  assert.equal(getMarketLabel('regional', 'Swan Theatre, Worcester'), 'Regional');
  assert.equal(getMarketLabel('regional'), 'Regional');
  assert.equal(getRegionalLabel({ category: 'regional', venue: 'Swan Theatre, Stratford-upon-Avon' }), 'UK Regional');
  assert.equal(getRegionalLabel({ category: 'regional', venue: 'Swan Theatre, Worcester' }), 'Regional');
  for (const f of ['src/components/HeaderSearch.tsx', 'src/components/show-cards/ShowSearchDropdown.tsx', 'src/components/show-page/ShowHeroRedesign.tsx']) {
    assert.doesNotMatch(readFileSync(f, 'utf8'), /category === 'regional' \? 'Regional'/, `${f} hardcodes Regional`);
  }
  assert.match(readFileSync('src/lib/homepage-extra.ts', 'utf8'), /pickRegionalShelf\(getRegionalShows\(\), \{ requireEnoughReviews: true \}\)/);
});

test('UK show navigation uses venue-aware server data, keeping US tryouts Regional (BRO-6420)', () => {
  const uk = getUkRegionalShows();
  assert.ok(uk.length > 0);
  const markets = Object.fromEntries(uk.map(s => [s.slug, getEffectiveMarket(s)]));
  for (const s of uk) {
    assert.equal(getEffectiveMarket(s), 'uk-regional', s.id);
    assert.equal(getEffectiveMarketLabel(s), 'UK Regional', s.id);
    assert.equal(getMarketFromPath(`/show/${s.slug}`, markets), 'uk-regional', s.id);
    assert.equal(getMarketFromPath(`/show/${s.slug}/`, markets), 'uk-regional', s.id);
  }
  for (const s of getRegionalShows()) {
    assert.equal(getEffectiveMarket(s), 'regional', s.id);
    assert.equal(getMarketFromPath(`/show/${s.slug}`, markets), getMarketFromPath(`/show/${s.slug}`), s.id);
  }
  assert.equal(getEffectiveMarket({ category: 'regional' }), 'regional');
  assert.equal(getEffectiveMarket({ category: 'regional', venue: 'Swan Theatre, Worcester' }), 'regional');
  assert.equal(getEffectiveMarket({ category: 'regional', venue: 'Sheffield Crucible' }), 'uk-regional');
  assert.equal(getMarketFromPath('/west-end', markets), 'west-end');
  assert.equal(getMarketFromPath('/show/hamilton-2015', markets), 'nyc');
});

test('Beyond London browse lists the entire eligible UK shelf and is registered for export (BRO-6420)', () => {
  const config = BROWSE_PAGES['beyond-london'];
  assert.ok(config);
  assert.equal(config.source, 'regional');
  assert.equal(config.regionalScope, 'uk');
  const list = getBrowseList('beyond-london');
  assert.ok(list);
  const expected = pickRegionalShelf(getUkRegionalShows(), { limit: Infinity, requireEnoughReviews: true });
  assert.ok(expected.length > 0);
  assert.deepEqual(list.shows.map(s => s.id), expected.map(s => s.id));
  assert.ok(list.shows.every(isUkRegionalShow));
  // Exercise the uncapped path even while the real inventory is below ten.
  const expanded = Array.from({ length: 15 }, (_, i) => ({ ...expected[i % expected.length], id: `uk-${i}` }));
  assert.equal(config.customSort(expanded).length, 15);
  assert.equal(getAllBrowseSlugs().includes('beyond-london'), isCategoryEnabled('regional'));
  assert.equal(getMarketFromPath('/browse/beyond-london'), 'uk-regional');
  assert.equal(getMarketFromPath('/browse/beyond-london/'), 'uk-regional');
  assert.equal(getMarketFromPath('/browse/pre-broadway-out-of-town-shows'), 'regional');
});

test('UK market overrides and the view-all link are wired to existing UI callers (BRO-6420)', async () => {
  const { readFileSync } = await import('node:fs');
  const layout = readFileSync('src/app/layout.tsx', 'utf8');
  assert.match(layout, /getUkRegionalShows\(\)\.map\(show => \[show.slug, getEffectiveMarket\(show\)\]\)/);
  assert.match(layout, /<ShowMarketProvider showMarkets=\{showMarkets\}>/);
  assert.match(layout, /<MarketNav stats=\{marketStats\}/);
  const nav = readFileSync('src/components/MarketNav.tsx', 'utf8');
  assert.match(nav, /useCurrentMarket\(true\)/);
  assert.match(nav, /isUkRegional \? 'UK Regional'/);
  assert.match(readFileSync('src/components/WestEndPageClient.tsx', 'utf8'), /title="Beyond London"[^>]+viewAllHref="\/browse\/beyond-london"/);
});
