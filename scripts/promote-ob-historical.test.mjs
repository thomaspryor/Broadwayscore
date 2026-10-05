// BRO-2026: promote-ob-historical's id year follows the production's dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildShowEntry } = require('./promote-ob-historical.js');

const row = (parsed) => ({ title: 'Some Show', venue: "St. Luke's Theatre", parsed, playbillUrl: 'x' });

test('dates decide the id year over the title-parsed year', () => {
  const e = buildShowEntry(row({ dates: { openingDate: '2019-03-04' }, titleParse: { year: 2020 } }), new Set());
  assert.match(e.id, /-2019$/);
  assert.equal(e.idYearProvisional, undefined);
});
test('title-parsed year used when no dates', () => {
  const e = buildShowEntry(row({ dates: {}, titleParse: { year: 2018 } }), new Set());
  assert.match(e.id, /-2018$/);
  assert.equal(e.idYearProvisional, undefined);
});
test('nothing dated: run year, flagged provisional', () => {
  const e = buildShowEntry(row({ dates: {}, titleParse: {} }), new Set());
  assert.ok(e.id.endsWith(`-${new Date().getFullYear()}`));
  assert.equal(e.idYearProvisional, true);
});
