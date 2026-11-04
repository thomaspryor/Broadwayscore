/**
 * BRO-6988: _appendLedgerLine must not read + sort + rewrite the whole spend
 * ledger on every call. A CPU profile of the opening-night lane showed that
 * per-fetch rewrite (44MB ledger) behind every 3-4s event-loop freeze.
 * Contract: one full trim on a process's first append to a path, then plain
 * appends, then a full trim again every TRIM_EVERY_APPENDS appends. No row lost.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LEDGER = path.join(os.tmpdir(), `provider-telemetry-append-trim-${process.pid}.jsonl`);
process.env.SCRAPER_SPEND_LEDGER_PATH = LEDGER;

const require = createRequire(import.meta.url);
const telemetry = require('../../scripts/lib/provider-telemetry.js');
const { recordBdCall, TRIM_EVERY_APPENDS, _resetLedgerTrimStateForTests } = telemetry;

function quiet(fn) {
  const orig = console.log;
  console.log = () => {};
  try { fn(); } finally { console.log = orig; }
}

function countLedgerReads(fn) {
  const orig = fs.readFileSync;
  let reads = 0;
  fs.readFileSync = function (p, ...rest) {
    if (p === LEDGER) reads++;
    return orig.call(this, p, ...rest);
  };
  try { fn(); } finally { fs.readFileSync = orig; }
  return reads;
}

const rows = () => fs.readFileSync(LEDGER, 'utf8').split('\n').filter(Boolean);

test('appends trim once, then every TRIM_EVERY_APPENDS calls, and keep every row', () => {
  assert.equal(TRIM_EVERY_APPENDS, 1000);
  _resetLedgerTrimStateForTests();
  // Seed without a trailing newline: the first (full) write must repair it so
  // later plain appends never glue two rows together.
  fs.writeFileSync(LEDGER, `{"ts":"2026-11-01T00:00:00.000Z","seed":1}\n{"ts":"2026-11-01T00:00:01.000Z","seed":2}`);
  try {
    let reads = countLedgerReads(() => quiet(() => recordBdCall({ host: 'a.example', success: true })));
    assert.equal(reads, 1, 'first append in the process does the full trim');
    assert.ok(fs.readFileSync(LEDGER, 'utf8').endsWith('\n'));
    assert.equal(rows().length, 3);

    reads = countLedgerReads(() => quiet(() => {
      for (let i = 0; i < TRIM_EVERY_APPENDS; i++) recordBdCall({ host: `b${i}.example`, success: true });
    }));
    assert.equal(reads, 0, 'the next TRIM_EVERY_APPENDS appends never read the ledger');
    assert.equal(rows().length, 3 + TRIM_EVERY_APPENDS);
    for (const r of rows()) JSON.parse(r); // no glued rows

    reads = countLedgerReads(() => quiet(() => recordBdCall({ host: 'c.example', success: true })));
    assert.equal(reads, 1, 'the append after that re-trims');
    assert.equal(rows().length, 4 + TRIM_EVERY_APPENDS);
  } finally {
    try { fs.unlinkSync(LEDGER); } catch { /* already gone */ }
  }
});

test('a ledger deleted mid-run is recreated by the next append', () => {
  _resetLedgerTrimStateForTests();
  quiet(() => recordBdCall({ host: 'd.example', success: true }));
  fs.unlinkSync(LEDGER);
  quiet(() => recordBdCall({ host: 'e.example', success: true }));
  assert.equal(rows().length, 1);
  fs.unlinkSync(LEDGER);
});
