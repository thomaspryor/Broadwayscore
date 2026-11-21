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
const { GH_TIMEOUT_MS, GH_DOWNLOAD_TIMEOUT_MS, MIN_CALL_MS, SHARD_PARTS, SHARD_JOB_NAME, CHECKS_JOB_NAME, decideShardPoll, decidePeerWatch, validateFetchedPart, validateDataRev, DATA_REV_FILE, decideChecksDone, collect, watch, checksDone, parseArgs, shardArtifactName } = require('./land-shard.js');
const { GATES } = require('./land-gate-delta.js');
const { SHARDED_GATES } = require('./land-gauntlet-merge.js');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'bro7324-shard-'));
const TAP = (fail = 0) => `TAP version 13\n${fail ? 'not ok 1 - a.test.js\n' : 'ok 1 - a.test.js\n'}1..1\n# tests 3\n# pass ${3 - fail}\n# fail ${fail}\n`;
const REV = 'a'.repeat(40);
function part(dir, shard, gates, { tree = 'T1', sha = 'S1', exits = {}, dataRev = REV } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  if (dataRev !== null) fs.writeFileSync(path.join(dir, 'data-rev.txt'), `${dataRev}\n`);
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
const opts = (d) => ({ repo: 'o/r', 'run-id': '9', attempt: '1', out: path.join(d, 'part2'), 'merge-into': part(path.join(d, 'branch'), '1/2', SHARD_PARTS[1]), harness: '/h.sh', 'data-rev': REV, 'interval-s': '0', 'wait-min': '1' });
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

test('validateDataRev: same 40-hex core-data revision only; missing either side -> not merged', () => {
  assert.equal(DATA_REV_FILE, 'data-rev.txt');
  assert.equal(validateDataRev(REV, `${REV}\n`).ok, true);
  assert.equal(validateDataRev(REV, 'b'.repeat(40)).ok, false);
  for (const [a, b] of [[REV, null], [REV, ''], [null, REV], ['', REV], [undefined, undefined], [REV, 'not-a-sha']]) assert.equal(validateDataRev(a, b).ok, false, `${a} / ${b}`);
});

test('collect: core data differs between the runners, or a revision is missing -> part 2 runs here (never merged from B)', () => {
  const name = shardArtifactName('9', '1');
  const cases = [
    { srcRev: 'b'.repeat(40), aRev: REV },  // B cloned a newer data main
    { srcRev: null, aRev: REV },            // B's artifact has no data-rev.txt
    { srcRev: REV, aRev: undefined },       // A could not read its own revision
  ];
  for (const c of cases) {
    const d = tmp(); const o = opts(d);
    if (c.aRev === undefined) delete o['data-rev'];
    const src = part(path.join(d, 'src'), '2/2', SHARD_PARTS[2], { sha: 'S2', dataRev: c.srcRev });
    let spawned = 0;
    const r = withOutput(() => collect(o, { ...quiet, exec: fakeExec({ jobs: [doneJob], artifacts: [{ id: 5, name }], partDir: src }), spawn: (cmd, args) => { spawned++; part(args[1], '2/2', SHARD_PARTS[2]); return { status: 0 }; } }));
    assert.equal(r.rc, 0, JSON.stringify(c)); assert.equal(spawned, 1, JSON.stringify(c));
    assert.match(r.out, /node_shard=local/, JSON.stringify(c));
  }
  // Same revision on both sides -> merged from the artifact, no local run.
  const d = tmp(); const o = opts(d);
  const src = part(path.join(d, 'src'), '2/2', SHARD_PARTS[2], { sha: 'S2' });
  let spawned = 0;
  const r = withOutput(() => collect(o, { ...quiet, exec: fakeExec({ jobs: [doneJob], artifacts: [{ id: 5, name }], partDir: src }), spawn: () => { spawned++; return { status: 0 }; } }));
  assert.equal(r.rc, 0); assert.equal(spawned, 0); assert.match(r.out, /node_shard=artifact/);
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
  assert.equal(r.rc, 0); assert.match(r.out, /^source=artifact\nnode_shard=artifact\nwait_secs=\d+\nlocal_secs=0\n$/);
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

// A hung artifact API: execFileSync's timeout kill looks like this.
const timedOut = () => { const e = new Error('spawnSync gh ETIMEDOUT'); e.code = 'ETIMEDOUT'; e.signal = 'SIGTERM'; return e; };
// fakeExec, recording each call's timeout and hanging (timing out) on one endpoint.
function hangingExec(hang, base) {
  const calls = [];
  const exec = (cmd, args, so = {}) => {
    const ep = args[args.length - 1];
    calls.push({ cmd, ep, timeout: so.timeout });
    if (cmd === 'gh' && hang.test(ep)) throw timedOut();
    return base(cmd, args, so);
  };
  return { exec, calls };
}

test('collect: every network call carries a timeout (60s listings, 180s download, clipped to the deadline)', () => {
  const d = tmp(); const o = { ...opts(d), 'wait-min': '12' };
  const src = part(path.join(d, 'src'), '2/2', SHARD_PARTS[2], { sha: 'S2' });
  const { exec, calls } = hangingExec(/^$/, fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'completed', conclusion: 'success' }], artifacts: [{ id: 5, name: shardArtifactName('9', '1') }], partDir: src }));
  assert.equal(collect(o, { ...quiet, exec, spawn: () => assert.fail('no local run') }), 0);
  for (const c of calls) assert.ok(Number.isFinite(c.timeout) && c.timeout > 0, `${c.cmd} ${c.ep} has no timeout`);
  assert.equal(calls.find((c) => /\/jobs\?/.test(c.ep)).timeout, GH_TIMEOUT_MS);
  assert.equal(calls.find((c) => /\/artifacts\?name=/.test(c.ep)).timeout, GH_TIMEOUT_MS);
  assert.equal(calls.find((c) => /\/zip$/.test(c.ep)).timeout, GH_DOWNLOAD_TIMEOUT_MS);
});

