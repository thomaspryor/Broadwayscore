/**
 * BRO-5791: every script that appends a row to shows.json runs the
 * ticket-identity duplicate gate applyAddShow has (BRO-5789).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { newRowDuplicate } = require('../../scripts/lib/add-show-action.js');

const INSERTERS = ['promote-we-aggregator-candidates.js', 'create-tour-entries.js', 'add-verified-tours.js', 'discover-new-shows.js'];

test('each shows.json inserter calls newRowDuplicate', () => {
  for (const f of INSERTERS) {
    const src = fs.readFileSync(new URL(`../../scripts/${f}`, import.meta.url), 'utf8');
    assert.match(src, /newRowDuplicate\(/, `${f} must gate new rows on ticket identity`);
  }
});

test('ticketOnly refuses a row sharing a TodayTix id, ignoring declared links', () => {
  const existing = [{ id: 'a-2026', title: 'Alpha Show', todaytixId: 777 }];
  const row = { id: 'alpha-show-2026', title: 'Alpha Show', todaytixId: '777' };
  assert.equal(newRowDuplicate(existing, row, [], { ticketOnly: true })?.other, 'a-2026');
  assert.equal(newRowDuplicate(existing, row, ['a-2026'], { ticketOnly: true }), null);
  assert.equal(newRowDuplicate(existing, { id: 'b-2026', title: 'Beta', todaytixId: 778 }, [], { ticketOnly: true }), null);
});
