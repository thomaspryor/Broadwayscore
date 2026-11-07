// BRO-4891: prior-production pages for revival promo + one-word-title contamination.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyAddShow } = require('../../scripts/lib/add-show-action.js');
const { checkGenericTitleCandidate, isOneWordTitle, _resetCachesForTest } = require('../../scripts/lib/generic-title-matching.js');

const prior = { id: 'dreamgirls-1981', title: 'Dreamgirls', venue: 'Imperial Theatre', openingDate: '1981-12-20', closingDate: '1985-08-11', category: 'broadway', market: 'broadway' };
const newShow = () => ({
  id: 'dreamgirls-west-end-2016', slug: 'dreamgirls-west-end-2016', title: 'Dreamgirls', venue: 'Savoy Theatre',
  status: 'closed', type: 'musical', category: 'west-end', market: 'west-end', openingDate: '2016-12-17', closingDate: '2017-10-07',
});

test('add-show accepts a prior-production entry with priorRunOf + crossLinkFrom', () => {
  const shows = [{ ...prior }];
  const r = applyAddShow(shows, { type: 'add-show', show: newShow(), priorRunOf: 'dreamgirls-1981', crossLinkFrom: 'dreamgirls-1981' });
  assert.equal(r.ok, true, r.reason);
  const added = shows.find(s => s.id === 'dreamgirls-west-end-2016');
  assert.equal(added.priorRuns[0].id, 'dreamgirls-1981');
  assert.ok(shows[0].priorRuns.some(x => x.id === 'dreamgirls-west-end-2016'));
});

test('add-show rejects a placeholder venue', () => {
  const s = newShow(); s.venue = 'TBA';
  const r = applyAddShow([{ ...prior }], { type: 'add-show', show: s, priorRunOf: 'dreamgirls-1981' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /placeholder/);
});

test('add-show rejects an unknown priorRunOf', () => {
  const r = applyAddShow([{ ...prior }], { type: 'add-show', show: newShow(), priorRunOf: 'nope' });
  assert.equal(r.ok, false);
});

test('one-word title needs year or venue in the candidate', () => {
  const df = new Map([['gloria', 2], ['hamilton', 1]]);
  _resetCachesForTest(df);
  const gloria = { title: 'Gloria', venue: 'Hayes Theater', openingDate: '2027-04-05', cast: [{ name: 'Ruth Negga' }] };
  assert.equal(isOneWordTitle('Gloria'), true);
  assert.equal(isOneWordTitle('The Full Monty'), false);
  const strayOnYourFeet = { title: 'On Your Feet review: Gloria Estefan music upstages the story', snippet: 'Gloria Estefan musical at the Marquis', url: 'https://newsday.com/on-your-feet-review-gloria-estefan' };
  const r = checkGenericTitleCandidate({ show: gloria, candidate: strayOnYourFeet, df });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'one-word-title-needs-year-or-venue');
  assert.equal(checkGenericTitleCandidate({ show: gloria, candidate: { title: 'Gloria review', snippet: 'at the Hayes Theater', url: 'x' }, df }).ok, true);
  assert.equal(checkGenericTitleCandidate({ show: gloria, candidate: { title: 'Gloria 2027 review', snippet: '', url: 'x' }, df }).ok, true);
  const ham = { title: 'Hamilton', venue: 'Richard Rodgers Theatre', openingDate: '2015-08-06', cast: [] };
  assert.equal(checkGenericTitleCandidate({ show: ham, candidate: { title: 'Anything', snippet: '', url: 'x' }, df }).ok, true);
});
