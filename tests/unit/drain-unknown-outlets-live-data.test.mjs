// TESTS-VS-DERIVED-DATA-EXEMPT: structural: every planned ingest has a derived non-generic id and no wrong-production pairing; pins no show fact
// BRO-5729 (BRO-3425 pattern): live-data assertions split out of scripts/lib/drain-unknown-outlets.test.mjs. They assert ceilings / zero-counts over
// bot-rewritten data (data/audit/unknown-aggregator-outlets.json + data/shows.json), so in a code-test batch they turn main red with no code change.
// They run in check-corpus-drift.yml's "Live-data assertions" step (data-health), excluded from the unit batches in
// scripts/lib/unit-test-collection.js. Pure-logic tests stay in scripts/lib/drain-unknown-outlets.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { planDrain, productionMismatch, ledgerKey } = require('../../scripts/lib/drain-unknown-outlets.js');
const { provisionalOutletIdFromHost } = require('../../scripts/lib/outlet-canonicalize.js');

const audit = JSON.parse(fs.readFileSync(new URL('../../data/audit/unknown-aggregator-outlets.json', import.meta.url), 'utf8'));
const shows = JSON.parse(fs.readFileSync(new URL('../../data/shows.json', import.meta.url), 'utf8')).shows;
const showsById = Object.fromEntries(shows.map(s => [s.id, s]));

test('only hosts with occurrences >= 2 are drained', () => {
  const { batch } = planDrain(audit, showsById, { batchSize: 10000 });
  const occ = Object.fromEntries(audit.outlets.map(o => [o.host, o.occurrences]));
  assert.ok(batch.length > 0);
  for (const b of batch) assert.ok(occ[b.host] >= 2, b.host);
});

test('live backlog: every prepared ingest carries a derived, non-generic provisional id', () => {
  const { batch } = planDrain(audit, showsById, { batchSize: 10000 });
  for (const e of batch) {
    assert.equal(e.outletId, provisionalOutletIdFromHost(e.host));
    assert.ok(!['open', 'news', 'm'].includes(e.outletId), e.host);
  }
});

test('live backlog: no ingest targets a pre-opening year or a US outlet on a West End show', () => {
  const { batch } = planDrain(audit, showsById, { batchSize: 10000 });
  for (const b of batch) assert.equal(productionMismatch(b.url, showsById[b.showId]), null, b.key);
});

test('checkpoint: ledger entries are skipped on re-run (no duplicate ingests) and batches are capped', () => {
  const first = planDrain(audit, showsById, { batchSize: 3 });
  assert.equal(first.batch.length, 3);
  assert.ok(first.remaining >= 0);
  const ledger = Object.fromEntries(first.batch.map(b => [ledgerKey(b.showId, b.url), { status: 'ok' }]));
  const second = planDrain(audit, showsById, { batchSize: 10000, ledger });
  const keys = new Set(second.batch.map(b => b.key));
  for (const b of first.batch) assert.ok(!keys.has(b.key), 'already-ingested must not reappear');
  assert.equal(new Set(second.batch.map(b => b.key)).size, second.batch.length, 'no duplicate keys in a plan');
});
