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

test('loss designation needs a closed run when the status is known', () => {
  const rec = { designation: 'Flop', recouped: false };
  assert.equal(commercialRecordErrors('k', rec, { showRecord: { slug: 'k', status: 'open' } }).length, 1);
  assert.equal(commercialRecordErrors('k', rec, { showRecord: { slug: 'k', status: 'previews' } }).length, 1);
  assert.equal(commercialRecordErrors('k', rec, { showRecord: { slug: 'k', status: 'closed' } }).length, 0);
  assert.equal(commercialRecordErrors('k', rec, {}).length, 0);
  assert.equal(commercialRecordErrors('k', { designation: 'TBD', recouped: false }, { showRecord: { slug: 'k', status: 'open' } }).length, 0);
});

test('public text fields reject research-pipeline wording', () => {
  const e = (rec) => commercialRecordErrors('k', rec, {});
  assert.equal(e({ capitalizationSource: 'SEC filings (GPT Deep Research)' }).length, 1);
  assert.equal(e({ capitalizationSource: 'Trade press / deep research synthesis' }).length, 1);
  assert.equal(e({ notes: 'Auto-enrolled stub; awaiting model + curation.' }).length, 1);
  assert.equal(e({ recoupedSource: 'GPT DR Batch 3 consensus' }).length, 1);
  assert.equal(e({ notes: 'Auto-designated from model output.' }).length, 1);
  // Real citations and ordinary prose pass.
  assert.equal(e({ capitalizationSource: 'Broadway Journal (Sep 2023): $19.5M' }).length, 0);
  assert.equal(e({ notes: 'Researched by the cast; a synthesis of jazz and opera.' }).length, 0);
  assert.equal(e({ recoupedSource: 'Deadline (Aug 2023): recouped its $16.5M capitalization' }).length, 0);
  // weeklyRunningCostSource is filtered by the UI, not here.
  assert.equal(e({ weeklyRunningCostSource: 'GPT estimate' }).length, 0);
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
