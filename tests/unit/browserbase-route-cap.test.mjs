/**
 * BRO-5222 gap 2: a WSJ row whose Browserbase route was skipped at a session
 * cap must be recorded as a deferral (route_not_attempted_cap), retried on a
 * later day, never counted toward retirement, and never reported as blocked.
 * Requires the real functions (CLAUDE.md 15).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  ROUTE_CAPPED_REASON, MAX_ROUTE_CAPPED_DEFERRALS, classifyFetchFailure, routeCapFromBrowserbaseError, applyRouteCapDeferralLimit,
  isRouteCapCooldownActive, shouldCountFailure, isPermanentlyFailed,
} = require('../../scripts/lib/failed-fetch-policy.js');
const { checkBrowserbaseCaps, resolveRecoveryReserve, resolveUseReserve } = require('../../scripts/lib/browserbase-caps.js');
const { pinBrowserbaseFirst, isBrowserbaseFirstDomain } = require('../../scripts/lib/browserbase-route.js');
const { tallyFileAttempts } = require('../../scripts/lib/tier-attempt-stats.js');
const { classifyIncompleteReason } = require('../../scripts/lib/incomplete-reason.js');

test('classifyFetchFailure: capped Browserbase route is a deferral, 404 and BD cap win', () => {
  const msg = 'All tiers failed: [...]';
  assert.equal(classifyFetchFailure({ message: msg, routeCapped: 'day' }), ROUTE_CAPPED_REASON);
  assert.equal(classifyFetchFailure({ message: 'TIMEOUT: Review took >90s', routeCapped: 'run' }), ROUTE_CAPPED_REASON);
  assert.equal(classifyFetchFailure({ message: 'URL returned 404', routeCapped: 'day' }), 'url_dead_404');
  assert.equal(classifyFetchFailure({ message: msg, bdWasCapped: true, routeCapped: 'day' }), 'budget_capped');
  assert.equal(classifyFetchFailure({ message: 'TIMEOUT: Review took >90s' }), 'all_tiers_timeout');
  assert.equal(classifyFetchFailure({ message: msg }), 'all_tiers_failed');
  assert.equal(classifyFetchFailure({ message: 'socket hang up' }), 'fetch_error');
});

test('capped-route failures never count or retire; the deferral limit then counts', () => {
  assert.equal(shouldCountFailure(ROUTE_CAPPED_REASON), false);
  assert.equal(isPermanentlyFailed({ failureReason: ROUTE_CAPPED_REASON, failureCount: 17 }), false);
  let entry = null;
  for (let i = 1; i <= MAX_ROUTE_CAPPED_DEFERRALS; i++) {
    const r = applyRouteCapDeferralLimit(ROUTE_CAPPED_REASON, entry);
    assert.equal(r.reason, ROUTE_CAPPED_REASON);
    assert.equal(r.cappedDeferrals, i);
    entry = { cappedDeferrals: r.cappedDeferrals };
  }
  const over = applyRouteCapDeferralLimit(ROUTE_CAPPED_REASON, entry);
  assert.equal(over.reason, 'all_tiers_failed');
  assert.equal(shouldCountFailure(over.reason), true);
  // Other reasons pass through and keep the tally.
  assert.deepEqual(applyRouteCapDeferralLimit('url_dead_404', { cappedDeferrals: 2 }), { reason: 'url_dead_404', cappedDeferrals: 2 });
});

test('capped-route cooldown holds for the rest of the UTC day only', () => {
  const entry = { failureReason: ROUTE_CAPPED_REASON, lastCappedAt: '2026-10-12T09:15:00.000Z' };
  assert.equal(isRouteCapCooldownActive(entry, new Date('2026-10-12T23:59:00Z')), true);
  assert.equal(isRouteCapCooldownActive(entry, new Date('2026-10-13T00:01:00Z')), false);
  assert.equal(isRouteCapCooldownActive({ ...entry, failureReason: 'budget_capped' }, new Date('2026-10-12T10:00:00Z')), false);
  assert.equal(isRouteCapCooldownActive(null), false);
});

test('recovery reserve: general runs stop short of the ceiling, opted-in runs may use it', () => {
  const base = { sessionsThisRun: 0, sessionsPerDomain: {}, urlDomain: 'wsj.com' };
  const config = { maxPerDay: 250, maxPerRun: 30, maxPerDomain: 10, reserve: 30 };
  assert.deepEqual(
    checkBrowserbaseCaps({ ...base, sessionsToday: 220, config }),
    { allowed: false, reason: 'day', limit: 220, used: 220 },
  );
  assert.equal(checkBrowserbaseCaps({ ...base, sessionsToday: 220, config: { ...config, useReserve: true } }).allowed, true);
  assert.equal(checkBrowserbaseCaps({ ...base, sessionsToday: 250, config: { ...config, useReserve: true } }).allowed, false);
  // No reserve configured: unchanged behaviour.
  assert.equal(checkBrowserbaseCaps({ ...base, sessionsToday: 249, config: { maxPerDay: 250, maxPerRun: 30, maxPerDomain: 10 } }).allowed, true);
  assert.equal(resolveRecoveryReserve({}), 30);
  assert.equal(resolveRecoveryReserve({ BROWSERBASE_RECOVERY_RESERVE: '0' }), 0);
  assert.equal(resolveRecoveryReserve({ BROWSERBASE_RECOVERY_RESERVE: 'x' }), 30);
  assert.equal(resolveUseReserve({ BROWSERBASE_USE_RESERVE: 'true' }), true);
  assert.equal(resolveUseReserve({ BROWSERBASE_USE_RESERVE: '' }), false);
  assert.equal(resolveUseReserve({}), false);
});

test('WSJ chain: Browserbase pinned ahead of paid tiers, restored after the skip list', () => {
  const t = (id) => ({ id });
  // Learned wsj.com order from domain-tier-order.json (no browserbase).
  const learned = ['direct-cookies', 'archive-first', 'brightdata', 'archive-cdx', 'scrapingbee'].map(t);
  const built = [t('archive-first'), t('browserbase'), t('direct-cookies'), t('brightdata')];
  assert.deepEqual(pinBrowserbaseFirst(learned, 'www.wsj.com', built).map(x => x.id),
    ['direct-cookies', 'browserbase', 'archive-first', 'brightdata', 'archive-cdx', 'scrapingbee']);
  assert.deepEqual(pinBrowserbaseFirst([t('brightdata'), t('browserbase')], 'online.wsj.com').map(x => x.id),
    ['browserbase', 'brightdata']);
  // Other domains untouched, including look-alikes.
  const thr = [t('direct-cookies'), t('brightdata'), t('browserbase')];
  assert.equal(pinBrowserbaseFirst(thr, 'www.hollywoodreporter.com', built), thr);
  assert.equal(isBrowserbaseFirstDomain('notwsj.com'), false);
  assert.equal(isBrowserbaseFirstDomain('newyorker.com'), false);
});

test('a cap-skipped Browserbase attempt is not tallied as a tier failure', () => {
  const stats = {};
  const data = {
    fetchAttempts: [
      { tier: 1.5, method: 'browserbase', success: false, error: 'Browserbase not attempted: day cap reached', skipped: true },
      { tier: 3, method: 'brightdata', success: false, error: 'TIMEOUT' },
    ],
  };
  tallyFileAttempts(stats, 'wsj.com', data, (method) => method);
  assert.equal(stats['wsj.com'].browserbase, undefined);
  assert.equal(stats['wsj.com'].brightdata.failures, 1);
});

test('incompleteReason for a capped route is route_capped, never bot_blocked', () => {
  const review = { url: 'https://www.wsj.com/articles/x', fullText: '', contentTier: 'stub' };
  const r = classifyIncompleteReason(review, { failureReason: ROUTE_CAPPED_REASON, failureCount: 0, routeCapped: 'day' });
  assert.equal(r.incompleteReason, 'route_capped');
  assert.match(r.incompleteDetail, /day cap/);
});

test('session-create chokepoint refusal (opening-window reserve) is a day route cap, not a fetch failure', async () => {
  // Drive the real chokepoint to its refusal and use the message it throws
  // (BRO-5222 run 38349583783: "Browserbase daily cap reached (150/135 (raw
  // ceiling 250, reduced for opening-window reserve))" landed as bot_blocked).
  const realMsg = 'Browserbase daily cap reached (150/135 (raw ceiling 250, reduced for opening-window reserve)) — session create blocked for collect-review-texts.js';
  assert.equal(routeCapFromBrowserbaseError(realMsg), 'day');
  assert.equal(routeCapFromBrowserbaseError('Browserbase daily cap reached (250/250) — session create blocked for x'), 'day');
  assert.equal(classifyFetchFailure({ message: 'All tiers failed: [...]', routeCapped: routeCapFromBrowserbaseError(realMsg) }), ROUTE_CAPPED_REASON);
  // Not caps: kill switch, a real fetch error, a 404 still wins.
  assert.equal(routeCapFromBrowserbaseError('Browserbase kill switch active (BROWSERBASE_KILL_SWITCH=true)'), null);
  assert.equal(routeCapFromBrowserbaseError('Insufficient text: 429 chars'), null);
  assert.equal(routeCapFromBrowserbaseError(undefined), null);
  assert.equal(classifyFetchFailure({ message: 'HTTP 404', routeCapped: 'day' }), 'url_dead_404');
});

test('chokepoint message format still matches what browserbase-session.js throws', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/lib/browserbase-session.js', import.meta.url), 'utf8');
  const m = src.match(/throw (?:new Error|refusal)\(`(Browserbase daily cap reached[^`]*)`\)/);
  assert.ok(m, 'browserbase-session.js no longer throws the day-cap message this mapping keys on');
  assert.equal(routeCapFromBrowserbaseError(m[1]), 'day');
});

test('collector local-limit refusal after a mid-run resync is a cap only when the local block reason says so', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/collect-review-texts.js', import.meta.url), 'utf8');
  const m = src.match(/throw new Error\('(Browserbase unavailable[^']*)'\)/);
  assert.ok(m, 'collect-review-texts.js no longer throws the local-limit message this mapping keys on');
  assert.equal(routeCapFromBrowserbaseError(m[1], 'day'), 'day');
  assert.equal(routeCapFromBrowserbaseError(m[1], 'run'), 'run');
  assert.equal(routeCapFromBrowserbaseError(m[1], 'domain'), 'domain');
  // Not configured or kill switch is not a cap; neither is an unblocked state.
  assert.equal(routeCapFromBrowserbaseError(m[1], 'disabled'), null);
  assert.equal(routeCapFromBrowserbaseError(m[1], null), null);
  // A real fetch failure stays a failure even while the cap is now reached.
  assert.equal(routeCapFromBrowserbaseError('Insufficient text: 429 chars', 'day'), null);
});

test('a discovered-URL retry starts without the previous attempt cap mark', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../../scripts/collect-review-texts.js', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('async function fetchReviewText(review) {'));
  assert.match(body.slice(0, 400), /delete review\._browserbaseCapSkipped;/);
});
