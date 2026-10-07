/**
 * Shared Plans tokens must never reach an analytics tool (BRO-4481).
 * Unit tests for src/lib/analytics/redact-url.ts plus a wiring guard on
 * src/components/AnalyticsWrapper.tsx: if a tool stops routing through the
 * redactor (or a new one is added without it), this fails.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gaInitScript } from '../../src/lib/analytics/ga-init-script';
import {
  isPrivateSharePath, posthogBeforeSend, redactDeep, redactPrivateShareUrl, sentryScrub, vercelBeforeSend,
} from '../../src/lib/analytics/redact-url';

const TOKEN = '3f9c2a7be1d04c58a6f0e9b2c4d81a77';

test('redactPrivateShareUrl: absolute URLs, paths, query and hash', () => {
  assert.equal(redactPrivateShareUrl(`https://broadwayscorecard.com/plans/${TOKEN}`), 'https://broadwayscorecard.com/plans/:token');
  assert.equal(redactPrivateShareUrl(`/plans/${TOKEN}`), '/plans/:token');
  assert.equal(redactPrivateShareUrl(`/plans/${TOKEN}?utm_source=imessage#x`), '/plans/:token?utm_source=imessage#x');
  assert.equal(redactPrivateShareUrl(`/plans/${TOKEN}/opengraph-image`), '/plans/:token/opengraph-image');
  assert.equal(redactPrivateShareUrl(`clicked <a href="/plans/${TOKEN}">`), 'clicked <a href="/plans/:token">');
  assert.equal(redactPrivateShareUrl(redactPrivateShareUrl(`/plans/${TOKEN}`)), '/plans/:token', 'idempotent');
});

test('redactPrivateShareUrl leaves everything else alone', () => {
  for (const s of ['https://broadwayscorecard.com/show/wicked', '/payment-plans/x', '/my-shows?tab=watchlist', 'plans', '/plansomething/x']) {
    assert.equal(redactPrivateShareUrl(s), s);
  }
});

test('redactPrivateShareUrl covers the diary link (/seen) the same way', () => {
  assert.equal(redactPrivateShareUrl(`https://broadwayscorecard.com/seen/${TOKEN}`), 'https://broadwayscorecard.com/seen/:token');
  assert.equal(redactPrivateShareUrl(`/seen/${TOKEN}?utm_source=x`), '/seen/:token?utm_source=x');
  assert.equal(redactPrivateShareUrl(`/sign-in?next=%2Fseen%2F${TOKEN}`), '/sign-in?next=%2Fseen%2F%3Atoken');
  assert.ok(isPrivateSharePath(`/seen/${TOKEN}`));
  assert.ok(!isPrivateSharePath('/seenx'));
});

test('isPrivateSharePath', () => {
  assert.ok(isPrivateSharePath(`/plans/${TOKEN}`));
  assert.ok(!isPrivateSharePath('/show/plans'));
  assert.ok(!isPrivateSharePath('/plansx'));
});

test('posthogBeforeSend scrubs every property, nested too', () => {
  const ev = posthogBeforeSend({
    event: '$pageview',
    properties: {
      $current_url: `https://broadwayscorecard.com/plans/${TOKEN}`,
      $pathname: `/plans/${TOKEN}`,
      $referrer: `https://broadwayscorecard.com/plans/${TOKEN}`,
      $initial_current_url: `https://broadwayscorecard.com/plans/${TOKEN}?x=1`,
      $elements: [{ attr__href: `/plans/${TOKEN}`, tag_name: 'a' }],
      count: 3,
    },
  });
  assert.ok(!JSON.stringify(ev).includes(TOKEN));
  assert.equal(ev.properties!.count, 3);
  assert.equal(posthogBeforeSend(null), null);
});

test('vercelBeforeSend scrubs url and keeps the rest', () => {
  const ev = vercelBeforeSend({ type: 'pageview' as const, url: `https://broadwayscorecard.com/plans/${TOKEN}` });
  assert.deepEqual(ev, { type: 'pageview', url: 'https://broadwayscorecard.com/plans/:token' });
});

test('sentryScrub scrubs request URL and breadcrumbs', () => {
  const ev = sentryScrub({
    request: { url: `https://broadwayscorecard.com/plans/${TOKEN}`, headers: { Referer: `https://broadwayscorecard.com/plans/${TOKEN}` } },
    breadcrumbs: [{ category: 'navigation', data: { from: `/plans/${TOKEN}`, to: '/show/wicked' } }],
    exception: { values: [{ stacktrace: { frames: [{ filename: 'https://broadwayscorecard.com/_next/x.js' }] } }] },
  });
  assert.ok(!JSON.stringify(ev).includes(TOKEN));
  assert.equal(ev.breadcrumbs[0].data.to, '/show/wicked');
});

test('percent-encoded plans paths are redacted too', () => {
  assert.equal(redactPrivateShareUrl(`/sign-in?next=%2Fplans%2F${TOKEN}`), '/sign-in?next=%2Fplans%2F%3Atoken');
  assert.equal(redactPrivateShareUrl(`sms:?body=https%3A%2F%2Fbroadwayscorecard.com%2Fplans%2F${TOKEN}%3Futm%3Dx`),
    'sms:?body=https%3A%2F%2Fbroadwayscorecard.com%2Fplans%2F%3Atoken%3Futm%3Dx');
});

test('posthogBeforeSend covers $set / $set_once and skips $snapshot', () => {
  const ev = posthogBeforeSend({
    event: '$pageview', properties: {}, $set_once: { $initial_current_url: `https://broadwayscorecard.com/plans/${TOKEN}` },
  });
  assert.ok(!JSON.stringify(ev).includes(TOKEN));
  const snap = { event: '$snapshot', properties: { $snapshot_data: 'gzipped-opaque' } };
  assert.equal(posthogBeforeSend(snap), snap, '$snapshot passes through untouched (same object)');
});

test('redactDeep leaves non-plain objects and primitives alone and survives deep nesting', () => {
  const d = new Date(0);
  assert.equal(redactDeep(d), d);
  assert.equal(redactDeep(5), 5);
  let deep: Record<string, unknown> = { s: `/plans/${TOKEN}` };
  for (let i = 0; i < 20; i++) deep = { deep };
  assert.doesNotThrow(() => redactDeep(deep));
});

// ------------------------------------------------------------ GA script ----
function runGa(pathname: string, referrer: string, owner = false) {
  const win: Record<string, unknown> = {};
  const calls: unknown[][] = [];
  const dataLayer: unknown[] = [];
  const fn = new Function('window', 'location', 'document', 'localStorage', 'dataLayer',
    gaInitScript('G-TEST123'));
  fn(win, { pathname }, { referrer }, { getItem: () => (owner ? 'true' : null) }, dataLayer);
  for (const a of dataLayer) calls.push(Array.from(a as ArrayLike<unknown>));
  return { win, config: calls.find(c => c[0] === 'config') };
}

test('GA bootstrap: switched off on a plans page, on elsewhere', () => {
  assert.equal(runGa(`/plans/${TOKEN}`, '').win['ga-disable-G-TEST123'], true);
  assert.equal(runGa('/show/wicked', '').win['ga-disable-G-TEST123'], undefined);
});

test('GA bootstrap: a plans URL as referrer is redacted; ordinary config unchanged', () => {
  const r1 = runGa('/show/wicked', `https://broadwayscorecard.com/plans/${TOKEN}`);
  assert.deepEqual(r1.config, ['config', 'G-TEST123', { page_referrer: 'https://broadwayscorecard.com/plans/:token' }]);
  assert.deepEqual(runGa('/', 'https://google.com/').config, ['config', 'G-TEST123', {}]);
  assert.deepEqual(runGa('/', '', true).config, ['config', 'G-TEST123', { traffic_type: 'internal' }], 'owner tagging kept');
});

// ---------------------------------------------------------------- wiring ----
const wrapper = readFileSync(join(__dirname, '..', '..', 'src', 'components', 'AnalyticsWrapper.tsx'), 'utf-8');

test('wiring: every analytics tool in AnalyticsWrapper routes through the redactor', () => {
  assert.match(wrapper, /before_send:\s*posthogBeforeSend/, 'PostHog before_send');
  assert.match(wrapper, /disable_session_recording:\s*isPrivateSharePath\(/, 'PostHog replay off on /plans');
  assert.match(wrapper, /<Analytics\s+beforeSend=\{vercelBeforeSend\}/, 'Vercel Analytics');
  assert.match(wrapper, /<SpeedInsights\s+beforeSend=\{vercelBeforeSend\}/, 'Speed Insights');
  assert.match(wrapper, /return hasOurCode \? sentryScrub\(event\) : null/, 'Sentry beforeSend');
  assert.match(wrapper, /beforeBreadcrumb:\s*sentryScrub/, 'Sentry breadcrumbs');
  assert.match(wrapper, /\{gaInitScript\(GA_MEASUREMENT_ID\)\}/, 'GA bootstrap comes from the tested gaInitScript');
  assert.match(wrapper, /`ga-disable-\$\{GA_MEASUREMENT_ID\}`\]\s*=\s*onPlans/, 'GA toggled on client navigation');
  assert.match(wrapper, /stopSessionRecording/, 'PostHog replay stopped on client navigation into /plans');
});

test('wiring: no analytics tool is initialised that this test does not know about', () => {
  const known = ['posthog.init(', '<Analytics', '<SpeedInsights', 'SentrySDK.init(', "gtag('config'"];
  const inits = wrapper.match(/\b\w+\.init\(|<[A-Z]\w*Insights?\b|<Analytics\b|gtag\('config'/g) ?? [];
  for (const i of inits) {
    assert.ok(known.some(k => i.startsWith(k.replace('(', '')) || k.startsWith(i)), `unreviewed analytics init: ${i}`);
  }
});

test('isAuthCallbackPath: replay stays off on the OAuth return page (BRO-4525)', async () => {
  const { isAuthCallbackPath } = await import('../../src/lib/analytics/redact-url');
  assert.equal(isAuthCallbackPath('/auth/callback'), true);
  assert.equal(isAuthCallbackPath('/auth/complete'), true);
  assert.equal(isAuthCallbackPath('/auth/apple-callback'), false);
  assert.equal(isAuthCallbackPath('/my-shows'), false);
});

test('OAuth tokens in a URL hash or query are scrubbed (BRO-4525)', async () => {
  const { redactPrivateShareUrl, sentryScrub } = await import('../../src/lib/analytics/redact-url');
  const url = 'https://broadwayscorecard.com/auth/callback#access_token=eyJhbGciOi.abc&expires_in=3600&refresh_token=r3fr35h&provider_token=pt&provider_refresh_token=prt&type=bearer';
  const out = redactPrivateShareUrl(url);
  for (const secret of ['eyJhbGciOi', 'r3fr35h', '=pt&', '=prt&']) assert.ok(!out.includes(secret), `${secret} leaked: ${out}`);
  assert.match(out, /access_token=:redacted/);
  assert.match(out, /expires_in=3600/, 'non-secret params stay');
  // and through a payload walker, as Sentry sends it
  assert.ok(!JSON.stringify(sentryScrub({ request: { url } })).includes('r3fr35h'));
});
