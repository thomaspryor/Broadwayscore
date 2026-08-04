/**
 * Unit tests for scripts/lib/brightdata-caps.js (Scraping cost v3 S2-T1).
 *
 * Run: node --test scripts/lib/brightdata-caps.test.mjs
 *
 * Production code requires this module — change a decision function, these
 * fail. That is the point (CLAUDE.md rule 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const caps = require('./brightdata-caps.js');

const {
  DEFAULT_DAILY_REQ_CEILING,
  resolveDailyCeiling,
  resolvePerRunBudget,
  resolveExemptPerRunBudget,
  resolveExemptScripts,
  shouldTripBreaker,
  isExemptCaller,
  checkPerRunBudget,
  isBreakerActiveForZone,
  breakerAlertSeverity,
  utcDay,
  consultBrightData,
  getBrightDataRunStats,
  _resetForTests,
} = caps;

// ---------- resolvers ----------

test('resolveDailyCeiling: default when env unset', () => {
  assert.equal(resolveDailyCeiling({}), DEFAULT_DAILY_REQ_CEILING);
});

test('resolveDailyCeiling: honors a positive override', () => {
  assert.equal(resolveDailyCeiling({ BD_BREAKER_CEILING: '1' }), 1);
  assert.equal(resolveDailyCeiling({ BD_BREAKER_CEILING: '9000' }), 9000);
});

test('resolveDailyCeiling: garbage/zero/negative fall back, never NaN or 0', () => {
  for (const bad of ['', 'abc', '0', '-5', undefined]) {
    assert.equal(resolveDailyCeiling({ BD_BREAKER_CEILING: bad }), DEFAULT_DAILY_REQ_CEILING, `input ${JSON.stringify(bad)}`);
  }
});

test('resolvePerRunBudget: 0 is a legitimate explicit value (unlimited), garbage also 0', () => {
  assert.equal(resolvePerRunBudget({}), 0);
  assert.equal(resolvePerRunBudget({ BD_REQ_BUDGET: '0' }), 0);
  assert.equal(resolvePerRunBudget({ BD_REQ_BUDGET: 'abc' }), 0);
  assert.equal(resolvePerRunBudget({ BD_REQ_BUDGET: '-3' }), 0);
  assert.equal(resolvePerRunBudget({ BD_REQ_BUDGET: '500' }), 500);
});

test('resolveExemptPerRunBudget: separate pool from the bulk budget', () => {
  const env = { BD_REQ_BUDGET: '10', BD_REQ_BUDGET_OPENING_NIGHT: '900' };
  assert.equal(resolvePerRunBudget(env), 10);
  assert.equal(resolveExemptPerRunBudget(env), 900);
});

test('resolveExemptScripts: default list, env override, blank env ignored', () => {
  assert.ok(resolveExemptScripts({}).includes('opening-night-poller.js'));
  assert.deepEqual(resolveExemptScripts({ BD_EXEMPT_SCRIPTS: 'a.js, b.js' }), ['a.js', 'b.js']);
  assert.ok(resolveExemptScripts({ BD_EXEMPT_SCRIPTS: '   ' }).includes('opening-night-poller.js'));
});

// ---------- shouldTripBreaker ----------

test('shouldTripBreaker: over and exactly at the ceiling both trip', () => {
  assert.equal(shouldTripBreaker({ billedReqs: 4000, ceiling: 3500 }).tripped, true);
  assert.equal(shouldTripBreaker({ billedReqs: 3500, ceiling: 3500 }).tripped, true);
});

test('shouldTripBreaker: under the ceiling does not trip', () => {
  assert.equal(shouldTripBreaker({ billedReqs: 3499, ceiling: 3500 }).tripped, false);
  assert.equal(shouldTripBreaker({ billedReqs: 0, ceiling: 3500 }).tripped, false);
});

test('shouldTripBreaker: unknown billing is NOT zero and NOT over — fails open', () => {
  for (const bad of [null, undefined, NaN, 'lots']) {
    const v = shouldTripBreaker({ billedReqs: bad, ceiling: 3500 });
    assert.equal(v.tripped, false, `input ${String(bad)}`);
    assert.equal(v.reason, 'unknown-billing');
  }
});

test('shouldTripBreaker: a missing/zero ceiling never trips', () => {
  assert.equal(shouldTripBreaker({ billedReqs: 99999, ceiling: 0 }).reason, 'no-ceiling');
  assert.equal(shouldTripBreaker({ billedReqs: 99999, ceiling: NaN }).tripped, false);
});

// ---------- isExemptCaller ----------

test('isExemptCaller: allowlisted script, bare and full path', () => {
  const list = ['opening-night-poller.js'];
  assert.equal(isExemptCaller('opening-night-poller.js', list), true);
  assert.equal(isExemptCaller('/repo/scripts/opening-night-poller.js', list), true);
});

test('isExemptCaller: non-allowlisted bulk script is not exempt', () => {
  assert.equal(isExemptCaller('collect-review-texts.js', ['opening-night-poller.js']), false);
  assert.equal(isExemptCaller('gather-reviews.js', ['opening-night-poller.js']), false);
});

test('isExemptCaller: an Opening Night workflow exempts every step, including collect-review-texts', () => {
  // opening-night-poller.yml runs `collect-review-texts.js --aggressive` in the
  // same chain — the script allowlist alone would starve it.
  assert.equal(isExemptCaller('collect-review-texts.js', [], 'Opening Night Poller'), true);
  assert.equal(isExemptCaller('collect-review-texts.js', [], 'opening night orchestrator'), true);
});

test('isExemptCaller: a non-opening-night workflow does not exempt', () => {
  assert.equal(isExemptCaller('collect-review-texts.js', [], 'Collect Review Texts'), false);
  assert.equal(isExemptCaller('collect-review-texts.js', [], 'Rebuild Reviews Data'), false);
});

test('isExemptCaller: garbage script names are handled', () => {
  assert.equal(isExemptCaller(null, ['a.js']), false);
  assert.equal(isExemptCaller('', ['a.js']), false);
  assert.equal(isExemptCaller('a.js', null), false);
});

// ---------- checkPerRunBudget ----------

test('checkPerRunBudget: 0 budget means unlimited', () => {
  assert.equal(checkPerRunBudget({ used: 99999, budget: 0 }).allowed, true);
});

test('checkPerRunBudget: blocks at and above the limit, allows below', () => {
  assert.equal(checkPerRunBudget({ used: 9, budget: 10 }).allowed, true);
  assert.equal(checkPerRunBudget({ used: 10, budget: 10 }).allowed, false);
  assert.equal(checkPerRunBudget({ used: 11, budget: 10 }).allowed, false);
});

// ---------- isBreakerActiveForZone ----------

const TRIPPED = (day) => ({ zones: { web_unlocker2: { day, trippedAt: '2026-08-04T12:00:00.000Z', billedReqs: 4000, ceiling: 3500 } } });

test('isBreakerActiveForZone: same zone + same day blocks', () => {
  assert.equal(isBreakerActiveForZone(TRIPPED('2026-08-04'), { zone: 'web_unlocker2', day: '2026-08-04' }), true);
});

test('isBreakerActiveForZone: yesterday’s state expires with its day', () => {
  // A missed hourly clearing run must not block a fresh day's traffic.
  assert.equal(isBreakerActiveForZone(TRIPPED('2026-08-03'), { zone: 'web_unlocker2', day: '2026-08-04' }), false);
});

test('isBreakerActiveForZone: a trip on one zone does not block the other', () => {
  assert.equal(isBreakerActiveForZone(TRIPPED('2026-08-04'), { zone: 'serp_api1', day: '2026-08-04' }), false);
});

test('isBreakerActiveForZone: absent/garbage state never blocks', () => {
  for (const s of [null, undefined, {}, { zones: {} }, { zones: { web_unlocker2: null } }, 'nope']) {
    assert.equal(isBreakerActiveForZone(s, { zone: 'web_unlocker2', day: '2026-08-04' }), false);
  }
});

test('isBreakerActiveForZone: an entry without trippedAt is a cleared entry', () => {
  const cleared = { zones: { web_unlocker2: { day: '2026-08-04', trippedAt: null, billedReqs: 12 } } };
  assert.equal(isBreakerActiveForZone(cleared, { zone: 'web_unlocker2', day: '2026-08-04' }), false);
});

// ---------- severity + utcDay ----------

test('breakerAlertSeverity: critical only while a show is in an opening window', () => {
  assert.equal(breakerAlertSeverity({ tripped: true, openingWindowShows: 2 }), 'critical');
  assert.equal(breakerAlertSeverity({ tripped: true, openingWindowShows: 0 }), 'warn');
  assert.equal(breakerAlertSeverity({ tripped: false, openingWindowShows: 3 }), 'info');
});

test('utcDay: UTC, not local', () => {
  assert.equal(utcDay(new Date('2026-08-04T23:30:00.000Z')), '2026-08-04');
  assert.equal(utcDay(new Date('2026-08-05T00:30:00.000Z')), '2026-08-05');
});

// ---------- consultBrightData (stateful) ----------

function withStateFile(state) {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bdcaps-')), 'bd-circuit-breaker.json');
  if (state !== null) fs.writeFileSync(p, JSON.stringify(state));
  return p;
}

test('consultBrightData: no breaker, no budget → allowed and counted', () => {
  _resetForTests();
  const env = { BD_BREAKER_STATE_PATH: withStateFile({}) };
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).allowed, true);
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).allowed, true);
  assert.equal(getBrightDataRunStats().bulkUsed, 2);
  assert.equal(getBrightDataRunStats().blocked, 0);
});

test('consultBrightData: tripped breaker blocks a bulk caller without throwing', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { BD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)) };
  const v = consultBrightData({ zone: 'web_unlocker2', env });
  assert.equal(v.allowed, false);
  assert.equal(v.reason, 'breaker');
  assert.equal(getBrightDataRunStats().blockedByBreaker, 1);
  assert.equal(getBrightDataRunStats().bulkUsed, 0, 'a blocked call must not consume budget');
});

test('consultBrightData: opening-night caller fetches normally with the breaker tripped', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = {
    BD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)),
    GITHUB_WORKFLOW: 'Opening Night Poller',
  };
  const v = consultBrightData({ zone: 'web_unlocker2', env });
  assert.equal(v.allowed, true);
  assert.equal(v.exempt, true);
  assert.equal(getBrightDataRunStats().exemptUsed, 1);
  assert.equal(getBrightDataRunStats().bulkUsed, 0, 'exempt traffic must draw on its own allowance');
});

test('consultBrightData: bulk exhaustion does not consume the opening-night allowance', () => {
  _resetForTests();
  const statePath = withStateFile({});
  const bulkEnv = { BD_BREAKER_STATE_PATH: statePath, BD_REQ_BUDGET: '2' };
  const onEnv = { BD_BREAKER_STATE_PATH: statePath, BD_REQ_BUDGET: '2', GITHUB_WORKFLOW: 'Opening Night Poller' };
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env: bulkEnv }).allowed, true);
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env: bulkEnv }).allowed, true);
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env: bulkEnv }).allowed, false, 'bulk pool exhausted');
  // Separate counter, separate budget resolution — the shared-counter design a
  // reviewer flagged would have blocked this call too.
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env: onEnv }).allowed, true);
});

test('consultBrightData: exempt callers honor their OWN per-run budget', () => {
  _resetForTests();
  const env = {
    BD_BREAKER_STATE_PATH: withStateFile({}),
    BD_REQ_BUDGET_OPENING_NIGHT: '1',
    GITHUB_WORKFLOW: 'Opening Night Poller',
  };
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).allowed, true);
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).allowed, false);
});

test('consultBrightData: a missing state file fails open', () => {
  _resetForTests();
  const env = { BD_BREAKER_STATE_PATH: path.join(os.tmpdir(), 'bdcaps-does-not-exist', 'x.json') };
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).allowed, true);
});

test('consultBrightData: a corrupt state file fails open', () => {
  _resetForTests();
  const p = withStateFile({});
  fs.writeFileSync(p, '{not json');
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env: { BD_BREAKER_STATE_PATH: p } }).allowed, true);
});

test('consultBrightData: BD_CAPS_DISABLED=1 is a full kill switch', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { BD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)), BD_CAPS_DISABLED: '1' };
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).allowed, true);
});

test('consultBrightData: the SERP zone is capped independently of the unlocker zone', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { BD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)) };
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).allowed, false);
  assert.equal(consultBrightData({ zone: 'serp_api1', env }).allowed, true);
});

test('consultBrightData: firstBlock is true once, then false — one ledger row per process', () => {
  _resetForTests();
  const day = utcDay(new Date());
  const env = { BD_BREAKER_STATE_PATH: withStateFile(TRIPPED(day)) };
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).firstBlock, true);
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).firstBlock, false);
  assert.equal(consultBrightData({ zone: 'web_unlocker2', env }).firstBlock, false);
  assert.equal(getBrightDataRunStats().blocked, 3, 'every withheld call still counts');
});
