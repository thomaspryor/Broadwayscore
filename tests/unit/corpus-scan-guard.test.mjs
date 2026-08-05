/**
 * Shared vacuous-corpus guard for scripts/audit-*.js (task #1063).
 *
 * Requires the REAL function (CLAUDE.md §15) — a change to the throw/no-op
 * contract in scripts/lib/corpus-scan-guard.js fails this, not a copy here.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertCorpusScanned, CorpusNotScannedError } = require('../../scripts/lib/corpus-scan-guard.js');

test('throws when gate is on and nothing was scanned', () => {
  assert.throws(
    () => assertCorpusScanned(0, { gate: true }),
    CorpusNotScannedError,
  );
});

test('the thrown error names the missing corpus so the fix is obvious', () => {
  assert.throws(
    () => assertCorpusScanned(0, { gate: true }),
    (err) => {
      assert.ok(err instanceof CorpusNotScannedError);
      assert.match(err.message, /scanned 0 review files/);
      assert.match(err.message, /data\/review-texts/);
      return true;
    },
  );
});

test('label overrides the default corpus name in the message', () => {
  assert.throws(
    () => assertCorpusScanned(0, { gate: true, label: 'data/other-corpus' }),
    (err) => {
      assert.match(err.message, /data\/other-corpus/);
      return true;
    },
  );
});

test('is a no-op when a positive count was scanned', () => {
  assert.doesNotThrow(() => assertCorpusScanned(1, { gate: true }));
  assert.doesNotThrow(() => assertCorpusScanned(751, { gate: true }));
});

test('is a no-op when gate is off, even with a zero count', () => {
  assert.doesNotThrow(() => assertCorpusScanned(0, { gate: false }));
  assert.doesNotThrow(() => assertCorpusScanned(0, {}));
  assert.doesNotThrow(() => assertCorpusScanned(0));
});
