// BRO-7324 step B: GAUNTLET_SHARD slices + land-gauntlet-merge.js joins them
// into one result dir that land-gate-delta.js reads like a single-runner run.
// node --test scripts/lib/land-gauntlet-merge.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { mergeGauntletDirs, parseShard, mergedExit } = require('./land-gauntlet-merge.js');
const { GATES, readGateResult, readShardEntry, decideAllGates, shardPart } = require('./land-gate-delta.js');

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const judge = (base, branch) => { const gates = decideAllGates({ base, branch }); return { gates, verdict: gates.every((g) => g.verdict === 'pass') ? 'pass' : 'fail' }; };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bro7324-merge-'));
const TAP = (n, fail = 0) => `TAP version 13\n${fail ? 'not ok 1 - a.test.js\n' : 'ok 1 - a.test.js\n'}1..1\n# tests ${n}\n# pass ${n - fail}\n# fail ${fail}\n`;

// One runner's dir: meta + each listed gate's .exit/.log/.files/.secs.
function part(dir, shard, gates, { tree = 'T1', sha = 'S1', root = '/r', files = ['a.test.js', 'b.test.js'], exits = {}, logs = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const g of gates) {
    const exit = exits[g] ?? 0;
    fs.writeFileSync(path.join(dir, `${g}.exit`), `${exit}\n`);
    fs.writeFileSync(path.join(dir, `${g}.log`), logs[g] ?? (g.startsWith('unit-tests') || g === 'scripts-lib-tests' ? TAP(3, exit === 1 ? 1 : 0) : 'ok\n'));
    fs.writeFileSync(path.join(dir, `${g}.files`), `${files.join('\n')}\n`);
    fs.writeFileSync(path.join(dir, `${g}.secs`), '10\n');
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ sha, root, tree, shard, wallMs: 1000, gates }));
  return dir;
}
const A_GATES = ['tsc', 'tsc-llm-scoring', 'next-lint', 'unit-tests-node', 'unit-tests-e2e'];
const B_GATES = ['unit-tests-node', 'unit-tests-tsx', 'scripts-lib-tests', 'bash-integration', 'toplevel-regression', 'lint-workflows'];
function pair(opts = {}) {
  const d = tmp();
  const a = part(path.join(d, 'a'), '1/2', A_GATES, opts.a);
  const b = part(path.join(d, 'b'), '2/2', B_GATES, opts.b);
  return { a, b };
}

test('parseShard / mergedExit', () => {
  assert.deepEqual(parseShard('2/2'), { k: 2, n: 2 });
  for (const bad of ['1/1', '0/2', '3/2', '1/17', 'x', '', null, '01/2', '99999999999999999999/2']) assert.equal(parseShard(bad), null, String(bad));
  assert.equal(mergedExit([{ exit: 0 }, { exit: 0 }]), 0);
  assert.equal(mergedExit([{ exit: 0 }, { exit: 1 }]), 1);
  assert.equal(mergedExit([{ exit: 0 }, null]), 1);
  assert.equal(mergedExit([{ exit: 137 }, { exit: 0 }]), 137);
});

