// BRO-7324 step C: land-shard.js decides how runner A gets part 2/2 (B's
// artifact, or run it here) and stops B once A is done. Every path either
// merges a full part or fails closed; none turns a lost part into a pass.
// node --test scripts/lib/land-shard.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SHARD_PARTS, SHARD_JOB_NAME, CHECKS_JOB_NAME, decideShardPoll, decidePeerWatch, validateFetchedPart, decideChecksDone, collect, watch, checksDone, parseArgs, shardArtifactName } = require('./land-shard.js');
const { GATES } = require('./land-gate-delta.js');
const { SHARDED_GATES } = require('./land-gauntlet-merge.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bro7324-shard-'));
const TAP = (fail = 0) => `TAP version 13\n${fail ? 'not ok 1 - a.test.js\n' : 'ok 1 - a.test.js\n'}1..1\n# tests 3\n# pass ${3 - fail}\n# fail ${fail}\n`;
function part(dir, shard, gates, { tree = 'T1', sha = 'S1', exits = {} } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  for (const g of gates) {
    const exit = exits[g] ?? 0;
    fs.writeFileSync(path.join(dir, `${g}.exit`), `${exit}\n`);
    fs.writeFileSync(path.join(dir, `${g}.log`), g.startsWith('unit-tests') || g === 'scripts-lib-tests' ? TAP(exit === 1 ? 1 : 0) : 'ok\n');
    fs.writeFileSync(path.join(dir, `${g}.files`), 'a.test.js\nb.test.js\n');
    fs.writeFileSync(path.join(dir, `${g}.secs`), '10\n');
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ sha, root: '/r', tree, shard, wallMs: 1000, gates }));
  return dir;
}

test('the two parts cover every gauntlet gate: split gates in both, every other gate in exactly one', () => {
  for (const g of GATES) {
    const n = [1, 2].filter((k) => SHARD_PARTS[k].includes(g)).length;
    assert.equal(n, SHARDED_GATES.has(g) ? 2 : 1, g);
  }
  for (const k of [1, 2]) for (const g of SHARD_PARTS[k]) assert.ok(GATES.includes(g), `${g} is a gauntlet gate`);
  assert.equal(GATES.length, 10);
});

test('decideShardPoll: artifact -> fetch; running -> wait until the deadline; anything else -> run part 2 here', () => {
  const base = { elapsedMs: 0, waitMs: 60000 };
  assert.equal(decideShardPoll({ ...base, job: { status: 'in_progress' }, artifactId: 7 }).action, 'fetch');
  assert.equal(decideShardPoll({ ...base, job: { status: 'completed', conclusion: 'success' }, artifactId: 7 }).action, 'fetch');
  assert.equal(decideShardPoll({ ...base, job: { status: 'in_progress' } }).action, 'wait');
  assert.equal(decideShardPoll({ ...base, elapsedMs: 60000, job: { status: 'in_progress' } }).action, 'local');
  for (const status of ['queued', 'waiting', 'pending']) assert.equal(decideShardPoll({ ...base, job: { status } }).action, 'local', status);
  assert.equal(decideShardPoll({ ...base, job: undefined }).action, 'local');
  assert.equal(decideShardPoll({ ...base, job: { status: 'completed', conclusion: 'failure' } }).action, 'recheck');
  assert.equal(decideShardPoll({ ...base, job: { status: 'completed', conclusion: 'success' }, recheck: true }).action, 'local');
  // Never a pass-like action without the part in hand.
  for (const d of [decideShardPoll({ ...base, job: { status: 'completed', conclusion: 'cancelled' }, recheck: true })]) assert.notEqual(d.action, 'fetch');
});

test('decidePeerWatch stops B only once A has completed', () => {
  assert.equal(decidePeerWatch({ peerJob: undefined }).action, 'continue');
  assert.equal(decidePeerWatch({ peerJob: { status: 'in_progress' } }).action, 'continue');
  assert.equal(decidePeerWatch({ peerJob: { status: 'completed', conclusion: 'failure' } }).action, 'stop');
});

