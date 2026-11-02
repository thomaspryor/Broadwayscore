// BRO-6687: whole-entry keyed merge of gap-audit-checkpoint.json.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeKeyedEntries, main } = require('./checkpoint-keyed-merge.js');

const e = (at, extra = {}) => ({ at, gaps: 0, uncollected: 0, ...extra });

test('one-sided adds, edits and deletes all survive', () => {
  const base = { a: e('2026-11-01T00:00:00Z'), gone: e('2026-11-01T00:00:00Z') };
  const ours = { a: e('2026-11-01T00:00:00Z'), gone: e('2026-11-01T00:00:00Z'), o: e('2026-11-01T01:00:00Z') };
  const theirs = { a: e('2026-11-01T02:00:00Z'), t: e('2026-11-01T03:00:00Z') };
  assert.deepEqual(mergeKeyedEntries(base, ours, theirs), { a: theirs.a, o: ours.o, t: theirs.t });
});

test('both sides rewrote one show: the newer `at` wins the whole entry, fields are never mixed', () => {
  const newer = e('2026-11-01T15:23:43.244Z', { uncollected: 1, slowMarketResidual: 0 });
  const older = e('2026-11-01T15:10:00.000Z', { uncollected: 2, zeroChar: 3 });
  const base = { s: e('2026-10-01T00:00:00Z') };
  for (const prefer of ['ours', 'theirs']) {
    assert.deepEqual(mergeKeyedEntries(base, { s: newer }, { s: older }, { prefer }).s, newer);
    assert.deepEqual(mergeKeyedEntries(base, { s: older }, { s: newer }, { prefer }).s, newer);
  }
});

test('a tie on `at` (or no `at`) goes to the preferred side; a one-sided delete loses to an edit', () => {
  const a = e('2026-11-01T00:00:00Z', { gaps: 1 });
  const b = e('2026-11-01T00:00:00Z', { gaps: 2 });
  const base = { s: e('2026-10-01T00:00:00Z'), d: e('2026-10-01T00:00:00Z') };
  assert.deepEqual(mergeKeyedEntries(base, { s: a }, { s: b }, { prefer: 'ours' }).s, a);
  assert.deepEqual(mergeKeyedEntries(base, { s: a }, { s: b }, { prefer: 'theirs' }).s, b);
  assert.deepEqual(mergeKeyedEntries(base, { d: a }, {}).d, a);
});

test('CLI writes the merge into <cur> in its layout, and refuses non-objects without writing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckm-'));
  try {
    const w = (n, v) => { const p = path.join(dir, n); fs.writeFileSync(p, typeof v === 'string' ? v : JSON.stringify(v, null, 2) + '\n'); return p; };
    const base = w('base', { x: e('2026-10-01T00:00:00Z') });
    const cur = w('cur', { x: e('2026-10-01T00:00:00Z'), a: e('2026-11-01T00:00:00Z') });
    const other = w('other', { x: e('2026-11-02T00:00:00Z'), b: e('2026-11-02T00:00:00Z') });
    assert.equal(main(['theirs', base, cur, other]), 0);
    const text = fs.readFileSync(cur, 'utf8');
    assert.ok(text.startsWith('{\n  "x"') && text.endsWith('}\n'));
    assert.deepEqual(Object.keys(JSON.parse(text)), ['x', 'a', 'b']);
    const bad = w('bad', '[1,2]\n');
    const before = fs.readFileSync(bad, 'utf8');
    assert.equal(main(['theirs', base, bad, other]), 1);
    assert.equal(fs.readFileSync(bad, 'utf8'), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