test('a clean pair merges into a dir every gate of which the delta reads as complete and green', () => {
  const { a, b } = pair();
  fs.writeFileSync(path.join(b, 'tsc-tree-status'), 'from-b\n'); // b did not run tsc: must not travel
  fs.writeFileSync(path.join(a, 'tsc-tree-status'), 'from-a\n');
  const r = mergeGauntletDirs(a, b);
  assert.equal(r.ok, true, r.problems.join('; '));
  const meta = JSON.parse(fs.readFileSync(path.join(a, 'meta.json'), 'utf8'));
  assert.equal(meta.sharded, true);
  assert.equal(meta.shard, undefined);
  assert.deepEqual([...meta.gates].sort(), [...GATES].sort(), 'merged meta covers every gate');
  for (const g of GATES) {
    const res = readGateResult(a, g);
    assert.ok(res && res.shards && !res.shards.invalid, `${g} has a manifest`);
    assert.equal(res.exit, 0, g);
  }
  const node = JSON.parse(fs.readFileSync(path.join(a, 'unit-tests-node.shards.json'), 'utf8'));
  assert.deepEqual(node.expected, ['1/2', '2/2']);
  assert.equal((fs.readFileSync(path.join(a, 'unit-tests-node.log'), 'utf8').match(/^# tests \d+\s*$/mg) || []).length, 2);
  assert.equal(fs.readFileSync(path.join(a, 'tsc-tree-status'), 'utf8'), 'from-a\n');
  // The verdict over merged branch + merged base: all green, no refusal.
  const { a: ba, b: bb } = pair();
  assert.equal(mergeGauntletDirs(ba, bb).ok, true);
  const all = judge(ba, a);
  assert.equal(all.verdict, 'pass', JSON.stringify(all.gates.filter((x) => x.verdict !== 'pass')));
});

test('the delta CLI passes a merged pair and refuses when part 2 of the node batch is lost', () => {
  const { a, b } = pair(); const { a: ba, b: bb } = pair();
  mergeGauntletDirs(a, b); mergeGauntletDirs(ba, bb);
  const cli = (base, branch) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/lib/land-gate-delta.js'), '--base-dir', base, '--branch-dir', branch], { encoding: 'utf8' });
  assert.equal(cli(ba, a).status, 0);
  const lost = pair(); fs.rmSync(path.join(lost.b, 'unit-tests-node.exit'));
  assert.equal(mergeGauntletDirs(lost.a, lost.b).ok, true, 'a lost part is the verdict\'s to refuse, not the merge\'s');
  const out = cli(ba, lost.a);
  assert.equal(out.status, 1, out.stdout + out.stderr);
  assert.match(out.stdout + out.stderr, /shard-incomplete|split run is incomplete/);
});

test('a red part makes the merged exit red, and a gate tsc ran on B carries B\'s tree status', () => {
  const d = tmp();
  const a = part(path.join(d, 'a'), '1/2', ['unit-tests-node'], { exits: { 'unit-tests-node': 0 } });
  const b = part(path.join(d, 'b'), '2/2', GATES.filter((g) => g !== 'unit-tests-node').concat('unit-tests-node'), { exits: { 'unit-tests-node': 1 } });
  fs.writeFileSync(path.join(a, 'tsc-tree-status'), 'stale-a\n');
  fs.writeFileSync(path.join(b, 'tsc-tree-status'), 'from-b\n');
  assert.equal(mergeGauntletDirs(a, b).ok, true);
  assert.equal(fs.readFileSync(path.join(a, 'unit-tests-node.exit'), 'utf8').trim(), '1');
  assert.equal(fs.readFileSync(path.join(a, 'tsc-tree-status'), 'utf8'), 'from-b\n');
});

test('two rebases of one tree: different commit shas, same tree, merge (partSha keeps both)', () => {
  const { a, b } = pair({ b: { sha: 'S2' } });
  assert.equal(mergeGauntletDirs(a, b).ok, true);
  const meta = JSON.parse(fs.readFileSync(path.join(a, 'meta.json'), 'utf8'));
  assert.deepEqual(meta.partSha, { '1/2': 'S1', '2/2': 'S2' });
  assert.equal(meta.sha, 'S1');
});

test('merge-level refusals: tree or root differ, or tree missing; same part twice; a lone part; parts sliced different lists', () => {
  for (const [k, v] of [['tree', 'T2'], ['root', '/other'], ['tree', '']]) {
    const { a, b } = pair({ b: { [k]: v } });
    const r = mergeGauntletDirs(a, b);
    assert.equal(r.ok, false, k);
    assert.match(r.problems.join(' '), new RegExp(`differ in ${k}`));
    assert.equal(JSON.parse(fs.readFileSync(path.join(a, 'meta.json'), 'utf8')).sharded, true, 'marked before refusing');
  }
  const d = tmp();
  const a = part(path.join(d, 'a'), '1/2', A_GATES); const b = part(path.join(d, 'b'), '1/2', B_GATES);
  assert.equal(mergeGauntletDirs(a, b).ok, false);
  const { a: la, b: lb } = pair({ b: { files: ['a.test.js', 'c.test.js'] } });
  const r = mergeGauntletDirs(la, lb);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /sliced different file lists/);
});

test('a refused merge, or a part never merged, is refused by the verdict (fail closed)', () => {
  const { a, b } = pair({ b: { tree: 'T2' } });
  assert.equal(mergeGauntletDirs(a, b).ok, false);
  const res = readGateResult(a, 'tsc');
  assert.ok(res.shards && res.shards.invalid, 'sharded meta with no manifest is invalid');
  const d = tmp();
  const lone = part(path.join(d, 'lone'), '1/2', GATES);
  const r2 = readGateResult(lone, 'tsc');
  assert.match(r2.shards.invalid, /never merged/);
  const base = part(path.join(d, 'base'), undefined, GATES);
  const all = judge(base, lone);
  assert.equal(all.verdict, 'fail');
});

test('a whole gate run on both runners, or on neither, is refused gate by gate', () => {
  const both = pair({}); part(both.b, '2/2', [...B_GATES, 'tsc']);
  assert.equal(mergeGauntletDirs(both.a, both.b).ok, true);
  assert.equal(readGateResult(both.a, 'tsc'), null, 'ambiguous gate keeps no exit');
  const d = tmp();
  const a = part(path.join(d, 'a'), '1/2', ['unit-tests-node']); const b = part(path.join(d, 'b'), '2/2', ['unit-tests-node']);
  assert.equal(mergeGauntletDirs(a, b).ok, true);
  const { a: ba, b: bb } = pair(); mergeGauntletDirs(ba, bb);
  const all = judge(ba, a);
  assert.equal(all.verdict, 'fail');
  const allBoth = judge(ba, both.a);
  assert.equal(allBoth.verdict, 'fail');
  assert.ok(allBoth.gates.some((g) => g.gate === 'tsc' && g.verdict === 'fail'));
});

test('whole parts finish on a plain exit; only TAP slices need a summary', () => {
  assert.equal(shardPart('unit-tests-tsx', { exit: 0, text: 'no summary' }, { whole: true }).finished, true);
  assert.equal(shardPart('unit-tests-tsx', { exit: 0, text: 'no summary' }).finished, false);
  assert.equal(shardPart('tsc', { exit: 137, text: '' }, { whole: true }).finished, false);
});

test('GAUNTLET_SHARD is validated before any gate runs', () => {
  const out = tmp();
  for (const bad of ['1/1', '0/2', '3/2', '1/17', 'x', '01/2', '1/02', '99999999999999999999/2']) {
    const r = spawnSync('bash', [path.join(ROOT, 'scripts/lib/land-gauntlet.sh'), out], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GAUNTLET_SHARD: bad, GAUNTLET_GATES: 'none' } });
    assert.equal(r.status, 2, `${bad}: ${r.stderr}`);
    assert.match(r.stderr, /GAUNTLET_SHARD must be k\/n/);
  }
});

