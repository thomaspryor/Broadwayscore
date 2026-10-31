// BRO-5510: a red corpus audit must reach the health digest, not only a run page.
// Real function only (CLAUDE.md section 15).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { corpusAuditResults } = require('../../scripts/health-check.js');

test('within-floor duplicate audit and zero squatters are pass rows', () => {
  const r = corpusAuditResults({
    duplicateFlag: { status: 0, output: 'Found 8 live ...\n✅ within floor (8 <= 8)' },
    squatters: { status: 0, output: JSON.stringify({ scanned: 10, count: 0, found: [] }) },
  });
  assert.deepEqual(r.map((x) => x.status), ['pass', 'pass']);
});

test('a regressed duplicate audit warns and quotes the count line', () => {
  const [row] = corpusAuditResults({ duplicateFlag: { status: 1, output: 'Found 12 live duplicate-of-inherited-flag leak(s) (floor: 8).\n::error::regressed' } });
  assert.equal(row.status, 'warn');
  assert.match(row.message, /Found 12 live/);
});

test('squatter candidates are informational (pass row with the count); a failed or unreadable run warns', () => {
  const [found] = corpusAuditResults({ squatters: { status: 0, output: JSON.stringify({ count: 587, found: [] }) } });
  assert.equal(found.status, 'pass');
  assert.match(found.message, /587 candidate/);
  const [bad] = corpusAuditResults({ squatters: { status: 1, output: '::error::corpus not scanned' } });
  assert.equal(bad.status, 'warn');
  const [garbled] = corpusAuditResults({ squatters: { status: 0, output: 'not json' } });
  assert.equal(garbled.status, 'warn');
});

test('no runs, no rows', () => {
  assert.deepEqual(corpusAuditResults({}), []);
  assert.deepEqual(corpusAuditResults(null), []);
});
