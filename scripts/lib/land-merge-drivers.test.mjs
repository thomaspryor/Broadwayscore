// BRO-7631 class guard: every custom merge driver .gitattributes names must be registered for land.yml's rebases,
// and a real git rebase with those drivers must resolve what an undriven rebase conflicts on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const LIB = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(LIB, '../..');
const { driverConfigArgs, DRIVER_NAMES, DRIVER_FILES } = require('./land-merge-drivers.js');
const { mergeKeyed } = require('./merge-keyed-jsonl.js');

const BUILTIN = new Set(['union', 'binary', 'text', 'set', 'unset', 'unspecified']);

test('every custom merge=<driver> in .gitattributes is registered by land-merge-drivers.js', () => {
  const names = new Set();
  for (const l of fs.readFileSync(path.join(ROOT, '.gitattributes'), 'utf8').split('\n')) {
    if (/^\s*#/.test(l)) continue;
    const m = l.match(/\bmerge=(\S+)/);
    if (m && !BUILTIN.has(m[1])) names.add(m[1]);
  }
  assert.ok(names.size >= 2, 'expected ours and keyed-jsonl');
  for (const n of names) assert.ok(DRIVER_NAMES.includes(n), `.gitattributes uses merge=${n} but land rebases register no such driver (a CI runner defines none, so git text-merges silently)`);
});

test('driver files exist beside the module and land rebases pass the args', () => {
  for (const f of DRIVER_FILES) assert.ok(fs.existsSync(path.join(LIB, f)), f);
  const rebase = fs.readFileSync(path.join(LIB, 'land-rebase.sh'), 'utf8');
  const branch = fs.readFileSync(path.join(LIB, 'land-branch.js'), 'utf8');
  assert.match(rebase, /git \$\{CARGS\[@\]\+"\$\{CARGS\[@\]\}"\} rebase "\$BASE"/);
  assert.match(rebase, /rebase --continue/);
  assert.equal((branch.match(/driverConfigArgs\(__dirname\)/g) || []).length, 2, 'rebaseOnto and its --continue');
});

test('kill switch returns no args', () => {
  assert.deepEqual(driverConfigArgs('/x', { LAND_MERGE_DRIVERS_DISABLED: 'true' }), []);
  assert.equal(driverConfigArgs('/x', {}).length, DRIVER_NAMES.length * 2);
});

test('mergeKeyed: both sides add rows, upsert wins, deletes and keyless lines survive', () => {
  const j = (d, s, c) => JSON.stringify({ date: d, session: s, cost: c });
  const f = ['date', 'session'];
  const base = [j('d1', 'a', 1), j('d1', 'b', 1)].join('\n') + '\n';
  const ours = base + j('d2', 'c', 5) + '\n';
  const theirs = [j('d1', 'a', 9), j('d1', 'b', 1), j('d3', 'e', 2), 'not json'].join('\n') + '\n';
  const out = mergeKeyed(base, ours, theirs, f).trim().split('\n');
  assert.deepEqual(out, [j('d1', 'a', 9), j('d1', 'b', 1), j('d2', 'c', 5), j('d3', 'e', 2), 'not json']);
  // theirs deletes a row ours left alone -> gone; ours deletes a row theirs left alone -> gone.
  assert.equal(mergeKeyed(base, base, j('d1', 'a', 1) + '\n', f), j('d1', 'a', 1) + '\n');
  assert.equal(mergeKeyed(base, j('d1', 'b', 1) + '\n', base, f), j('d1', 'b', 1) + '\n');
  // both changed the same key: the replayed commit (theirs) wins, no duplicate.
  const both = mergeKeyed(base, [j('d1', 'a', 2), j('d1', 'b', 1)].join('\n') + '\n', [j('d1', 'a', 3), j('d1', 'b', 1)].join('\n') + '\n', f);
  assert.equal(both.split('\n').filter((l) => l.includes('"a"')).length, 1);
  assert.match(both, /"cost":3/);
});

function repoWithDrivers() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'land-drivers-'));
  const git = (...a) => execFileSync('git', a, { cwd: d, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 't@t'); git('config', 'user.name', 't');
  fs.writeFileSync(path.join(d, '.gitattributes'),
    'cost.jsonl merge=keyed-jsonl keyed-jsonl=date,session\nregen.json merge=ours autostash=regenerated\nflags.ts merge=ours\n');
  const row = (s, c) => JSON.stringify({ date: 'd', session: s, cost: c }) + '\n';
  fs.writeFileSync(path.join(d, 'cost.jsonl'), row('a', 1));
  fs.writeFileSync(path.join(d, 'regen.json'), '{"v":1,"pad":[1,2,3]}\n');
  fs.writeFileSync(path.join(d, 'flags.ts'), 'export const A = false;\nexport const B = false;\n');
  git('add', '-A'); git('commit', '-qm', 'base');
  git('checkout', '-qb', 'branch');
  fs.appendFileSync(path.join(d, 'cost.jsonl'), row('branch', 2));
  fs.writeFileSync(path.join(d, 'regen.json'), '{"v":2,"pad":[1,2,3]}\n');
  fs.writeFileSync(path.join(d, 'flags.ts'), 'export const A = true;\nexport const B = false;\n');
  git('commit', '-qam', 'branch');
  git('checkout', '-q', 'main');
  fs.appendFileSync(path.join(d, 'cost.jsonl'), row('main', 3));
  fs.writeFileSync(path.join(d, 'regen.json'), '{"v":3,"pad":[1,2,3]}\n');
  fs.writeFileSync(path.join(d, 'flags.ts'), 'export const A = false;\nexport const B = true;\n');
  git('commit', '-qam', 'main moved');
  git('checkout', '-q', 'branch');
  return { d, git };
}

