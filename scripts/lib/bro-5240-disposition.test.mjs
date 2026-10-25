// BRO-5240: every row stamped 'inferred-from-reviews' under the old -1 offset
// has a recorded disposition (confirmed / corrected / no-source).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const led = JSON.parse(fs.readFileSync(new URL('../../data/audit/bro-5240-inferred-dates-disposition.json', import.meta.url), 'utf8'));

test('ledger covers all 68 rows with unique ids and a valid disposition', () => {
  assert.equal(led.rows.length, 68);
  assert.equal(new Set(led.rows.map((r) => r.id)).size, 68);
  for (const r of led.rows) {
    assert.match(r.openingDate, /^\d{4}-\d{2}-\d{2}$/, r.id);
    assert.ok(['confirmed', 'corrected', 'no-source'].includes(r.disposition), r.id);
    if (r.disposition !== 'no-source') assert.ok(r.source && r.newOpeningDate, r.id);
  }
});
