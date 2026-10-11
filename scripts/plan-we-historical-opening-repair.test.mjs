import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { rowActions, sourcedPressNights, SOURCED } = require('./plan-we-historical-opening-repair.js');

const show = { id: 'betrayal-west-end-2019', discoverySource: 'we-historical:wos', previewsStartDate: null, openingDate: '2019-03-05', openingDateSource: 'whatsonstage' };
const rv = (...d) => d.map((publishDate) => ({ publishDate }));

test('a sourced press night beats the review inference', () => {
  const sourced = sourcedPressNights({ 'betrayal-west-end-2019|openingNight': { verdict: 'wrong', correctValue: '2019-03-13', url: 'https://x/betrayal', note: 'opening=first-preview' } });
  const a = rowActions(show, rv('2019-03-15', '2019-03-15', '2019-03-15'), sourced);
  assert.deepEqual(a.map((x) => [x.field, x.newValue]), [['previewsStartDate', '2019-03-05'], ['openingDate', '2019-03-13'], ['openingDateSource', SOURCED]]);
});

test('a stored opening checked correct is left alone', () => {
  const sourced = sourcedPressNights({ 'betrayal-west-end-2019|openingNight': { verdict: 'correct', url: 'https://x' } });
  assert.deepEqual(rowActions(show, rv('2019-03-15', '2019-03-15', '2019-03-15'), sourced), []);
});

test('changing the opening date re-keys an active no-reliable-art marker', () => {
  const marked = { ...show, title: 'Betrayal', venue: 'Harold Pinter Theatre', noReliableArt: { at: '2026-10-11', reason: 'r', key: 'betrayal|harold pinter theatre|2019-03-05' } };
  const a = rowActions(marked, rv('2019-03-14', '2019-03-14', '2019-03-14'), new Map());
  const m = a.find((x) => x.field === 'noReliableArt');
  assert.equal(m.newValue.key, 'betrayal|harold pinter theatre|2019-03-13');
  assert.equal(m.newValue.at, '2026-10-11');
});
