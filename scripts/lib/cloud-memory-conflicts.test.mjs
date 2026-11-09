import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applySync } = require('./cloud-memory-merge.js');
const { readConflictDigest } = require('./cloud-memory-conflicts.js');
const { renderNamedDigestBlock } = require('./autonomous-email-render.js');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-conflicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const src = path.join(root, 'memory');
  const dest = path.join(root, 'cloud-memory');
  fs.mkdirSync(src);
  fs.mkdirSync(dest);
  const args = { src, dest, manifestPath: path.join(root, 'manifest.json') };
  const reportPath = path.join(dest, 'sync-conflicts.json');
  const write = (dir, name, text) => fs.writeFileSync(path.join(dir, name), text);
  const conflict = () => {
    write(src, 'memo.md', 'ancestor');
    applySync(args);
    write(src, 'memo.md', 'private local edit');
    write(dest, 'memo.md', 'private mirror edit');
    return applySync(args);
  };
  return { ...args, args, reportPath, write, conflict };
}

test('BRO-2557: a conflict publishes count and paths even when stderr is discarded', t => {
  const f = fixture(t);
  const result = f.conflict();
  const report = JSON.parse(fs.readFileSync(f.reportPath, 'utf8'));
  assert.equal(report.conflictCount, 1);
  assert.deepEqual(report.paths, result.conflictCopies.map(p => path.relative(f.src, p)));
  assert.equal(fs.readFileSync(result.conflictCopies[0], 'utf8'), 'private mirror edit');
  assert.equal(fs.readFileSync(path.join(f.dest, 'memo.md'), 'utf8'), 'private local edit');
  assert.doesNotMatch(JSON.stringify(report), /private (local|mirror) edit/);
});

test('quiet syncs keep unresolved conflicts visible without rewriting the report', t => {
  const f = fixture(t);
  f.conflict();
  const before = fs.readFileSync(f.reportPath, 'utf8');
  const result = applySync({ ...f.args, now: new Date('2030-01-01') });
  assert.equal(result.conflictCopies.length, 0);
  assert.equal(fs.readFileSync(f.reportPath, 'utf8'), before);
  assert.match(readConflictDigest(f.dest).bannerText, /1 saved copy needs review/);
});

test('reviewed copies clear the alert and clean syncs create no report', t => {
  const f = fixture(t);
  applySync(f.args);
  assert.equal(fs.existsSync(f.reportPath), false);
  const { conflictCopies } = f.conflict();
  fs.unlinkSync(conflictCopies[0]);
  applySync(f.args);
  assert.equal(JSON.parse(fs.readFileSync(f.reportPath, 'utf8')).conflictCount, 0);
  assert.equal(readConflictDigest(f.dest), null);
  const before = fs.readFileSync(f.reportPath, 'utf8');
  applySync({ ...f.args, now: new Date('2030-01-01') });
  assert.equal(fs.readFileSync(f.reportPath, 'utf8'), before);
});

test('dry runs never create, refresh or clear the inventory', t => {
  const f = fixture(t);
  f.conflict();
  const before = fs.readFileSync(f.reportPath, 'utf8');
  fs.rmSync(path.join(f.src, '_conflicts'), { recursive: true });
  applySync({ ...f.args, dryRun: true });
  assert.equal(fs.readFileSync(f.reportPath, 'utf8'), before);
  fs.unlinkSync(f.reportPath);
  f.write(f.dest, 'memo.md', 'another mirror edit');
  f.write(f.src, 'memo.md', 'another local edit');
  applySync({ ...f.args, dryRun: true });
  assert.equal(fs.existsSync(f.reportPath), false);
  assert.equal(fs.existsSync(path.join(f.src, '_conflicts')), false);
});

test('inventory backfills existing conflicts, ignores symlinks and never adopts saved copies', t => {
  const f = fixture(t);
  const dir = path.join(f.src, '_conflicts');
  fs.mkdirSync(dir);
  f.write(dir, 'old.cloud-conflict-2026-01-01-0.md', 'older preserved memo');
  f.write(dir, 'scratch.md', 'unrelated note');
  fs.mkdirSync(path.join(dir, 'directory.cloud-conflict-test.md'));
  fs.symlinkSync(path.join(dir, 'scratch.md'), path.join(dir, 'symlink.cloud-conflict-test.md'));
  applySync(f.args);
  const report = JSON.parse(fs.readFileSync(f.reportPath, 'utf8'));
  assert.deepEqual(report.paths, ['_conflicts/old.cloud-conflict-2026-01-01-0.md']);
  assert.deepEqual(fs.readdirSync(f.dest), ['sync-conflicts.json']);
});

test('a later sync failure cannot hide an already preserved conflict', t => {
  const f = fixture(t);
  f.write(f.src, 'memo.md', 'ancestor');
  f.write(f.src, 'deleted.md', 'ancestor');
  applySync(f.args);
  f.write(f.src, 'memo.md', 'local edit');
  f.write(f.dest, 'memo.md', 'mirror edit');
  fs.unlinkSync(path.join(f.src, 'deleted.md'));
  assert.throws(() => applySync({ ...f.args, isTracked: () => { throw new Error('later failure'); } }), /later failure/);
  assert.equal(JSON.parse(fs.readFileSync(f.reportPath, 'utf8')).conflictCount, 1);
});

test('missing and cleared reports are quiet; malformed reports warn instead of vanishing', t => {
  const f = fixture(t);
  assert.equal(readConflictDigest(f.dest), null);
  for (const text of ['{', 'null', '{}', '{"version":1,"conflictCount":0,"paths":["bad"]}',
    '{"version":1,"conflictCount":1,"paths":["_conflicts/../outside.md"]}']) {
    fs.writeFileSync(f.reportPath, text);
    assert.match(readConflictDigest(f.dest).bannerText, /Could not read/);
  }
});

test('digest names unresolved copies, escapes markup and bounds the visible list', t => {
  const f = fixture(t);
  const dir = path.join(f.src, '_conflicts');
  fs.mkdirSync(dir);
  for (const name of ['<unsafe>', 'b', 'c', 'd']) {
    f.write(dir, `${name}.cloud-conflict-old.md`, 'private memo body');
  }
  applySync(f.args);
  const section = readConflictDigest(f.dest);
  assert.match(section.bannerText, /4 saved copies need review/);
  assert.equal(section.items.length, 3);
  assert.equal(section.moreCount, 1);
  const html = renderNamedDigestBlock('Saved memory conflicts', section);
  assert.match(html, /4 saved copies need review/);
  assert.match(html, /_conflicts\/&lt;unsafe&gt;\.cloud-conflict-old.md/);
  assert.match(html, /\+1 more waiting/);
  assert.doesNotMatch(html, /private memo body|<unsafe>/);
});
