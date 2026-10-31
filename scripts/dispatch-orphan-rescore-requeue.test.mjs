import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const auditDir = path.join(root, 'data', 'audit');
const showId = 'resolved-show-2026';
const conditionKey = `orphan-unscored-requeue:${showId}`;
const attempts = { attempts: [{ at: '2026-08-26T12:00:00.000Z', ok: true }] };
const openCondition = {
  status: 'open',
  lastNotifiedAt: '2026-08-26T12:00:00.000Z',
  notifyCount: 1,
};

// Exercise the real CLI's run() and the real alert-router persistence. Only
// redirect audit-file I/O and reject network side effects. The state path has
// no environment override, so remap it rather than touching tracked data.
function fixture(t, { showState, condition = openCondition, marker } = {}) {
  const dir = fs.mkdtempSync(path.join(root, '.tmp-orphan-requeue-'));
  const cliPath = require.resolve('./dispatch-orphan-rescore-requeue.js');
  const routerPath = require.resolve('./lib/owner-alert-router.js');
  const env = {
    ALERT_LEDGER_PATH: path.join(dir, 'alert-ledger.json'),
    ALERT_DIGEST_QUEUE_PATH: path.join(dir, 'digest.json'),
    ALERT_ATTEMPTS_LOG_PATH: path.join(dir, 'attempts.jsonl'),
  };
  const previousEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  delete require.cache[cliPath];
  delete require.cache[routerPath];
  t.after(() => {
    delete require.cache[cliPath];
    delete require.cache[routerPath];
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const remap = file => typeof file === 'string'
    && (file === auditDir || file.startsWith(auditDir + path.sep))
    ? dir + file.slice(auditDir.length) : file;
  for (const method of ['readFileSync', 'writeFileSync', 'existsSync', 'mkdirSync']) {
    const original = fs[method];
    t.mock.method(fs, method, (file, ...args) => original(remap(file), ...args));
  }
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => rename(remap(from), remap(to)));

  const write = (name, value) => fs.writeFileSync(path.join(dir, name), JSON.stringify(value));
  const read = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const bytes = name => fs.readFileSync(path.join(dir, name), 'utf8');
  const stateFile = 'orphan-rescore-requeue-state.json';
  const ledgerFile = 'alert-ledger.json';
  const state = { version: 1, shows: { unrelated: attempts, ...(showState ? { [showId]: showState } : {}) } };
  const ledger = { conditions: { 'other:incident': openCondition, ...(condition ? { [conditionKey]: condition } : {}) } };
  write(stateFile, state);
  write(ledgerFile, ledger);
  if (marker !== undefined) {
    const markerFile = path.join(dir, `orphan-unscored-${showId}.json`);
    fs.writeFileSync(markerFile, typeof marker === 'string' ? marker : JSON.stringify(marker));
  }

  const router = require('./lib/owner-alert-router.js');
  t.mock.method(router, 'routeAlert', async () => { throw new Error('unexpected alert'); });
  const dispatcher = require('./lib/dispatch-rescore.js');
  t.mock.method(dispatcher, 'dispatchRescore', async () => { throw new Error('unexpected rescore dispatch'); });
  const loadCLI = () => {
    delete require.cache[cliPath];
    return require('./dispatch-orphan-rescore-requeue.js');
  };
  return { run: loadCLI().run, loadCLI, write, read, bytes, state, ledger, stateFile, ledgerFile };
}

test('clear heals a state-only committed clear on the next run', async t => {
  const f = fixture(t, { showState: attempts });
  const committedLedger = f.bytes(f.ledgerFile);
  assert.deepEqual(await f.run(showId), { showId, action: 'clear', orphanCount: 0 });
  assert.equal(f.read(f.stateFile).shows[showId], undefined);
  assert.equal(f.read(f.ledgerFile).conditions[conditionKey].status, 'resolved');

  // The first push committed the cleared state, then the runner died before
  // the independent alert-ledger push. Reconstruct the next checkout from
  // those two committed versions, discarding the first run's resolved ledger.
  fs.writeFileSync(process.env.ALERT_LEDGER_PATH, committedLedger);
  assert.equal(f.read(f.stateFile).shows[showId], undefined);
  assert.equal(f.read(f.ledgerFile).conditions[conditionKey].status, 'open');

  assert.deepEqual(await f.loadCLI().run(showId), { showId, action: 'clear', orphanCount: 0 });
  const healed = f.read(f.ledgerFile).conditions[conditionKey];
  assert.equal(healed.status, 'resolved');
  assert.ok(Number.isFinite(Date.parse(healed.resolvedAt)));
  assert.equal(healed.lastNotifiedAt, openCondition.lastNotifiedAt);
  assert.equal(healed.notifyCount, 1);
  assert.deepEqual(f.read(f.stateFile).shows, { unrelated: attempts });
  assert.deepEqual(f.read(f.ledgerFile).conditions['other:incident'], openCondition);

  const settledState = f.bytes(f.stateFile);
  const settledLedger = f.bytes(f.ledgerFile);
  await f.loadCLI().run(showId);
  assert.equal(f.bytes(f.stateFile), settledState, 'repeated clear must not rewrite state');
  assert.equal(f.bytes(f.ledgerFile), settledLedger, 'repeated clear must not rewrite ledger');
});

test('clear with an explicit zero-orphan marker resolves an open ledger without attempts', async t => {
  const f = fixture(t, { marker: { orphanCount: 0 } });
  assert.equal((await f.run(showId)).action, 'clear');
  assert.equal(f.read(f.ledgerFile).conditions[conditionKey].status, 'resolved');
  assert.deepEqual(f.read(f.stateFile).shows, f.state.shows);
});

test('clear heals the reverse partial commit without changing an already resolved ledger', async t => {
  const f = fixture(t, {
    showState: attempts,
    condition: { ...openCondition, status: 'resolved', resolvedAt: '2026-08-26T13:00:00.000Z' },
  });
  const ledgerBefore = f.bytes(f.ledgerFile);
  assert.equal((await f.run(showId)).action, 'clear');
  assert.deepEqual(f.read(f.stateFile).shows, { unrelated: attempts });
  assert.equal(f.bytes(f.ledgerFile), ledgerBefore);
});

test('clear for a never-broken show does not create an alert condition or rewrite files', async t => {
  const f = fixture(t, { condition: null });
  const stateBefore = f.bytes(f.stateFile);
  const ledgerBefore = f.bytes(f.ledgerFile);
  assert.equal((await f.run(showId)).action, 'clear');
  assert.equal(f.bytes(f.stateFile), stateBefore);
  assert.equal(f.bytes(f.ledgerFile), ledgerBefore);
});

test('absent attempt state alone cannot resolve a still-active orphan incident', async t => {
  const f = fixture(t, { marker: { orphanCount: 2, lastDispatch: 'ok' } });
  const stateBefore = f.bytes(f.stateFile);
  const ledgerBefore = f.bytes(f.ledgerFile);
  assert.deepEqual(await f.run(showId), { showId, action: 'in-flight', orphanCount: 2 });
  assert.equal(f.bytes(f.stateFile), stateBefore);
  assert.equal(f.bytes(f.ledgerFile), ledgerBefore);
});

test('a corrupt marker fails closed and preserves both committed files', async t => {
  const f = fixture(t, { showState: attempts, marker: '{invalid JSON' });
  const stateBefore = f.bytes(f.stateFile);
  const ledgerBefore = f.bytes(f.ledgerFile);
  const result = await f.run(showId);
  assert.equal(result.action, 'error');
  assert.match(result.message, /^corrupt marker:/);
  assert.equal(f.bytes(f.stateFile), stateBefore);
  assert.equal(f.bytes(f.ledgerFile), ledgerBefore);
});
