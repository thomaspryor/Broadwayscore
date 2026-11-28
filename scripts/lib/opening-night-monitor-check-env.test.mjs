// BRO-2758: a launchd-dispatched opening-night-monitor pass with no scraper
// credentials has every fetchPage() fail silently, so aggregators go unchecked
// on opening night. The launcher must page the owner and stop BEFORE auth,
// lock or attempt bookkeeping. Rule 15: every function under test is the real
// one, require()d — no copied logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const LIB = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS = path.resolve(LIB, '..');

// Keep the real alert router (and the heavy watchdog) out of the test:
// alert() lazily require()s owner-alert-router.js, so a require.cache stub
// captures every routed alert without touching the ledger or sending email.
const alerts = [];
function stubModule(file, exports) {
  const id = require.resolve(file);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
stubModule(path.join(LIB, 'owner-alert-router.js'), {
  ledgerPath: () => '/dev/null', isLocalLedger: () => true,
  routeAlert: async opts => { alerts.push(opts); return { action: 'stub' }; },
});
stubModule(path.join(SCRIPTS, 'dispatch-watchdog.js'), { pageIfKillSwitchStale: () => ({ stale: false }) });

const monitor = require('./opening-night-monitor.js');
const cliAuth = require('./claude-cli.js');
const launcher = require('../opening-night-monitor-launch.js');
// The launcher's repo root (was a hardcoded Mac path; BRO-2682). Its data and
// config reads are faked missing; module source under it still loads.
const { MAIN_REPO_ROOT } = require('./repo-root.js');

const SCRAPER_KEYS_ON = { SCRAPINGBEE_API_KEY: 'sb-test' };
const WINDOWS = [{ showId: 'test-show-2026', market: 'broadway' }];
const NOW = new Date('2026-10-12T23:00:00Z');

test('assertMonitorScraperEnv: passes when any provider credential is present', () => {
  for (const k of monitor.SCRAPER_CREDENTIAL_KEYS) {
    const r = monitor.assertMonitorScraperEnv({ [k]: 'x' });
    assert.equal(r.ok, true, k);
    assert.deepEqual(r.present, [k]);
  }
  const all = Object.fromEntries(monitor.SCRAPER_CREDENTIAL_KEYS.map(k => [k, 'x']));
  assert.equal(monitor.assertMonitorScraperEnv(all).missing.length, 0);
});

test('assertMonitorScraperEnv: fails when every credential is absent, empty or whitespace', () => {
  for (const env of [{}, undefined, { SCRAPINGBEE_API_KEY: '', BRIGHTDATA_TOKEN: '   ' }, { BRIGHTDATA_ZONE: 'z', SB_CREDIT_BUDGET: '5' }]) {
    const r = monitor.assertMonitorScraperEnv(env);
    assert.equal(r.ok, false, JSON.stringify(env));
    assert.deepEqual(r.missing, [...monitor.SCRAPER_CREDENTIAL_KEYS]);
  }
});

test('assertMonitorScraperEnv: ScrapingDog alone does not count when scraper.js has it switched off', () => {
  assert.equal(monitor.assertMonitorScraperEnv({ SCRAPINGDOG_API_KEY: 'sd', SCRAPER_USE_SCRAPINGDOG: '0' }).ok, false);
  assert.equal(monitor.assertMonitorScraperEnv({ SCRAPINGDOG_API_KEY: 'sd', SCRAPER_USE_SCRAPINGDOG: '1' }).ok, true);
});

test('credential keys are a subset of the forwarded SCRAPER_ENV_KEYS (one list, no drift)', () => {
  for (const k of monitor.SCRAPER_CREDENTIAL_KEYS) assert.ok(monitor.SCRAPER_ENV_KEYS.includes(k), k);
  // and a key the preflight accepts is actually forwarded into the pass env
  const env = monitor.buildMonitorPassEnv({ BROWSERBASE_API_KEY: 'bb' }, { authMode: 'oauth' });
  assert.equal(monitor.assertMonitorScraperEnv(env).ok, true);
});

test('preflightScraperEnv: keys present -> proceeds, no alert', async () => {
  alerts.length = 0;
  const ok = await launcher.preflightScraperEnv({ env: SCRAPER_KEYS_ON, key: 'k1', windows: WINDOWS, now: NOW });
  assert.equal(ok, true);
  assert.equal(alerts.length, 0);
});

test('preflightScraperEnv: keys absent -> one error/human alert shaped like handleAuthFailure', async () => {
  alerts.length = 0;
  const ok = await launcher.preflightScraperEnv({ env: {}, key: 'k1', windows: WINDOWS, now: NOW });
  assert.equal(ok, false);
  assert.equal(alerts.length, 1);
  const a = alerts[0];
  assert.equal(a.conditionKey, 'on-monitor-scraper-env-missing-k1');
  assert.equal(a.severity, 'error');
  assert.equal(a.disposition, 'human');
  assert.equal(a.cooldownHours, 6);
  assert.match(a.description, /test-show-2026/);
  for (const k of monitor.SCRAPER_CREDENTIAL_KEYS) assert.match(a.description, new RegExp(k));
});

// Shared harness for driving the real main() with fs writes / auth mocked.
function mockTick(t, { env, authResult }) {
  const saved = {};
  for (const k of [...monitor.SCRAPER_CREDENTIAL_KEYS, 'ON_MONITOR_DISABLED', 'ON_MONITOR_AUTH_CONFIRM_DELAY_MS']) { saved[k] = process.env[k]; delete process.env[k]; }
  // No real 30s wait between the confirm re-probes in tests.
  Object.assign(process.env, { ON_MONITOR_AUTH_CONFIRM_DELAY_MS: '0' }, env);
  t.after(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  const writes = [];
  const shows = { shows: [{ id: 'test-show-2026', title: 'Test Show', category: 'broadway', status: 'previews', openingDate: '2026-10-12' }] };
  const enoent = p => Object.assign(new Error(`ENOENT (mocked): ${p}`), { code: 'ENOENT' });
  const realRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    const s = String(p);
    if (s.endsWith(path.join('data', 'shows.json'))) return JSON.stringify(shows);
    if (s.startsWith(MAIN_REPO_ROOT + path.sep) && !/\.(c|m)?js$/.test(s)) throw enoent(s);
    return realRead.call(fs, p, ...rest);
  });
  t.mock.method(fs, 'existsSync', () => false);
  t.mock.method(fs, 'readdirSync', p => { throw enoent(p); });
  for (const m of ['writeFileSync', 'mkdirSync', 'rmSync', 'renameSync', 'appendFileSync']) {
    t.mock.method(fs, m, (p) => { writes.push([m, String(p)]); });
  }
  const authPing = t.mock.method(cliAuth, 'preflightAuth', () => authResult);
  t.mock.method(console, 'log', () => {});
  return { writes, authPing };
}

