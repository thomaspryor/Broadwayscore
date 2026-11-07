// BRO-6690: audit-wet-archive-market.js --delete removes only non-london-show archives and only on a matching --expect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'audit-wet-archive-market.js');
const shows = JSON.parse(fs.readFileSync(path.join(path.dirname(script), '..', 'data', 'shows.json'), 'utf8')).shows;
const nyc = shows.find((s) => (s.category || 'broadway') === 'broadway').id;
const reg = shows.find((s) => s.category === 'regional').id;
const we = shows.find((s) => s.category === 'west-end' && !s.openingDate).id; // no opening date: no post-predates-run

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wet-del-'));
  fs.writeFileSync(path.join(dir, `${nyc}.json`), JSON.stringify({ postDate: '2020-01-01', reviews: [] }));
  fs.writeFileSync(path.join(dir, `${we}.json`), JSON.stringify({ reviews: [] }));
  fs.writeFileSync(path.join(dir, `${reg}.json`), JSON.stringify({ reviews: [] }));
  return dir;
}
const run = (dir, ...a) => spawnSync(process.execPath, [script, `--archive-dir=${dir}`, ...a], { encoding: 'utf8' });

test('--delete with a wrong --expect deletes nothing and exits 2', () => {
  const dir = fixture();
  const r = run(dir, '--delete', '--expect=5');
  assert.equal(r.status, 2);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${nyc}.json`, `${we}.json`, `${reg}.json`].sort());
});
test('--delete without --expect deletes nothing', () => {
  const dir = fixture();
  assert.equal(run(dir, '--delete').status, 2);
  assert.equal(fs.readdirSync(dir).length, 3);
});
test('--delete --expect=1 removes the Broadway archive and keeps the West End and regional ones', () => {
  const dir = fixture();
  const r = run(dir, '--delete', '--expect=1');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(dir).sort(), [`${we}.json`, `${reg}.json`].sort());
});
