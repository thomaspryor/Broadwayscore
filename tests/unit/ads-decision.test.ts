/**
 * AdSense render decision, automation opt-out and UK/EEA/CH region gate
 * (BRO-5893, sprint-plan-adsense.md B-T2/B-T9). Imports the real functions
 * from src/lib/ads.ts and the real middleware (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { NextRequest } from 'next/server';
import {
  ADSENSE_CLIENT,
  AD_REGION_COOKIE,
  AD_SLOTS,
  ADS_TXT_LINE,
  adRegionForCountry,
  decideAdRender,
  isAutomatedBrowser,
  isAutomatedSignals,
  readCookie,
} from '../../src/lib/ads';
import { middleware } from '../../src/middleware';

// The happy path: every gate open.
const ON = {
  variant: 'ads',
  authLoading: false,
  isAuthenticated: false,
  automated: false,
  region: 'ads-ok',
};

test('happy path renders', () => {
  assert.equal(decideAdRender(ON), true);
});

test('unresolved flag (undefined) means no ads', () => {
  assert.equal(decideAdRender({ ...ON, variant: undefined }), false);
});

test('no-ads variant and unknown variants mean no ads', () => {
  assert.equal(decideAdRender({ ...ON, variant: 'no-ads' }), false);
  assert.equal(decideAdRender({ ...ON, variant: 'control' }), false);
});

test('auth still loading means no ads (members never load the script)', () => {
  assert.equal(decideAdRender({ ...ON, authLoading: true }), false);
});

test('signed-in member means no ads', () => {
  assert.equal(decideAdRender({ ...ON, isAuthenticated: true }), false);
});

test('automated browser means no ads', () => {
  assert.equal(decideAdRender({ ...ON, automated: true }), false);
});

test("region 'no-ads', missing or garbage means no ads", () => {
  assert.equal(decideAdRender({ ...ON, region: 'no-ads' }), false);
  assert.equal(decideAdRender({ ...ON, region: undefined }), false);
  assert.equal(decideAdRender({ ...ON, region: 'ADS-OK' }), false);
});

test('slot config is a fixed 300x250 unit', () => {
  assert.equal(AD_SLOTS.showInline.width, 300);
  assert.equal(AD_SLOTS.showInline.height, 250);
});

test('automation: navigator.webdriver', () => {
  assert.equal(isAutomatedSignals({ webdriver: true }), true);
  assert.equal(isAutomatedSignals({ webdriver: false }), false);
});

test('automation: headless / audit user agents', () => {
  for (const ua of [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 HeadlessChrome/120.0 Safari/537.36',
    'Mozilla/5.0 Chrome-Lighthouse',
    'Mozilla/5.0 (Linux; Android 11) Chrome/120 Mobile Safari/537.36 Lighthouse',
    'Mozilla/5.0 Google Page Speed Insights PageSpeed',
    'Mozilla/5.0 GTmetrix',
    'Mozilla/5.0 Playwright/1.48',
  ]) {
    assert.equal(isAutomatedSignals({ userAgent: ua }), true, ua);
  }
  const realSafari =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  assert.equal(isAutomatedSignals({ userAgent: realSafari }), false);
});

test('automation: ?noads=1 query param', () => {
  assert.equal(isAutomatedSignals({ search: '?noads=1' }), true);
  assert.equal(isAutomatedSignals({ search: '?utm_source=x&noads=1' }), true);
  assert.equal(isAutomatedSignals({ search: '?noads=0' }), false);
  assert.equal(isAutomatedSignals({ search: '' }), false);
});

test('automation: bwsc_noads=1 cookie', () => {
  assert.equal(isAutomatedSignals({ cookie: 'a=1; bwsc_noads=1; b=2' }), true);
  assert.equal(isAutomatedSignals({ cookie: 'bwsc_noads=0' }), false);
  assert.equal(isAutomatedSignals({ cookie: 'not_bwsc_noads=1' }), false);
});

test('isAutomatedBrowser: SSR (no window) is treated as automated', () => {
  assert.equal(typeof window, 'undefined');
  assert.equal(isAutomatedBrowser(), true);
});

test('isAutomatedBrowser reads the real browser globals', () => {
  const g = globalThis as Record<string, unknown>;
  const saved = { window: g.window, navigator: Object.getOwnPropertyDescriptor(globalThis, 'navigator'), document: g.document };
  const setBrowser = (webdriver: boolean, search: string, cookie: string) => {
    g.window = { location: { search } };
    Object.defineProperty(globalThis, 'navigator', {
      value: { webdriver, userAgent: 'Mozilla/5.0 (Macintosh) Safari/605.1.15' },
      configurable: true,
    });
    g.document = { cookie };
  };
  try {
    setBrowser(false, '', '');
    assert.equal(isAutomatedBrowser(), false);
    setBrowser(true, '', '');
    assert.equal(isAutomatedBrowser(), true);
    setBrowser(false, '?noads=1', '');
    assert.equal(isAutomatedBrowser(), true);
    setBrowser(false, '', 'bwsc_noads=1');
    assert.equal(isAutomatedBrowser(), true);
  } finally {
    g.window = saved.window;
    g.document = saved.document;
    if (saved.navigator) Object.defineProperty(globalThis, 'navigator', saved.navigator);
  }
});

test('adRegionForCountry: UK/EEA/CH are no-ads', () => {
  for (const c of ['GB', 'IE', 'DE', 'CH', 'NO', 'FR', 'IS', 'LI', 'gb']) {
    assert.equal(adRegionForCountry(c), 'no-ads', c);
  }
});

test('adRegionForCountry: US/CA/AU are ads-ok; empty or junk is no-ads', () => {
  for (const c of ['US', 'CA', 'AU', 'NZ']) assert.equal(adRegionForCountry(c), 'ads-ok', c);
  for (const c of ['', null, undefined, 'XXX', '1']) assert.equal(adRegionForCountry(c), 'no-ads', String(c));
});

test('readCookie parses and decodes', () => {
  assert.equal(readCookie('a=1; bwsc_ad_region=ads-ok', 'bwsc_ad_region'), 'ads-ok');
  assert.equal(readCookie('a=1', 'bwsc_ad_region'), undefined);
  // A malformed %-escape must not throw (it would crash AdSlot's effect).
  assert.equal(readCookie('bwsc_noads=%E0%A4%A', 'bwsc_noads'), '%E0%A4%A');
  assert.equal(isAutomatedSignals({ cookie: 'bwsc_noads=%zz' }), false);
});

// --- middleware region cookie ---

const SHOW = 'https://broadwayscorecard.com/show/not-a-redirect-slug-zz';

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers });
}

function setCookieOf(res: Response | undefined | void) {
  return res ? res.headers.get('set-cookie') || '' : '';
}

test('middleware: US visitor on a show page gets ads-ok', () => {
  const c = setCookieOf(middleware(req(SHOW, { 'x-vercel-ip-country': 'US' })));
  assert.match(c, new RegExp(`${AD_REGION_COOKIE}=ads-ok`));
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=86400/);
  assert.match(c, /SameSite=lax/i);
  assert.doesNotMatch(c, /HttpOnly/i);
});

test('middleware: first-visit UK and German visitors get no cookie at all', () => {
  for (const country of ['GB', 'DE']) {
    assert.equal(middleware(req(SHOW, { 'x-vercel-ip-country': country })), undefined, country);
  }
});

test('middleware: a US visitor who travels to the UK is downgraded to no-ads', () => {
  const c = setCookieOf(
    middleware(req(SHOW, { 'x-vercel-ip-country': 'GB', cookie: `${AD_REGION_COOKIE}=ads-ok` })),
  );
  assert.match(c, new RegExp(`${AD_REGION_COOKIE}=no-ads`));
});

test('middleware: an existing ads-ok cookie is downgraded when the header disappears', () => {
  const c = setCookieOf(middleware(req(SHOW, { cookie: `${AD_REGION_COOKIE}=ads-ok` })));
  assert.match(c, new RegExp(`${AD_REGION_COOKIE}=no-ads`));
});

test('middleware: no write when the cookie already matches, or off /show/', () => {
  assert.equal(
    middleware(req(SHOW, { 'x-vercel-ip-country': 'US', cookie: `${AD_REGION_COOKIE}=ads-ok` })),
    undefined,
  );
  assert.equal(middleware(req('https://broadwayscorecard.com/critics/zz-none', { 'x-vercel-ip-country': 'US' })), undefined);
});

test('committed AdSense ids', () => {
  assert.equal(ADSENSE_CLIENT, 'ca-pub-5443308376628971');
  assert.equal(ADS_TXT_LINE, 'google.com, pub-5443308376628971, DIRECT, f08c47fec0942fa0');
  assert.equal(AD_SLOTS.showInline.id, '3592344699');
});