test('node --test-shard slices are disjoint and their union is the unsharded run', () => {
  const d = tmp();
  const files = [];
  for (let i = 1; i <= 7; i++) { const f = path.join(d, `t${i}.test.mjs`); fs.writeFileSync(f, `import {test} from 'node:test'; test('t${i}', () => {});\n`); files.push(f); }
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const run = (extra) => {
    const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...extra, ...files], { encoding: 'utf8', env });
    return new Set([...r.stdout.matchAll(/^\s*# Subtest: (t\d+)$/mg)].map((m) => m[1]));
  };
  const all = run([]); const s1 = run(['--test-shard=1/2']); const s2 = run(['--test-shard=2/2']);
  assert.equal(all.size, 7);
  assert.equal([...s1].filter((x) => s2.has(x)).length, 0, 'disjoint');
  assert.deepEqual([...new Set([...s1, ...s2])].sort(), [...all].sort(), 'union equals the whole');
  // Same list in a different order slices the same way (node sorts first).
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-shard=1/2', ...[...files].reverse()], { encoding: 'utf8', env });
  assert.deepEqual(new Set([...r.stdout.matchAll(/^\s*# Subtest: (t\d+)$/mg)].map((m) => m[1])), s1);
});

test('a merge that never finished is refused, even over complete-looking manifests', () => {
  const { a, b } = pair(); const { a: ba, b: bb } = pair();
  assert.equal(mergeGauntletDirs(a, b).ok, true); mergeGauntletDirs(ba, bb);
  const meta = JSON.parse(fs.readFileSync(path.join(a, 'meta.json'), 'utf8'));
  assert.equal(meta.mergeIncomplete, undefined, 'a finished merge drops the marker');
  fs.writeFileSync(path.join(a, 'meta.json'), JSON.stringify({ ...meta, mergeIncomplete: true }));
  assert.match(readGateResult(a, 'tsc').shards.invalid, /did not finish/);
  assert.equal(judge(ba, a).verdict, 'fail');
});

test('a scoped part is refused: its .files is the full list, not what ran', () => {
  const { a, b } = pair();
  fs.writeFileSync(path.join(b, 'SCOPED'), 'unit-tests-node\n');
  const r = mergeGauntletDirs(a, b);
  assert.equal(r.ok, false);
  assert.match(r.problems.join(' '), /scoped run/);
});

test('a whole gate whose log was lost is an unfinished part', () => {
  const { a, b } = pair(); const { a: ba, b: bb } = pair();
  fs.rmSync(path.join(b, 'unit-tests-tsx.log'));
  assert.equal(mergeGauntletDirs(a, b).ok, true); mergeGauntletDirs(ba, bb);
  const all = judge(ba, a);
  assert.equal(all.verdict, 'fail');
  assert.ok(all.gates.some((g) => g.gate === 'unit-tests-tsx' && g.mode === 'shard-incomplete'));
});

test('a sharded gauntlet run clears a reused dir and marks itself a part', () => {
  const out = tmp();
  fs.writeFileSync(path.join(out, 'tsc.exit'), '0\n');
  fs.writeFileSync(path.join(out, 'tsc.shards.json'), '{}');
  const r = spawnSync('bash', [path.join(ROOT, 'scripts/lib/land-gauntlet.sh'), out], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, GAUNTLET_SHARD: '1/2', GAUNTLET_GATES: 'none' } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.existsSync(path.join(out, 'tsc.exit')), false, 'stale exit removed');
  assert.equal(fs.existsSync(path.join(out, 'tsc.shards.json')), false, 'stale manifest removed');
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  assert.equal(meta.shard, '1/2');
  assert.match(meta.tree, /^[0-9a-f]{40}$/);
  assert.match(readShardEntry(out, 'tsc', meta).invalid, /never merged/);
});

test('a whole advisory TAP gate that exits 2 stays advisory, as in an unsplit run', () => {
  const { a, b } = pair({ a: { exits: { 'unit-tests-e2e': 2 }, logs: { 'unit-tests-e2e': 'crashed\n' } } }); const { a: ba, b: bb } = pair();
  assert.equal(mergeGauntletDirs(a, b).ok, true); mergeGauntletDirs(ba, bb);
  const e2e = judge(ba, a).gates.find((g) => g.gate === 'unit-tests-e2e');
  assert.notEqual(e2e.mode, 'shard-incomplete');
  assert.equal(e2e.verdict, 'pass', 'advisory gate downgraded as when unsplit');
});

test('seed export refuses an unfinished split run', () => {
  const { decideSeedExport } = require('./tsc-stamp.js');
  const sha = 'a'.repeat(40);
  const base = { rebased: sha, headOid: sha, residue: [], key: 'k', digest: 'd', preDigest: 'd' };
  for (const meta of [{ sha, exits: { tsc: 0 }, sharded: true, mergeIncomplete: true }, { sha, exits: { tsc: 0 }, shard: '1/2' }]) {
    assert.match(decideSeedExport({ ...base, meta }).reason, /unfinished split/);
  }
});
