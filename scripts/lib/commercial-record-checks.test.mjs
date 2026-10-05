/**
 * Tests for scripts/lib/commercial-record-checks.js (BRO-4623): the per-record
 * commercial.json rules shared by validate-data.js and execute-approved-fix.js.
 * Run: node --test scripts/lib/commercial-record-checks.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { commercialRecordErrors, commercialFileErrors } = require('./commercial-record-checks.js');

const shows = [
  { id: 'hamilton-2015', slug: 'hamilton', venue: 'Richard Rodgers Theatre' },
  { id: 'ragtime-2025', slug: 'ragtime', venue: 'Vivian Beaumont Theater' },
];
const ok = { designation: 'Miracle', recouped: true, recoupedDate: '2016-03', sources: [{ type: 'trade', url: 'https://x.y/a', date: '2016-06-12' }] };

test('a clean record and a clean file have no errors', () => {
  assert.deepEqual(commercialRecordErrors('hamilton', ok, { showRecord: shows[0] }), []);
  assert.deepEqual(commercialFileErrors({ shows: { hamilton: ok } }, shows), []);
});

test('outcome policy: win needs recouped=true, loss needs recouped=false, recouped needs a date', () => {
  const e = (rec) => commercialRecordErrors('k', rec, {});
  assert.equal(e({ designation: 'Windfall', recouped: null }).length, 1);
  assert.equal(e({ designation: 'Flop', recouped: null }).length, 1);
  assert.equal(e({ designation: 'TBD', recouped: true }).length, 1);
  assert.equal(e({ designation: 'TBD', recouped: true, recoupedDate: '2024/01' }).length, 1);
});

test('nonprofitOrg is checked against the shows.json venue', () => {
  assert.equal(commercialRecordErrors('ragtime', { designation: 'Nonprofit', nonprofitOrg: 'Lincoln Center Theater' }, { showRecord: shows[1] }).length, 0);
  assert.equal(commercialRecordErrors('ragtime', { designation: 'Nonprofit', nonprofitOrg: 'Manhattan Theatre Club' }, { showRecord: shows[1] }).length, 1);
});

test('sources, costMethodology, productionType and originalProductionId shapes', () => {
  const e = (rec, ctx = {}) => commercialRecordErrors('k', rec, ctx);
  assert.equal(e({ sources: [{ type: 'other', url: 'https://x.y' }] }).length, 1);
  assert.equal(e({ costMethodology: 'guess' }).length, 1);
  assert.equal(e({ productionType: 'weird' }).length, 1);
  assert.equal(e({ originalProductionId: 'nope' }, { allRecords: {} }).length, 1);
  assert.equal(e({ originalProductionId: 'a' }, { allRecords: { a: {} } }).length, 0);
});
