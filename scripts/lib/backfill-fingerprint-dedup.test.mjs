import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { applyFingerprintDuplicate } = require('./backfill-fingerprint-dedup');

test('weekly backfill cannot point the canonical at its already-marked loser', () => {
  for (const field of ['duplicateOf', 'duplicateTextOf']) {
    const canonical = { duplicateOf: null };
    const loser = { [field]: 'wsj--terry-teachout.json' };
    const result = applyFingerprintDuplicate(canonical, 'wsj--terry-teachout.json',
      'wsj--charles-isherwood.json', () => loser);
    assert.deepEqual(result, { changed: false, target: null });
    assert.deepEqual(canonical, { duplicateOf: null });
  }
});

test('mixed-field chains and existing cyclic owners are refused', () => {
  const siblings = {
    'loser.json': { duplicateOf: 'middle.json' },
    'middle.json': { duplicateTextOf: 'canonical.json' },
  };
  const data = {};
  const load = (name) => siblings[name];
  assert.equal(applyFingerprintDuplicate(data, 'canonical.json', 'loser.json', load).changed, false);
  siblings['middle.json'].duplicateTextOf = 'loser.json';
  assert.equal(applyFingerprintDuplicate(data, 'canonical.json', 'loser.json', load).changed, false);
  assert.deepEqual(data, {});
});

test('ordinary one-way duplicates still get marked and are idempotent', () => {
  const data = {};
  const load = () => ({ fullText: 'original review' });
  assert.deepEqual(applyFingerprintDuplicate(data, 'copy.json', 'original.json', load),
    { changed: true, target: 'original.json' });
  assert.equal(data.duplicateTextOf, 'original.json');
  assert.deepEqual(applyFingerprintDuplicate(data, 'copy.json', 'original.json', load),
    { changed: false, target: 'original.json' });
});

test('intentional clears survive both assigning and clearing a fingerprint pointer', () => {
  for (const field of ['duplicateTextOfCleared', '_duplicateOfCleared']) {
    const data = { [field]: true, duplicateTextOf: 'syndicated.json' };
    const before = structuredClone(data);
    for (const owner of ['other.json', 'self.json', undefined]) {
      assert.equal(applyFingerprintDuplicate(data, 'self.json', owner, () => ({})).changed, false);
      assert.deepEqual(data, before);
    }
  }
});

test('the fingerprint owner still clears an unreviewed stale text pointer by deletion', () => {
  const data = { duplicateTextOf: 'old.json', duplicateOf: null };
  assert.deepEqual(applyFingerprintDuplicate(data, 'self.json', 'self.json', () => null),
    { changed: true, target: null });
  assert.deepEqual(data, { duplicateOf: null });
});

test('the real backfill CLI preserves a healed cluster on repeated runs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro4188-backfill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'anastasia-2017');
  fs.mkdirSync(dir);
  const canonical = 'wsj--terry-teachout.json';
  const loser = 'wsj--charles-isherwood.json';
  const fullText = 'Anastasia is a musical about memory, identity and family. '.repeat(30);
  for (const [file, criticName, duplicateOf] of [
    [loser, 'Charles Isherwood', canonical],
    [canonical, 'Terry Teachout', null],
  ]) {
    fs.writeFileSync(path.join(dir, file), JSON.stringify({
      showId: 'anastasia-2017', outletId: 'wsj', outlet: 'Wall Street Journal',
      criticName, fullText, duplicateOf,
    }));
  }
  const script = fileURLToPath(new URL('../backfill-review-flags.js', import.meta.url));
  for (let run = 0; run < 2; run++) {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, REVIEW_TEXTS_DIR: root }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const winner = JSON.parse(fs.readFileSync(path.join(dir, canonical), 'utf8'));
    const copy = JSON.parse(fs.readFileSync(path.join(dir, loser), 'utf8'));
    assert.equal(winner.duplicateOf, null);
    assert.equal(Object.hasOwn(winner, 'duplicateTextOf'), false);
    assert.equal(copy.duplicateOf, canonical);
  }
});
