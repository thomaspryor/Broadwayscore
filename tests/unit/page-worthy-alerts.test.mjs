// BRO-4043: the opening-night monitor's final parity/escalation report must
// page exactly once per show per night, even after a mid-window send under the
// base per-night key. Exercises the REAL page-worthy allowlist and the REAL
// routeAlert() (CLAUDE.md §15) with temp ledger/digest/attempts files and only
// the delivery boundary (discord-notify sendAlert) and Linear client stubbed.
// No email is ever sent and no real ledger is touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { isPageWorthy, PAGE_WORTHY_FINAL_REPORT_RE } = require('../../scripts/lib/page-worthy-alerts.js');

const ROUTER = require.resolve('../../scripts/lib/owner-alert-router.js');
const NOTIFY = require.resolve('../../scripts/lib/discord-notify.js');
const LINEAR_CLIENT = require.resolve('../../scripts/lib/linear-client.js');
const ENV_KEYS = ['ALERT_LEDGER_PATH', 'ALERT_DIGEST_QUEUE_PATH', 'ALERT_ATTEMPTS_LOG_PATH'];

function stubModule(p, exports) {
  require.cache[p] = { id: p, filename: p, loaded: true, exports };
}

// Fresh router bound to a temp ledger seeded with `conditions`. Restores env
// and the module cache after the test.
function isolatedRouter(t, { conditions = {}, deliver = () => true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro-4043-final-report-'));
  const ledgerPath = path.join(dir, 'alert-ledger.json');
  fs.writeFileSync(ledgerPath, JSON.stringify({ conditions }));
  const priorEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.ALERT_LEDGER_PATH = ledgerPath;
  process.env.ALERT_DIGEST_QUEUE_PATH = path.join(dir, 'alert-digest-queue.json');
  process.env.ALERT_ATTEMPTS_LOG_PATH = path.join(dir, 'alert-router-attempts.jsonl');
  const priorCache = Object.fromEntries([ROUTER, NOTIFY, LINEAR_CLIENT].map((p) => [p, require.cache[p]]));
  const sends = [];
  delete require.cache[ROUTER];
  stubModule(NOTIFY, { sendAlert: async (opts) => { sends.push(opts); return deliver(opts); } });
  stubModule(LINEAR_CLIENT, {
    searchIssues: async () => null,
    getIssue: async (id) => ({ identifier: id, state: { type: 'unstarted' } }),
    getTeam: async () => ({ id: 'team', states: [] }),
    graphql: async () => { throw new Error('no network in tests'); },
    TEAM_KEY: 'BRO',
  });
  t.after(() => {
    for (const [k, v] of Object.entries(priorEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    for (const [p, v] of Object.entries(priorCache)) {
      if (v) require.cache[p] = v;
      else delete require.cache[p];
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { router: require(ROUTER), sends, ledgerPath };
}

const NIGHT = 'on-monitor-2026-09-21';
const BASE = `on-monitor-report-${NIGHT}`; // canonical per-night key from the card
const alert = (conditionKey) => ({ conditionKey, title: 'Opening night final report', disposition: 'human', severity: 'error' });

test('-parity-final and -escalation-final keys are page-worthy', () => {
  for (const suffix of ['parity-final', 'escalation-final']) {
    assert.equal(isPageWorthy(`${BASE}-some-show-${suffix}`), true, suffix);
    assert.equal(isPageWorthy(`${BASE}-catarina-west-end-2026-${suffix}`), true, suffix);
    assert.ok(PAGE_WORTHY_FINAL_REPORT_RE.test(`${BASE}-x-${suffix}`));
  }
});

test('negative: the base key, other variants and unrelated keys stay non-page-worthy', () => {
  for (const key of [
    BASE, // mid-window report stays digest-tier (BRO-3154)
    `${BASE}-mid-window`,
    `${BASE}-show-a-parity`,
    `${BASE}-show-a-parity-final-retry`,
    'some-other-report-show-a-parity-final',
    'unrelated:condition-key',
    '',
    undefined,
  ]) {
    assert.equal(isPageWorthy(key), false, String(key));
  }
});

for (const suffix of ['parity-final', 'escalation-final']) {
  test(`${suffix}: pages despite an earlier send under the base per-night key, then a second send is silent`, async (t) => {
    const earlier = { status: 'open', disposition: 'human', lastNotifiedAt: new Date().toISOString(), notifyCount: 1, firstSeen: new Date().toISOString() };
    const { router, sends, ledgerPath } = isolatedRouter(t, { conditions: { [BASE]: earlier } });

    // The bug: the base key is already inside its cooldown, so it is silent.
    assert.equal((await router.routeAlert(alert(BASE))).action, 'silent');
    assert.equal(sends.length, 0);

    const key = `${BASE}-show-a-${suffix}`;
    const first = await router.routeAlert(alert(key));
    assert.equal(first.action, 'human');
    assert.equal(first.delivered, true);
    assert.equal(sends.length, 1);
    assert.equal(sends[0].email, true);

    // Idempotence: the identical -final key is deduped.
    const second = await router.routeAlert(alert(key));
    assert.equal(second.action, 'silent');
    assert.equal(sends.length, 1);

    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    assert.equal(ledger.conditions[key].notifyCount, 1);
    assert.equal(ledger.conditions[BASE].notifyCount, 1);
  });
}

test('final reports for different shows on the same night do not suppress each other', async (t) => {
  const { router, sends } = isolatedRouter(t);
  for (const key of [`${BASE}-show-a-parity-final`, `${BASE}-show-b-escalation-final`]) {
    assert.equal((await router.routeAlert(alert(key))).action, 'human', key);
  }
  assert.equal(sends.length, 2);
});

test('a failed final delivery stays retryable under the same key', async (t) => {
  let attempts = 0;
  const { router, sends } = isolatedRouter(t, { deliver: () => ++attempts > 1 });
  const opts = alert(`${BASE}-show-a-parity-final`);
  assert.equal((await router.routeAlert(opts)).delivered, false);
  assert.equal((await router.routeAlert(opts)).delivered, true);
  assert.equal((await router.routeAlert(opts)).action, 'silent');
  assert.equal(sends.length, 2);
});

test('monitor-v2.md sends the final reports under the -final keys, never the base key', () => {
  const prompt = fs.readFileSync(new URL('../../scripts/opening-night-prompts/monitor-v2.md', import.meta.url), 'utf8');
  const keys = [...prompt.matchAll(/conditionKey: '([^']+)'/g)].map((m) => m[1]);
  const finals = keys.filter((k) => k.startsWith('on-monitor-report-'));
  assert.deepEqual(finals.sort(), [
    'on-monitor-report-{{NIGHT_KEY}}-<show-id>-escalation-final',
    'on-monitor-report-{{NIGHT_KEY}}-<show-id>-parity-final',
  ]);
  for (const k of finals) {
    assert.equal(isPageWorthy(k.replace('{{NIGHT_KEY}}', NIGHT).replace('<show-id>', 'show-a')), true, k);
  }
  assert.ok(!keys.includes('on-monitor-report-{{NIGHT_KEY}}'), 'final report must not reuse the base per-night key');
});