// Fake gh/unzip: jobs + artifacts listings, the zip download, and unzip (copies a prepared dir).
function fakeExec({ jobs, artifacts = [], partDir, failApi = false }) {
  return (cmd, args) => {
    if (cmd === 'gh') {
      if (failApi) { const e = new Error('HTTP 502'); e.stderr = 'HTTP 502'; throw e; }
      const ep = args[args.length - 1];
      if (/\/jobs\?/.test(ep)) return JSON.stringify({ jobs });
      if (/\/artifacts\?name=/.test(ep)) return JSON.stringify({ artifacts });
      if (/\/zip$/.test(ep)) return 'PK-fake';
    }
    if (cmd === 'unzip') { const out = args[args.indexOf('-d') + 1]; fs.cpSync(partDir, out, { recursive: true }); return ''; }
    throw new Error(`unexpected ${cmd} ${args.join(' ')}`);
  };
}
const opts = (d) => ({ repo: 'o/r', 'run-id': '9', attempt: '1', out: path.join(d, 'part2'), 'merge-into': part(path.join(d, 'branch'), '1/2', SHARD_PARTS[1]), harness: '/h.sh', 'interval-s': '0', 'wait-min': '1' });
const quiet = { log: () => {}, sleep: () => {} };

test('collect: B uploaded its part -> fetched and merged, no local run', () => {
  const d = tmp(); const o = opts(d);
  const src = part(path.join(d, 'src'), '2/2', SHARD_PARTS[2], { sha: 'S2' });
  const name = shardArtifactName('9', '1');
  let spawned = 0;
  const rc = collect(o, { ...quiet, exec: fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'completed', conclusion: 'success' }], artifacts: [{ id: 5, name }], partDir: src }), spawn: () => { spawned++; return { status: 0 }; } });
  assert.equal(rc, 0); assert.equal(spawned, 0);
  const meta = JSON.parse(fs.readFileSync(path.join(o['merge-into'], 'meta.json'), 'utf8'));
  assert.equal(meta.sharded, true); assert.equal(meta.mergeIncomplete, undefined);
  assert.ok(meta.gates.includes('scripts-lib-tests'));
});

test('collect: B never started, or the API is down -> part 2 runs here with the part-2 gates, then merges', () => {
  for (const exec of [fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'queued' }] }), fakeExec({ jobs: [] }), fakeExec({ jobs: [], failApi: true })]) {
    const d = tmp(); const o = opts(d); let env;
    const rc = collect(o, { ...quiet, exec, spawn: (cmd, args, so) => { env = so.env; part(args[1], '2/2', SHARD_PARTS[2]); return { status: 0 }; } });
    assert.equal(rc, 0);
    assert.equal(env.GAUNTLET_GATES, SHARD_PARTS[2].join(',')); assert.equal(env.GAUNTLET_SHARD, '2/2');
  }
});

test('collect fails closed: local part 2 crashed, or the parts are different trees', () => {
  let d = tmp(); let o = opts(d);
  assert.equal(collect(o, { ...quiet, exec: fakeExec({ jobs: [] }), spawn: () => ({ status: 1 }) }), 1);
  assert.equal(collect(opts(tmp()), { ...quiet, exec: fakeExec({ jobs: [] }), spawn: () => ({ status: null }) }), 1);
  d = tmp(); o = opts(d);
  const src = part(path.join(d, 'src'), '2/2', SHARD_PARTS[2], { tree: 'OTHER' });
  const rc = collect(o, { ...quiet, exec: fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'completed', conclusion: 'success' }], artifacts: [{ id: 5, name: shardArtifactName('9', '1') }], partDir: src }), spawn: () => ({ status: 0 }) });
  assert.equal(rc, 1);
  const meta = JSON.parse(fs.readFileSync(path.join(o['merge-into'], 'meta.json'), 'utf8'));
  assert.equal(meta.mergeIncomplete, true, 'a refused merge leaves a dir the verdict refuses');
});