// Full keyless tick through the real main(): fs writes, auth and the pass are
// mocked; asserts exactly one alert, return 1, and no auth ping / lock /
// attempt write.
test('keyless launcher tick: exactly one alert, no auth ping, no lock, no attempt consumed', async (t) => {
  alerts.length = 0;
  const { writes, authPing } = mockTick(t, { env: {}, authResult: { ok: true, mode: 'oauth' } });

  const code = await launcher.main(['--show', 'test-show-2026']);

  assert.equal(code, 1, 'keyless tick must exit non-zero');
  assert.equal(alerts.length, 1, `exactly one alert expected, got ${alerts.map(a => a.conditionKey).join(', ')}`);
  assert.match(alerts[0].conditionKey, /^on-monitor-scraper-env-missing-/);
  assert.equal(authPing.mock.callCount(), 0, 'auth ping must not run on a keyless tick');
  assert.deepEqual(writes.filter(([, p]) => /monitor\.lock|night-state-|auth-starved-/.test(p)), [],
    'no lock taken and no night-state / attempt write');
});

// Positive control: the same tick WITH a key gets past the preflight and
// reaches the auth ping (stopped there by a mocked auth failure), proving the
// keyless test above is exercising the new gate, not some earlier exit.
test('keyed launcher tick: preflight passes and the auth ping runs', async (t) => {
  alerts.length = 0;
  const { authPing } = mockTick(t, {
    env: { BRIGHTDATA_TOKEN: 'bd-test' },
    authResult: { ok: false, reason: 'auth-rejected', detail: 'mocked' },
  });
  const code = await launcher.main(['--show', 'test-show-2026']);
  assert.equal(code, 1);
  assert.equal(authPing.mock.callCount(), 2, 'a failed ping is re-probed once (probeWithConfirm) before paging');
  assert.equal(alerts.filter(a => /scraper-env-missing/.test(a.conditionKey)).length, 0);
  assert.equal(alerts.filter(a => /^on-monitor-auth-failed-/.test(a.conditionKey)).length, 1);
});
