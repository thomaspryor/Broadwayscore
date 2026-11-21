// Guards the shared Shared Plans parity fixture (BRO-4481). Three
// implementations (SQL, web, iOS) test against this one file, so a malformed
// or lopsided fixture would quietly weaken all three at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const fixture = JSON.parse(
  readFileSync(new URL('../fixtures/shared-plans-parity.json', import.meta.url), 'utf-8'),
);
const BUCKETS = ['booked', 'unbooked', 'excluded'];

test('every case is well-formed', () => {
  assert.ok(Array.isArray(fixture.cases) && fixture.cases.length > 0);
  const ids = new Set();
  for (const c of fixture.cases) {
    assert.equal(typeof c.name, 'string', 'name');
    assert.ok(c.show && typeof c.show.id === 'string', `${c.name}: show.id`);
    assert.ok(!ids.has(c.show.id), `${c.name}: duplicate show id ${c.show.id}`);
    ids.add(c.show.id);
    assert.ok(c.plannedOffset === null || Number.isInteger(c.plannedOffset), `${c.name}: plannedOffset`);
    assert.ok(Array.isArray(c.reviews), `${c.name}: reviews`);
    for (const r of c.reviews) {
      assert.ok(r.seenOffset === null || Number.isInteger(r.seenOffset), `${c.name}: seenOffset`);
    }
    assert.ok(BUCKETS.includes(c.expected), `${c.name}: expected bucket`);
    assert.equal(typeof c.sqlIncluded, 'boolean', `${c.name}: sqlIncluded`);
    if (c.sqlIncluded) assert.equal(typeof c.sqlLogged, 'boolean', `${c.name}: sqlLogged`);
    // A row the database must withhold can never end up visible.
    if (!c.sqlIncluded) assert.equal(c.expected, 'excluded', `${c.name}: withheld rows are excluded`);
    if (c.now) assert.ok(!Number.isNaN(Date.parse(c.now)), `${c.name}: now`);
  }
});

test('every bucket and both SQL outcomes are exercised', () => {
  for (const b of BUCKETS) {
    assert.ok(fixture.cases.some(c => c.expected === b), `no case for ${b}`);
  }
  assert.ok(fixture.cases.some(c => c.sqlIncluded === false), 'no withheld case');
  assert.ok(fixture.cases.some(c => c.sqlIncluded && c.sqlLogged === true), 'no logged case');
  assert.ok(fixture.cases.some(c => c.show.category === 'west-end'), 'no West End case');
});