test('watch: B is stopped (exit 0, marker written) once A completed; otherwise B keeps its own exit code', async () => {
  const d = tmp(); const marker = path.join(d, 'stopped');
  const base = { repo: 'o/r', 'run-id': '9', attempt: '1', 'stopped-marker': marker };
  const done = fakeExec({ jobs: [{ name: CHECKS_JOB_NAME, status: 'completed', conclusion: 'failure' }] });
  const t0 = Date.now();
  assert.equal(await watch({ ...base, _: ['sleep', '30'] }, { exec: done, log: () => {}, intervalMs: 50 }), 0);
  assert.ok(Date.now() - t0 < 15000); assert.ok(fs.existsSync(marker));
  const running = fakeExec({ jobs: [{ name: CHECKS_JOB_NAME, status: 'in_progress' }] });
  assert.equal(await watch({ ...base, _: ['bash', '-c', 'sleep 0.3; exit 3'] }, { exec: running, log: () => {}, intervalMs: 50 }), 3);
  assert.equal(fs.existsSync(marker), false);
});

test('parseArgs keeps everything after -- as the command', () => {
  assert.deepEqual(parseArgs(['--repo=o/r', '--', 'bash', '--x=1']), { repo: 'o/r', _: ['bash', '--x=1'] });
});

// $GITHUB_OUTPUT is process-wide: point it at a temp file for one call.
function withOutput(fn) {
  const f = path.join(tmp(), 'gho'); fs.writeFileSync(f, '');
  const prev = process.env.GITHUB_OUTPUT; process.env.GITHUB_OUTPUT = f;
  try { const rc = fn(); return { rc, out: fs.readFileSync(f, 'utf8') }; } finally { if (prev === undefined) delete process.env.GITHUB_OUTPUT; else process.env.GITHUB_OUTPUT = prev; }
}
const doneJob = { name: SHARD_JOB_NAME, status: 'completed', conclusion: 'success' };

test('collect writes node_shard (and source) only after a successful merge', () => {
  let d = tmp(); let o = opts(d);
  const src = part(path.join(d, 'src'), '2/2', SHARD_PARTS[2], { sha: 'S2' });
  let r = withOutput(() => collect(o, { ...quiet, exec: fakeExec({ jobs: [doneJob], artifacts: [{ id: 5, name: shardArtifactName('9', '1') }], partDir: src }), spawn: () => ({ status: 0 }) }));
  assert.equal(r.rc, 0); assert.match(r.out, /^source=artifact\nnode_shard=artifact\n$/);
  r = withOutput(() => collect(opts(tmp()), { ...quiet, exec: fakeExec({ jobs: [] }), spawn: (c, a) => { part(a[1], '2/2', SHARD_PARTS[2]); return { status: 0 }; } }));
  assert.equal(r.rc, 0); assert.match(r.out, /node_shard=local\n/);
  // Failure paths: local crash, merge refusal. Neither writes node_shard.
  r = withOutput(() => collect(opts(tmp()), { ...quiet, exec: fakeExec({ jobs: [] }), spawn: () => ({ status: 1 }) }));
  assert.equal(r.rc, 1); assert.doesNotMatch(r.out, /node_shard/);
  r = withOutput(() => collect(opts(tmp()), { ...quiet, exec: fakeExec({ jobs: [] }), spawn: (c, a) => { part(a[1], '2/2', SHARD_PARTS[2], { tree: 'OTHER' }); return { status: 0 }; } }));
  assert.equal(r.rc, 1); assert.doesNotMatch(r.out, /node_shard/);
});

