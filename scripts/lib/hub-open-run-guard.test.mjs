// BRO-8455 item 8: no hub production may be open with no closing date and no estimated flag, now or from a writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { openRunsWithoutClosing } = require('./hub-open-run-guard.js');
const { buildShow } = require('./bww-review-add.js');

test('unit: flags an open hub row with neither closing date nor source; passes estimated and sourced rows', () => {
  const base = { localOnly: true, status: 'open', openingDate: '2026-09-25' };
  assert.equal(openRunsWithoutClosing([{ id: 'a', ...base }], '2026-11-28').length, 1);
  assert.equal(openRunsWithoutClosing([{ id: 'b', ...base, closingDateSource: 'estimated' }], '2026-11-28').length, 0);
  assert.equal(openRunsWithoutClosing([{ id: 'c', ...base, closingDate: '2026-12-01', closingDateSource: 'theatre-page' }], '2026-11-28').length, 0);
  assert.equal(openRunsWithoutClosing([{ id: 'd', ...base, status: 'closed' }], '2026-11-28').length, 0);
});

test('writer: a BroadwayWorld-sourced add with no printed closing date is flagged estimated', () => {
  const facts = { title: 'Body Language', type: 'play', theatre: 'Woolly Mammoth Theatre', town: 'Washington', state: 'DC', openingDate: '2026-11-20', firstPerformance: null, closingDate: null, today: '2026-11-28' };
  const r = buildShow(facts, { review: { url: 'https://www.broadwayworld.com/x', date: '2026-11-21' }, hubSlug: 'washington-dc', hubShows: [], hubHome: { town: 'Washington', state: 'DC' }, taken: new Set(), today: '2026-11-28' });
  assert.ok(r.show, JSON.stringify(r));
  assert.equal(r.show.closingDate, undefined);
  assert.equal(r.show.closingDateSource, 'estimated');
});

