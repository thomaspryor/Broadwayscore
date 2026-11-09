/**
 * Shared vacuous-corpus guard for scripts/audit-*.js (task #1063).
 *
 * Requires the REAL function (CLAUDE.md §15) — a change to the throw/no-op
 * contract in scripts/lib/corpus-scan-guard.js fails this, not a copy here.
 */

import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertCorpusScanned, assertReviewTextCorpus, CorpusNotScannedError } = require('../../scripts/lib/corpus-scan-guard.js');

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

// BRO-2283: a missing/unreadable corpus ROOT is a different failure from a
// filtered scan finding nothing, and must throw even in report mode (no
// --gate) — otherwise a session whose worktree lacks the private review-texts
// checkout gets a silent "0 scanned, 0 found" that reads as a clean sweep.
test('corpusRootMissing throws even when gate is off', () => {
  assert.throws(
    () => assertCorpusScanned(0, { gate: false, corpusRootMissing: true }),
    CorpusNotScannedError,
  );
  assert.throws(
    () => assertCorpusScanned(0, { corpusRootMissing: true }),
    CorpusNotScannedError,
  );
});

test('corpusRootMissing error explains the checkout is missing, not just empty', () => {
  assert.throws(
    () => assertCorpusScanned(0, { corpusRootMissing: true, label: 'data/review-texts' }),
    (err) => {
      assert.ok(err instanceof CorpusNotScannedError);
      assert.match(err.message, /does not exist or is unreadable/);
      assert.match(err.message, /data\/review-texts/);
      return true;
    },
  );
});

test('corpusRootMissing is ignored when false, even with gate on and zero scanned needing the normal path', () => {
  // Sanity: corpusRootMissing:false with a positive count is still a no-op —
  // the new param must not change the established gate/scanned contract.
  assert.doesNotThrow(() => assertCorpusScanned(5, { gate: true, corpusRootMissing: false }));
});

test('BRO-7193: preflight requires review files, not metadata or holding folders', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-preflight-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const corpus = path.join(root, 'review-texts');
  assert.throws(() => assertReviewTextCorpus(corpus), CorpusNotScannedError);
  fs.mkdirSync(corpus);
  assert.throws(() => assertReviewTextCorpus(corpus), CorpusNotScannedError);
  for (const dir of ['_pending', '.git', 'alpha']) fs.mkdirSync(path.join(corpus, dir));
  fs.writeFileSync(path.join(corpus, '_pending', 'review.json'), '{}');
  fs.writeFileSync(path.join(corpus, '.git', 'config.json'), '{}');
  fs.writeFileSync(path.join(corpus, 'alpha', '_blocklist.json'), '{}');
  fs.writeFileSync(path.join(corpus, 'alpha', 'failed-fetches.json'), '{}');
  fs.mkdirSync(path.join(corpus, 'alpha', 'directory.json'));
  assert.throws(() => assertReviewTextCorpus(corpus), CorpusNotScannedError);
  // Invalid JSON belongs to the validator's drift findings, not missing input.
  fs.writeFileSync(path.join(corpus, 'alpha', 'review.json'), '{');
  assert.doesNotThrow(() => assertReviewTextCorpus(corpus));
  assert.throws(() => assertReviewTextCorpus(path.join(corpus, 'alpha', 'review.json')), CorpusNotScannedError);
});