test('validateFetchedPart: only a finished part 2/2 of the same root and tree', () => {
  const A = { root: '/r', tree: 'T1', shard: '1/2' };
  assert.equal(validateFetchedPart(A, { root: '/r', tree: 'T1', shard: '2/2' }).ok, true);
  for (const B of [null, { root: '/r', tree: 'T1', shard: '2/2', partial: true }, { root: '/r', tree: 'T1', shard: '1/2' }, { root: '/r', tree: 'T1' },
    { root: '/r', tree: 'T2', shard: '2/2' }, { root: '/x', tree: 'T1', shard: '2/2' }, { root: '/r', shard: '2/2' }]) {
    assert.equal(validateFetchedPart(A, B).ok, false, JSON.stringify(B));
  }
  assert.equal(validateFetchedPart(null, { root: '/r', tree: 'T1', shard: '2/2' }).ok, false);
});

test('collect: a fetched artifact that fails validation is not merged; part 2 runs here instead', () => {
  const bad = [
    (dir) => part(dir, '2/2', SHARD_PARTS[2], { tree: 'OTHER' }),
    (dir) => part(dir, '1/2', SHARD_PARTS[2]),
    (dir) => { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ shard: '2/2', partial: true })); return dir; },
  ];
  for (const make of bad) {
    const d = tmp(); const o = opts(d); const src = make(path.join(d, 'src')); let spawned = 0;
    const r = withOutput(() => collect(o, { ...quiet, exec: fakeExec({ jobs: [doneJob], artifacts: [{ id: 5, name: shardArtifactName('9', '1') }], partDir: src }),
      spawn: (c, a) => { spawned++; part(a[1], '2/2', SHARD_PARTS[2]); return { status: 0 }; } }));
    assert.equal(r.rc, 0); assert.equal(spawned, 1); assert.match(r.out, /node_shard=local/);
    const meta = JSON.parse(fs.readFileSync(path.join(o['merge-into'], 'meta.json'), 'utf8'));
    assert.equal(meta.mergeIncomplete, undefined); assert.equal(meta.partSha['2/2'], 'S1');
  }
});

test('checks-done: done=true only when the job named exactly "Checks" completed; API error -> done=false', () => {
  assert.equal(decideChecksDone({ jobs: [{ name: CHECKS_JOB_NAME, status: 'completed', conclusion: 'failure' }] }), true);
  assert.equal(decideChecksDone({ jobs: [{ name: CHECKS_JOB_NAME, status: 'in_progress' }] }), false);
  assert.equal(decideChecksDone({ jobs: [{ name: SHARD_JOB_NAME, status: 'completed' }, { name: 'Checks / x', status: 'completed' }] }), false, 'never a prefix match');
  assert.equal(decideChecksDone({ jobs: undefined }), false);
  const base = { repo: 'o/r', 'run-id': '9', attempt: '1' };
  let r = withOutput(() => checksDone(base, { log: () => {}, exec: fakeExec({ jobs: [{ name: CHECKS_JOB_NAME, status: 'completed', conclusion: 'success' }] }) }));
  assert.equal(r.rc, 0); assert.equal(r.out, 'done=true\n');
  r = withOutput(() => checksDone(base, { log: () => {}, exec: fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'completed' }] }) }));
  assert.equal(r.out, 'done=false\n');
  r = withOutput(() => checksDone(base, { log: () => {}, exec: fakeExec({ jobs: [], failApi: true }) }));
  assert.equal(r.rc, 0); assert.equal(r.out, 'done=false\n');
  r = withOutput(() => checksDone({ repo: 'o/r' }, { log: () => {} }));
  assert.equal(r.rc, 2); assert.equal(r.out, 'done=false\n');
});

test('watch: an API that keeps failing never hangs B; it ends when the command exits', async () => {
  const marker = path.join(tmp(), 'stopped');
  const rc = await watch({ repo: 'o/r', 'run-id': '9', attempt: '1', 'stopped-marker': marker, _: ['bash', '-c', 'sleep 0.3; exit 4'] }, { exec: fakeExec({ jobs: [], failApi: true }), log: () => {}, intervalMs: 20 });
  assert.equal(rc, 4); assert.equal(fs.existsSync(marker), false);
});
