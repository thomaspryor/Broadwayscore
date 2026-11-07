// BRO-5403: end-to-end check of the CLI the weekly sweep runs. Covered pending
// entries are pruned with --apply, differing figures stay for review, and
// commercial.json is never written. Rules themselves: lib/pending-commercial-reconcile.test.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reconcile-pending-commercial.js');
const src = [{ type: 'trade', url: 'https://x.test/a' }];

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-pending-'));
  const write = (f, o) => fs.writeFileSync(path.join(dir, f), JSON.stringify(o, null, 2));
  write('shows.json', { shows: [
    { id: 'a', slug: 'a', status: 'open' },
    { id: 'c', slug: 'c', status: 'closed' },
  ] });
  write('commercial.json', { shows: {
    a: { capitalization: 10, designation: 'TBD', recouped: false, sources: src },
    c: { capitalization: 8, designation: 'TBD', recouped: false, sources: src },
  } });
  write('commercial-pending-review.json', { lastUpdated: 'old', shows: {
    a: { capitalization: 10, designation: 'TBD', recouped: false },
    c: { capitalization: 9, designation: 'TBD' },
    unsourced: { designation: 'TBD' },
  } });
  return dir;
}
const run = (dir, ...args) => spawnSync(process.execPath, [CLI, `--data-dir=${dir}`, ...args], { encoding: 'utf8' });
const read = (dir, f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));

test('report mode lists the covered entry and writes nothing', () => {
  const dir = fixture();
  const before = fs.readFileSync(path.join(dir, 'commercial-pending-review.json'), 'utf8');
  const r = run(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /covered 1, still pending 2/);
  assert.match(r.stdout, /drop a\b/);
  assert.equal(fs.readFileSync(path.join(dir, 'commercial-pending-review.json'), 'utf8'), before);
});

test('--apply prunes the covered entry, keeps differing and unsourced ones, leaves commercial.json alone', () => {
  const dir = fixture();
  const commercialBefore = fs.readFileSync(path.join(dir, 'commercial.json'), 'utf8');
  const r = run(dir, '--apply');
  assert.equal(r.status, 0, r.stderr);
  const pending = read(dir, 'commercial-pending-review.json');
  assert.deepEqual(Object.keys(pending.shows).sort(), ['c', 'unsourced']);
  assert.notEqual(pending.lastUpdated, 'old');
  assert.deepEqual(pending.shows.c, { capitalization: 9, designation: 'TBD' });
  assert.equal(fs.readFileSync(path.join(dir, 'commercial.json'), 'utf8'), commercialBefore);
});

test('a second --apply is a no-op (idempotent for the weekly sweep)', () => {
  const dir = fixture();
  run(dir, '--apply');
  const r = run(dir, '--apply');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /covered 0/);
  assert.doesNotMatch(r.stdout, /wrote /);
  assert.deepEqual(Object.keys(read(dir, 'commercial-pending-review.json').shows).sort(), ['c', 'unsourced']);
});
