import { test } from 'node:test';
import assert from 'node:assert/strict';
import guard from '../../scripts/lib/dtli-ingest-guards.js';

const show = { id: 'tristan-and-yseult-off-broadway-2026', openingDate: '2026-11-04' };
const page = (...dates) => dates.map(date => `<div class="review-item-date">${date}</div>`).join('');

test('rejects a 2014 DTLI page for the 2026 production, including undated supplements', () => {
  assert.equal(guard.dtliPagePredatesProduction(page('November 24, 2014', 'November 24, 2014'), show).skip, true);
});
test('accepts current and undated pages, and ignores unrelated page dates', () => {
  assert.equal(guard.dtliPagePredatesProduction(page('November 5, 2026'), show).skip, false);
  assert.equal(guard.dtliPagePredatesProduction('<footer>2014</footer>', show).skip, false);
  assert.equal(guard.dtliPagePredatesProduction(page('November 24, 2014', 'November 5, 2026', 'November 6, 2026'), show).skip, false);
});
test('honors declared prior runs', () => {
  const prior = { ...show, priorRuns: [{ openingDate: '2014-11-01', closingDate: '2014-12-31' }] };
  assert.equal(guard.dtliPagePredatesProduction(page('November 24, 2014'), prior).skip, false);
});
