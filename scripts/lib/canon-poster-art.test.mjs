import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { findNewerSameTitleProduction } = require('./canon-poster-art.js');

// BRO-119: Tony canon checklist entries for closed Broadway winners picked up
// wrong-production TodayTix art (In the Heights → CenterREP regional poster,
// Avenue Q → a later same-title revival) because the "skip TodayTix" guard
// hadn't yet learned about the newer same-title production when the images
// were originally fetched. These fixtures are the real show rows involved.
const IN_THE_HEIGHTS_2008 = { id: 'in-the-heights-2008', title: 'In the Heights', status: 'closed', openingDate: '2008-03-09' };
const IN_THE_HEIGHTS_OFF_BROADWAY_2026 = { id: 'in-the-heights-off-broadway-2026', title: 'In the Heights', status: 'upcoming', openingDate: '2026-10-28' };
const AVENUE_Q_2003 = { id: 'avenue-q-2003', title: 'Avenue Q', status: 'closed', openingDate: '2003-07-31' };
const AVENUE_Q_WEST_END_2026 = { id: 'avenue-q-west-end-2026', title: 'Avenue Q', status: 'open', openingDate: '2026-04-16' };

test('In the Heights (2008 OBC, closed) skips TodayTix because a newer same-title production exists', () => {
  const allShows = [IN_THE_HEIGHTS_2008, IN_THE_HEIGHTS_OFF_BROADWAY_2026, AVENUE_Q_2003, AVENUE_Q_WEST_END_2026];
  assert.equal(findNewerSameTitleProduction(IN_THE_HEIGHTS_2008, allShows)?.id, 'in-the-heights-off-broadway-2026');
});

test('Avenue Q (2003 OBC, closed) skips TodayTix because the West End revival is newer', () => {
  const allShows = [IN_THE_HEIGHTS_2008, IN_THE_HEIGHTS_OFF_BROADWAY_2026, AVENUE_Q_2003, AVENUE_Q_WEST_END_2026];
  assert.equal(findNewerSameTitleProduction(AVENUE_Q_2003, allShows)?.id, 'avenue-q-west-end-2026');
});

test('a currently-running show never skips TodayTix, even if an older same-title show exists', () => {
  const allShows = [IN_THE_HEIGHTS_2008, IN_THE_HEIGHTS_OFF_BROADWAY_2026];
  assert.equal(findNewerSameTitleProduction(IN_THE_HEIGHTS_OFF_BROADWAY_2026, allShows), null);
});

test('a closed show with no same-title production anywhere else does not skip TodayTix', () => {
  const soleShow = { id: 'hamilton-2015', title: 'Hamilton', status: 'closed', openingDate: '2015-08-06' };
  assert.equal(findNewerSameTitleProduction(soleShow, [soleShow, AVENUE_Q_2003]), null);
});

test('a closed show with an OLDER same-title production does not skip TodayTix (nothing to protect against)', () => {
  const revivalNowClosed = { id: 'in-the-heights-revival-2015', title: 'In the Heights', status: 'closed', openingDate: '2015-01-01' };
  assert.equal(findNewerSameTitleProduction(revivalNowClosed, [IN_THE_HEIGHTS_2008, revivalNowClosed]), null);
});

test('punctuation-separated title variants still count as the same title', () => {
  const globe = { id: 'the-tempest-globe-2024', title: 'The Tempest', status: 'closed', openingDate: '2020-01-01' };
  const globeRevival = { id: 'the-tempest-globe-revival-2026', title: 'The Tempest - Globe', status: 'open', openingDate: '2026-01-01' };
  assert.equal(findNewerSameTitleProduction(globe, [globe, globeRevival])?.id, 'the-tempest-globe-revival-2026');
});

test('short single-word titles do not fuzzy-match unrelated longer titles', () => {
  const big = { id: 'big-1996', title: 'Big', status: 'closed', openingDate: '1996-04-28' };
  const bigFish = { id: 'big-fish-2013', title: 'Big Fish', status: 'closed', openingDate: '2013-10-06' };
  assert.equal(findNewerSameTitleProduction(big, [big, bigFish]), null);
});
