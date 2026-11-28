import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { liveDataLaneCheck, liveDataLaneSkipWarning } from './land-preflight.mjs';

// BRO-8420: the real live-data-lane.js, not a stub. Each no-verdict path exits 0, so the
// preflight must read it as a skip (not checked), never as clean.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

test('preflight invokes the changed-test lane and reports undeclared live reads', () => {
  const root = process.cwd();
  let invocation;
  const result = liveDataLaneCheck({ root, env: {}, budgetMs: 100000, seams: {
    run: (command, args, options) => {
      invocation = { command, args, options };
      return { status: 1, stdout: '::error::scripts/lib/example.test.mjs reads live data (data/shows.json)\n' };
    },
  } });
  assert.equal(invocation.command, process.execPath);
  assert.deepEqual(invocation.args, [path.join(root, 'scripts/live-data-lane.js'), '--verify-changed', '--refuse-undeclared', '--base=origin/main']);
  assert.equal(invocation.options.cwd, root);
  assert.equal(result.status, 'fail');
  assert.match(result.message, /example\.test\.mjs reads live data/);
});


test('a skipped live-data-lane check warns with reason and manual command (BRO-8293)', () => {
  const w = liveDataLaneSkipWarning({ status: 'skip', reason: 'uncommitted tracked changes: x\nsecond line' });
  assert.match(w, /NOT checked/);
  assert.match(w, /uncommitted tracked changes: x\)/);
  assert.doesNotMatch(w, /second line/);
  assert.match(w, /live-data-lane\.js --verify-changed --refuse-undeclared --base=origin\/main/);
});

test('silent when off, clean, fail, already refused, or the trace-incomplete warning exists', () => {
  assert.equal(liveDataLaneSkipWarning({ status: 'off', reason: 'x' }), null);
  assert.equal(liveDataLaneSkipWarning({ status: 'clean' }), null);
  assert.equal(liveDataLaneSkipWarning({ status: 'fail', message: 'm' }), null);
  assert.equal(liveDataLaneSkipWarning({ status: 'skip', reason: 'already refused' }), null);
  assert.equal(liveDataLaneSkipWarning({ status: 'skip', reason: 'trace incomplete', warning: 'w' }), null);
  assert.equal(liveDataLaneSkipWarning(null), null);
});

test('reason is trimmed, capped, and never empty; a missing script stays silent (BRO-8293)', () => {
  assert.match(liveDataLaneSkipWarning({ status: 'skip', reason: '\n  errored: boom' }), /skipped \(errored: boom\)/);
  assert.match(liveDataLaneSkipWarning({ status: 'skip', reason: '' }), /skipped \(unknown\)/);
  assert.ok(liveDataLaneSkipWarning({ status: 'skip', reason: 'x'.repeat(500) }).length < 420);
  assert.equal(liveDataLaneSkipWarning({ status: 'skip', reason: 'live-data-lane.js --refuse-undeclared not in this tree' }), null);
  assert.match(liveDataLaneSkipWarning({ status: 'skip', reason: 'r' }, 'origin/dev'), /--base=origin\/dev/);
});
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const realRun = (extraArgs = [], extraEnv = {}) => ({
  run: (cmd, args, opts) => spawnSync(cmd, [...args, ...extraArgs], { ...opts, env: { ...opts.env, ...extraEnv } }),
});
const env = () => ({ ...process.env, LAND_LIVE_DATA_PREFLIGHT_DISABLE: '' });

test('real script: a failed base diff is a skip, not clean (BRO-8420)', () => {
  const r = liveDataLaneCheck({ root: ROOT, base: 'refs/heads/no-such-ref-bro-8420', env: env(), budgetMs: 60000 });
  assert.equal(r.status, 'skip', JSON.stringify(r));
  assert.match(r.reason, /cannot diff against refs\/heads\/no-such-ref-bro-8420/);
  assert.match(r.warning, /not verified/);
});

test('real script: more changed tests than the limit is a skip, not clean (BRO-8420)', () => {
  const r = liveDataLaneCheck({ root: ROOT, env: env(), budgetMs: 60000,
    seams: realRun(['--files=scripts/lib/a.test.mjs,scripts/lib/b.test.mjs'], { LIVE_DATA_LANE_VERIFY_MAX: '1' }) });
  assert.equal(r.status, 'skip', JSON.stringify(r));
  assert.match(r.reason, /2 changed test files > 1/);
});

test('real script: a thrown error is a skip, not clean (BRO-8420)', () => {
  // mkdtemp under a missing TMPDIR throws inside the trace setup.
  const missing = path.join(os.tmpdir(), `bro-8420-missing-${process.pid}`);
  assert.equal(fs.existsSync(missing), false);
  const r = liveDataLaneCheck({ root: ROOT, env: env(), budgetMs: 60000,
    seams: realRun(['--files=scripts/lib/no-such-bro-8420.test.mjs'], { TMPDIR: missing }) });
  assert.equal(r.status, 'skip', JSON.stringify(r));
  assert.match(r.reason, /--verify-changed crashed/);
});

test('real script: zero changed tests stays clean (BRO-8420)', () => {
  const r = liveDataLaneCheck({ root: ROOT, base: 'HEAD', env: env(), budgetMs: 60000 });
  assert.equal(r.status, 'clean', JSON.stringify(r));
});
