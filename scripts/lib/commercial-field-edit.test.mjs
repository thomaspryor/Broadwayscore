// Tests for scripts/lib/commercial-field-edit.js (BRO-4657).
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const { applyCommercialFieldEdit } = require('./commercial-field-edit');
const { mergeCommercialJson } = require('./merge-commercial-data');

const NOW = '2026-10-05T03:00:00.000Z';
const fresh = () => ({ shows: { 'lucky-guy-2013': { designation: 'Flop', recouped: false, lastUpdated: '2026-09-01T00:00:00.000Z' } } });

describe('applyCommercialFieldEdit', () => {
  it('writes the field and stamps lastUpdated', () => {
    const c = fresh();
    const r = applyCommercialFieldEdit(c, 'lucky-guy-2013', 'designation', 'Flop', 'Easy Winner', NOW);
    assert.equal(r.ok, true);
    assert.equal(c.shows['lucky-guy-2013'].designation, 'Easy Winner');
    assert.equal(c.shows['lucky-guy-2013'].lastUpdated, NOW);
  });

  it('refuses a stale oldValue and leaves the record untouched', () => {
    const c = fresh();
    const before = JSON.stringify(c);
    const r = applyCommercialFieldEdit(c, 'lucky-guy-2013', 'designation', 'Hit', 'Easy Winner', NOW);
    assert.equal(r.ok, false);
    assert.match(r.reason, /value changed since plan/);
    assert.equal(JSON.stringify(c), before);
  });

  it('treats a missing field as null for the oldValue check', () => {
    const c = fresh();
    const r = applyCommercialFieldEdit(c, 'lucky-guy-2013', 'recoupedDate', null, '2013-05', NOW);
    assert.equal(r.ok, true);
    assert.equal(c.shows['lucky-guy-2013'].recoupedDate, '2013-05');
  });

  it('refuses an unknown slug', () => {
    const r = applyCommercialFieldEdit(fresh(), 'nope', 'designation', null, 'Flop', NOW);
    assert.equal(r.ok, false);
    assert.match(r.reason, /No commercial entry/);
  });

  it('an edit to lastUpdated itself keeps the planned value', () => {
    const c = fresh();
    applyCommercialFieldEdit(c, 'lucky-guy-2013', 'lastUpdated', '2026-09-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NOW);
    assert.equal(c.shows['lucky-guy-2013'].lastUpdated, '2026-01-01T00:00:00.000Z');
  });

  it('an edited record beats a stale concurrent copy in a no-base push merge', () => {
    // The 2026-10-05 failure: the fix left lastUpdated alone, the stale copy
    // tied and won. With the stamp, the fix is newer and survives.
    const remote = fresh();
    applyCommercialFieldEdit(remote, 'lucky-guy-2013', 'designation', 'Flop', 'Easy Winner', NOW);
    const stale = fresh();
    stale.shows['lucky-guy-2013'].modelLastRun = '2026-10-05T01:50:00.000Z';
    const { merged } = mergeCommercialJson(stale, remote);
    assert.equal(merged.shows['lucky-guy-2013'].designation, 'Easy Winner');
  });
});