test('collect: a timed-out artifact listing or download runs part 2 here at once (no retries), and fails closed', () => {
  for (const hang of [/\/artifacts\?name=/, /\/zip$/, /\/jobs\?/]) {
    const d = tmp(); const o = opts(d);
    const src = part(path.join(d, 'src'), '2/2', SHARD_PARTS[2], { sha: 'S2' });
    const { exec, calls } = hangingExec(hang, fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'completed', conclusion: 'success' }], artifacts: [{ id: 5, name: shardArtifactName('9', '1') }], partDir: src }));
    let spawned = 0;
    const r = withOutput(() => collect(o, { ...quiet, exec, spawn: (c, a) => { spawned++; part(a[1], '2/2', SHARD_PARTS[2]); return { status: 0 }; } }));
    assert.equal(r.rc, 0, String(hang)); assert.equal(spawned, 1, String(hang));
    assert.match(r.out, /source=local/);
    assert.equal(calls.filter((c) => hang.test(c.ep)).length, 1, `${hang}: a timeout is not retried`);
    // Fail closed: the timeout plus a failed local part never exits 0.
    const r2 = withOutput(() => collect(opts(tmp()), { ...quiet, exec: hangingExec(hang, fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'completed', conclusion: 'success' }], artifacts: [{ id: 5, name: shardArtifactName('9', '1') }], partDir: src })).exec, spawn: () => ({ status: 1 }) }));
    assert.equal(r2.rc, 1); assert.doesNotMatch(r2.out, /node_shard=/);
  }
});

test('collect: --wait-min is a deadline for the whole wait, network calls and sleeps included', () => {
  const d = tmp(); const o = { ...opts(d), 'wait-min': '2', 'interval-s': '20' };
  let t = 1_000_000;
  const { exec, calls } = hangingExec(/^$/, fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'in_progress' }] }));
  // Each API call takes 25s of fake time; sleeps advance the clock too.
  const slow = (cmd, args, so) => { t += 25_000; return exec(cmd, args, so); };
  const slept = [];
  let spawned = 0;
  const rc = collect(o, { log: () => {}, now: () => t, sleep: (ms) => { slept.push(ms); t += ms; }, exec: slow, spawn: (c, a) => { spawned++; part(a[1], '2/2', SHARD_PARTS[2]); return { status: 0 }; } });
  assert.equal(rc, 0); assert.equal(spawned, 1);
  assert.ok(t - 1_000_000 <= 2 * 60_000 + 2 * MIN_CALL_MS, `collect ran ${t - 1_000_000}ms past a 2 min wait`);
  for (const ms of slept) assert.ok(ms >= 0 && ms <= 20_000);
  const timeouts = calls.map((c) => c.timeout);
  assert.ok(timeouts.every((ms) => ms <= GH_TIMEOUT_MS && ms >= MIN_CALL_MS));
  assert.ok(timeouts.at(-1) < GH_TIMEOUT_MS, 'late calls are clipped to the time left');
  // Already past the deadline on entry: no network call at all, part 2 runs here.
  const { exec: e2, calls: c2 } = hangingExec(/^$/, fakeExec({ jobs: [] }));
  let n = 0;
  const rc2 = collect(opts(tmp()), { log: () => {}, sleep: () => {}, now: () => (n++ === 0 ? 0 : 10 * 60_000), exec: e2, spawn: (c, a) => { part(a[1], '2/2', SHARD_PARTS[2]); return { status: 0 }; } });
  assert.equal(rc2, 0); assert.equal(c2.length, 0);
});

test('collect: records the wait for B and the local re-run apart (timing ledger, BRO-7324)', () => {
  const d = tmp(); const o = { ...opts(d), 'wait-min': '12', 'interval-s': '20' };
  let t = 1_000_000;
  const { exec } = hangingExec(/^$/, fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'completed', conclusion: 'failure' }] }));
  const r = withOutput(() => collect(o, { ...quiet, exec, now: () => t, sleep: (ms) => { t += ms; }, spawn: (c, a) => { t += 300_000; part(a[1], '2/2', SHARD_PARTS[2]); return { status: 0 }; } }));
  assert.equal(r.rc, 0);
  assert.match(r.out, /node_shard=local/);
  const wait = Number(/^wait_secs=(\d+)$/m.exec(r.out)[1]);
  assert.ok(wait < 300, `the local run's 300s is not counted as waiting (wait ${wait}s)`);
  assert.match(r.out, /^local_secs=300$/m);
  // An artifact merge never runs part 2 here: local_secs is 0.
  const d2 = tmp(); const src = part(path.join(d2, 'src'), '2/2', SHARD_PARTS[2], { sha: 'S2' });
  const r2 = withOutput(() => collect(opts(d2), { ...quiet, exec: fakeExec({ jobs: [{ name: SHARD_JOB_NAME, status: 'completed', conclusion: 'success' }], artifacts: [{ id: 5, name: shardArtifactName('9', '1') }], partDir: src }), spawn: () => assert.fail('no local run') }));
  assert.equal(r2.rc, 0); assert.match(r2.out, /node_shard=artifact/); assert.match(r2.out, /^local_secs=0$/m);
});
