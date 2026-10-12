import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isPageWorthy } = require('../../scripts/lib/page-worthy-alerts.js');
const { buildSeed } = require('../../scripts/opening-night-monitor-launch.js');

// Exercise the real router with disposable state and only the delivery boundary
// stubbed. No owner emails or production ledger writes belong in a regression test.
function isolatedRouter(t, { conditions = {}, deliver = () => true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'final-report-test-'));
  const ledgerPath = path.join(dir, 'ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ conditions }));
  const env = {
    ALERT_LEDGER_PATH: ledgerPath,
    ALERT_DIGEST_QUEUE_PATH: path.join(dir, 'digest.json'),
    ALERT_ATTEMPTS_LOG_PATH: path.join(dir, 'attempts.jsonl'),
  };
  const priorEnv = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const routerPath = require.resolve('../../scripts/lib/owner-alert-router.js');
  const notifyPath = require.resolve('../../scripts/lib/discord-notify.js');
  const priorRouter = require.cache[routerPath];
  const priorNotify = require.cache[notifyPath];
  const sends = [];
  delete require.cache[routerPath];
  require.cache[notifyPath] = { id: notifyPath, filename: notifyPath, loaded: true, exports: {
    sendAlert: async opts => { sends.push(opts); return deliver(); },
  } };
  t.after(() => {
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const [key, value] of [[routerPath, priorRouter], [notifyPath, priorNotify]]) {
      if (value) require.cache[key] = value;
      else delete require.cache[key];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { router: require(routerPath), sends, ledgerPath };
}

const base = 'on-monitor-report-on-monitor-2026-09-21';
const alert = conditionKey => ({ conditionKey, title: 'Opening night final report', disposition: 'human', severity: 'error' });

test('only terminal parity/escalation report families are page-worthy', () => {
  for (const suffix of ['parity-final', 'escalation-final']) {
    assert.equal(isPageWorthy(`${base}-${suffix}`), true);
    assert.equal(isPageWorthy(`${base}-catarina-west-end-2026-${suffix}`), true);
  }
  for (const key of [base, `${base}-mid-window`, `${base}-parity`, `${base}-parity-final-retry`,
    'other-report-parity-final', 'on-monitor-report--parity-final', '', undefined]) {
    assert.equal(isPageWorthy(key), false, String(key));
  }
});

for (const suffix of ['parity-final', 'escalation-final']) {
  test(`${suffix} pages after a base-key send, then dedupes its own retries`, async t => {
    const earlier = { status: 'open', disposition: 'human', lastNotifiedAt: new Date().toISOString(), notifyCount: 1 };
    const { router, sends, ledgerPath } = isolatedRouter(t, { conditions: { [base]: earlier } });
    assert.equal((await router.routeAlert(alert(base))).action, 'silent');
    const key = `${base}-${suffix}`;
    const result = await router.routeAlert(alert(key));
    assert.equal(result.action, 'human');
    assert.equal(result.delivered, true);
    assert.equal((await router.routeAlert(alert(key))).action, 'silent');
    assert.equal(sends.length, 1);
    assert.equal(sends[0].email, true);
    assert.ok(sends[0].idempotencyKey);
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(ledger.conditions[key].notifyCount, 1);
    assert.equal(ledger.conditions[base].notifyCount, 1);
  });
}

test('final sends for different shows and nights do not suppress each other', async t => {
  const { router, sends } = isolatedRouter(t);
  for (const key of [`${base}-show-a-parity-final`, `${base}-show-b-parity-final`,
    'on-monitor-report-on-monitor-2026-09-22-show-a-parity-final']) {
    assert.equal((await router.routeAlert(alert(key))).action, 'human');
    assert.equal((await router.routeAlert(alert(key))).action, 'silent');
  }
  assert.equal(sends.length, 3);
  assert.equal(new Set(sends.map(s => s.idempotencyKey)).size, 3);
});

test('failed final delivery remains retryable', async t => {
  let attempts = 0;
  const { router, sends } = isolatedRouter(t, { deliver: () => ++attempts > 1 });
  const opts = alert(`${base}-parity-final`);
  assert.equal((await router.routeAlert(opts)).delivered, false);
  assert.equal((await router.routeAlert(opts)).delivered, true);
  assert.equal((await router.routeAlert(opts)).action, 'silent');
  assert.equal(sends.length, 2);
  assert.equal(sends[0].idempotencyKey, sends[1].idempotencyKey);
});

test('the live monitor prompt wires per-show final keys into routeAlert', () => {
  // The legacy launchd caller pins its template path to the Mac checkout.
  // Redirect that read to this checkout without duplicating buildSeed logic.
  const read = fs.readFileSync;
  let seed;
  try {
    fs.readFileSync = (file, ...args) => read(file === '/Users/tompryor/Broadwayscore/scripts/opening-night-prompts/monitor-v2.md'
      ? new URL('../../scripts/opening-night-prompts/monitor-v2.md', import.meta.url) : file, ...args);
    seed = buildSeed([{ showId: 'show-a', windowEnd: new Date('2026-09-22T18:00:00Z') }],
      { attempt: 2, rehearsal: false, key: 'on-monitor-2026-09-21', now: new Date('2026-09-22T16:00:00Z') });
  } finally { fs.readFileSync = read; }
  for (const suffix of ['parity-final', 'escalation-final']) {
    const key = `${base}-<show-id>-${suffix}`;
    assert.ok(seed.includes(`routeAlert({conditionKey: '${key}'`), `${suffix} must be wired to the sender`);
    assert.equal(isPageWorthy(key.replace('<show-id>', 'show-a')), true);
  }
  assert.ok(!seed.includes(`conditionKey: '${base}'`), 'final reports must not reuse the mid-window key');
});