function rebase(d, args) {
  return spawnSync('git', [...args, 'rebase', 'main'], { cwd: d, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
}

test('real rebase: undriven conflicts; driven resolves ledger + regenerated file, still conflicts on hand-edited flags.ts', () => {
  const a = repoWithDrivers();
  const un = rebase(a.d, []);
  assert.notEqual(un.status, 0, 'undriven rebase must conflict (that is the bug)');
  assert.match(a.git('diff', '--name-only', '--diff-filter=U'), /cost\.jsonl/);

  const b = repoWithDrivers();
  const dr = rebase(b.d, driverConfigArgs(LIB));
  assert.notEqual(dr.status, 0, 'flags.ts is hand-edited merge=ours, not regenerated: must still conflict, never silently dropped');
  const unmerged = b.git('diff', '--name-only', '--diff-filter=U').trim().split('\n');
  assert.deepEqual(unmerged, ['flags.ts'], `only flags.ts may remain conflicted, got ${unmerged}`);
  assert.equal(fs.readFileSync(path.join(b.d, 'regen.json'), 'utf8'), '{"v":3,"pad":[1,2,3]}\n', 'regenerated file keeps main whole');
  const rows = fs.readFileSync(path.join(b.d, 'cost.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l).session);
  assert.deepEqual(rows.sort(), ['a', 'branch', 'main']);
});

test('real rebase: -c args must be re-passed on --continue', () => {
  const { d, git } = repoWithDrivers();
  const args = driverConfigArgs(LIB);
  rebase(d, args);
  fs.writeFileSync(path.join(d, 'flags.ts'), 'export const A = true;\nexport const B = true;\n');
  git('add', 'flags.ts');
  const c = spawnSync('git', [...args, 'rebase', '--continue'], { cwd: d, encoding: 'utf8', env: { ...process.env, GIT_EDITOR: 'true' } });
  assert.equal(c.status, 0, c.stderr);
  assert.equal(git('status', '--porcelain').trim(), '');
});
