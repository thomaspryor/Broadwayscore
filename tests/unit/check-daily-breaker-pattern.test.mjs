import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const { checkDailyBreakerPattern } = require('../../scripts/lib/check-daily-breaker-pattern');
const trip = (conditionKey, day, extra = {}) => ({
  conditionKey, day, ts: `${day}T12:00:00Z`, from: 'ok', to: 'tripped', prevTs: null, ...extra,
});
const web = 'bd-circuit-breaker-web_unlocker2';
const serp = 'bd-circuit-breaker-serp_api1';
const sd = 'sd-circuit-breaker';
const ledger = (rows, extra = {}) => ({ rows, corruptLines: 0, missing: false, unreadable: false, ...extra });
const options = { untilDay: '2026-08-31' };

test('counts distinct UTC days, excludes recovery, shadow and out-of-window rows', () => {
  const rows = [trip(sd, '2026-08-31'), trip(web, '2026-08-31'), trip(serp, '2026-08-31'),
    trip(web, '2026-08-31'), trip(sd, '2026-08-24'), trip(web, '2026-08-24'),
    trip(sd, '2026-09-01'), trip(web, '2026-09-01'), trip(sd, '2026-08-30', { to: 'ok' }),
    trip('sb-circuit-breaker-shadow', '2026-08-30')];
  const out = checkDailyBreakerPattern(ledger(rows), options);
  assert.deepEqual(out.allThree, ['2026-08-31']);
  assert.deepEqual(out.observedDays, ['2026-08-31']);
  assert.equal(out.providers.web.days, 1);
  assert.deepEqual(checkDailyBreakerPattern(ledger(rows.reverse()), options), out);
});

test('distinguishes SD plus either BD zone from all three tripping', () => {
  const out = checkDailyBreakerPattern(ledger([
    trip(web, '2026-08-25'), trip(sd, '2026-08-25'),
    trip(serp, '2026-08-26'), trip(sd, '2026-08-26'),
    trip(web, '2026-08-27'), trip(serp, '2026-08-27'),
  ]), options);
  assert.deepEqual(out.webAndSd, ['2026-08-25']);
  assert.deepEqual(out.serpAndSd, ['2026-08-26']);
  assert.deepEqual(out.allThree, []);
  assert.deepEqual(out.observedDays, ['2026-08-25', '2026-08-26']);
  assert.match(out.summary, /do not prove simultaneous outages or ScrapingBee coverage/);
});

test('incomplete or absent history cannot become a confident clean verdict', () => {
  for (const extra of [{ missing: true }, { unreadable: true }, { corruptLines: 1 }]) {
    const out = checkDailyBreakerPattern(ledger([], extra), options);
    assert.equal(out.incomplete, true);
    assert.match(out.summary, /Incomplete history; at least 0/);
  }
  const out = checkDailyBreakerPattern(ledger([trip(web, '2026-08-31', { prevTs: '2026-08-30T12:00:00Z' })]), options);
  assert.equal(out.incomplete, true);
  assert.match(checkDailyBreakerPattern(ledger([]), options).summary, /missing observations can undercount/);
});

test('supports configured BD zones and validates window arguments', () => {
  const out = checkDailyBreakerPattern(ledger([trip('bd-circuit-breaker-custom', '2026-08-31'), trip(sd, '2026-08-31')]), { ...options, bdZone: 'custom', days: 1 });
  assert.deepEqual(out.webAndSd, ['2026-08-31']);
  assert.equal(out.window.sinceDay, '2026-08-31');
  for (const days of [0, -1, 1.5, NaN, 367]) assert.throws(() => checkDailyBreakerPattern(ledger([]), { ...options, days }), /days/);
  for (const untilDay of ['bad', '2026-02-30']) assert.throws(() => checkDailyBreakerPattern(ledger([]), { untilDay }), /until/);
});

test('CLI reports unavailable history without writing or making network requests', () => {
  const script = require.resolve('../../scripts/lib/check-daily-breaker-pattern');
  const out = spawnSync(process.execPath, [script, '--ledger=/dev/null/missing', '--until=2026-08-31'], { encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  assert.equal(JSON.parse(out.stdout).incomplete, true);
  const invalid = spawnSync(process.execPath, [script, '--days=0'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr, /days/);
});
