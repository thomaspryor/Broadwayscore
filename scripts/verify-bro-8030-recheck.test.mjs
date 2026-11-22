// BRO-8030 RECHECK-AFTER probe. Since 2026-11-22 a landing whose only overlap with main or
// with other landings is a session record file takes the small re-check, on the promise that
// the combined file still reads correctly. This reads the two real files after days of real
// landings: every line must still read cleanly (the same function the Land job asks), no row
// may have been lost, and both files must have kept growing. Skipped until the date below.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ledgerFileParses } = require('./lib/land-branch.js');

const CHECKABLE_FROM = Date.parse('2026-11-25T00:00:00Z');
// Row counts on main at 8b5985dcb, the commit that turned the small re-check on for these files.
const AT_LANDING = { 'data/audit/session-retro.jsonl': 235, 'data/audit/claude-session-cost.jsonl': 233 };
const MIN_NEW_ROWS = 5;

test('BRO-8030: the session record files still read cleanly after real landings merged rows into them',
  { skip: Date.now() < CHECKABLE_FROM && 'skip until 2026-11-25' }, () => {
    for (const [file, before] of Object.entries(AT_LANDING)) {
      const abs = new URL(`../${file}`, import.meta.url);
      assert.equal(ledgerFileParses(abs.pathname), true, `${file} has a line that does not read as one JSON object`);
      const rows = fs.readFileSync(abs, 'utf8').split('\n').filter((l) => l.trim());
      console.log(`${file}: ${rows.length} rows (${before} when the change landed)`);
      assert.ok(rows.length >= before + MIN_NEW_ROWS, `${file} has ${rows.length} rows, expected at least ${before + MIN_NEW_ROWS}: rows lost, or no landing added one`);
    }
  });
