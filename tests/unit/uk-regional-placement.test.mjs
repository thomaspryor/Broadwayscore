/**
 * BRO-5103 (owner decision 2026-10-13, option A): UK shows at flagship houses
 * outside London (RSC, Chichester, ...) are not Broadway-bound tryouts, so they
 * stay off the "Pre-Broadway: Out-of-Town Shows" shelf and page and appear under
 * "Beyond London" on the West End page. Real functions, real data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { isUkRegionalShow } from '../../src/lib/market-utils';
import { getRegionalShows, getUkRegionalShows, getAllShows } from '../../src/lib/data-core';
import { BROWSE_PAGES } from '../../src/config/browse-pages';

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
  const allRegional = getAllShows().filter((s) => s.category === 'regional');
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
