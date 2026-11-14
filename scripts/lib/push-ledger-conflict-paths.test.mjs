// BRO-4688: autostash-conflict rows in the durable ledger must name the files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { buildFailureEntry } = createRequire(import.meta.url)('./push-ledger.js');

const base = { reason: 'autostash-conflict', attempt: 0, maxRetries: 5, branch: 'main', remote: 'r', ts: '2026-11-12T00:00:00Z' };

test('conflictPaths lands in the durable row, one line, valid JSON', () => {
  const row = JSON.parse(buildFailureEntry({ ...base, conflictPaths: 'data/a.json|we"ird\r\x01.json' }));
  assert.equal(row.reason, 'autostash-conflict');
  assert.match(row.conflictPaths, /^data\/a\.json\|/);
  assert.doesNotMatch(row.conflictPaths, /[\x00-\x1f]/);
});

test('rows without conflict paths carry no field', () => {
  assert.equal('conflictPaths' in JSON.parse(buildFailureEntry(base)), false);
});

test('the CLI arg --conflict-paths reaches the durable entry (wiring)', () => {
  const { entryLineFromArgs, parseArgs } = createRequire(import.meta.url)('../record-push-retry-failure.js');
  const row = JSON.parse(entryLineFromArgs(parseArgs(['--reason=autostash-conflict', '--conflict-paths=data/a.json|data/b.json']), {}));
  assert.equal(row.conflictPaths, 'data/a.json|data/b.json');
  assert.equal('conflictPaths' in JSON.parse(entryLineFromArgs(parseArgs(['--reason=x']), {})), false);
});
