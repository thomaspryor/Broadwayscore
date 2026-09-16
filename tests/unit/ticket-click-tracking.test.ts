import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { buildAffiliateUrl, trackTicketClick } from '../../src/lib/affiliate-utils';

const HERE = dirname(fileURLToPath(import.meta.url));
const SHOW_LIST_CARD_PATH = join(HERE, '../../src/components/show-cards/ShowListCard.tsx');

// Strips `//` line comments so source-pattern assertions below check actual
// code, not the prose explaining the bug being guarded against (which
// necessarily quotes the exact strings/calls it's warning against). Safe
// here because ShowListCard.tsx has no `//` inside string literals (no URLs).
function codeOnly(source: string): string {
  return source.split('\n').map(line => line.replace(/\/\/.*$/, '')).join('\n');
}
const showListCardSource = () => codeOnly(readFileSync(SHOW_LIST_CARD_PATH, 'utf-8'));

// BRO-2392: ShowListCard's browse-page ticket CTA used to hand-roll its own
// PostHog sendBeacon call instead of calling trackTicketClick()/
// buildAffiliateUrl() like every other ticket surface. That hand-rolled
// version hardcoded distinct_id to the literal string 'browse-click' (every
// browse-card click collapsed into one fake PostHog person, breaking
// per-user/Impact-subId1 joins) AND hardcoded is_affiliate: true while
// opening the raw, non-affiliate-wrapped URL (real revenue silently lost on
// every browse-card click despite the event claiming otherwise). These tests
// pin the real shared helpers' behavior so a future hand-rolled tracking
// call regresses loudly instead of shipping quietly.

function withMockedBrowser(distinctId: string | undefined, fn: () => void) {
  const sentBeacons: { url: string; body: string }[] = [];
  const originalWindow = (globalThis as Record<string, unknown>).window;
  // Node's global `navigator` binding is a getter-only accessor when present
  // (can't be reassigned) — stub the one method we need on the existing
  // object. But the binding itself is only stable Node 21+ (CI runs Node
  // 20, which has no global `navigator` at all), so fall back to defining
  // one for the duration of the test.
  const hadNavigator = 'navigator' in globalThis;
  const nav = (hadNavigator ? globalThis.navigator : {}) as Record<string, unknown>;
  if (!hadNavigator) {
    Object.defineProperty(globalThis, 'navigator', { value: nav, configurable: true });
  }
  const originalSendBeacon = nav.sendBeacon;
  (globalThis as Record<string, unknown>).window = {
    posthog: distinctId !== undefined ? { get_distinct_id: () => distinctId } : undefined,
    location: { href: 'https://broadwayscorecard.com/browse' },
  };
  nav.sendBeacon = (url: string, body: string) => {
    sentBeacons.push({ url, body });
    return true;
  };
  try {
    fn();
  } finally {
    (globalThis as Record<string, unknown>).window = originalWindow;
    nav.sendBeacon = originalSendBeacon;
    if (!hadNavigator) {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  }
  return sentBeacons;
}

test('trackTicketClick sends the real PostHog distinct_id, never a hardcoded per-surface placeholder', () => {
  const beacons = withMockedBrowser('real-visitor-123', () => {
    trackTicketClick({
      showId: 'hamilton', showName: 'Hamilton', platform: 'TodayTix',
      pageType: 'browse', showStatus: 'open', isAffiliate: true, linkPosition: 0,
    });
  });
  assert.equal(beacons.length, 1);
  const payload = JSON.parse(beacons[0].body);
  assert.equal(payload.properties.distinct_id, 'real-visitor-123');
  assert.notEqual(payload.properties.distinct_id, 'browse-click');
});

test('trackTicketClick falls back to "anonymous" (not a page-specific literal) when PostHog has no distinct id yet', () => {
  const beacons = withMockedBrowser(undefined, () => {
    trackTicketClick({
      showId: 'hamilton', showName: 'Hamilton', platform: 'TodayTix',
      pageType: 'browse', showStatus: 'open', isAffiliate: true, linkPosition: 0,
    });
  });
  const payload = JSON.parse(beacons[0].body);
  assert.equal(payload.properties.distinct_id, 'anonymous');
});

test('buildAffiliateUrl reports is_affiliate: true and wraps the URL for a real affiliate platform (TodayTix)', () => {
  const result = buildAffiliateUrl('https://todaytix.com/x/hamilton', 'TodayTix', 'browse');
  assert.equal(result.isAffiliate, true);
  assert.notEqual(result.url, 'https://todaytix.com/x/hamilton');
  assert.match(result.url, /todaytix\.pxf\.io/);
});

// Guards the exact ShowListCard bug: is_affiliate must be DERIVED from
// buildAffiliateUrl, never hardcoded true regardless of platform — a platform
// with no affiliate program configured must report isAffiliate: false and
// leave the URL untouched (opening the real destination, not a broken/wrong
// affiliate wrap).
test('buildAffiliateUrl reports is_affiliate: false and leaves the URL unchanged for a non-affiliate platform', () => {
  const result = buildAffiliateUrl('https://example.com/official', 'Official Site', 'browse');
  assert.equal(result.isAffiliate, false);
  assert.equal(result.url, 'https://example.com/official');
});

// The tests above only pin the shared helpers' behavior — they'd keep
// passing even if ShowListCard.tsx were reverted to its old hand-rolled
// tracking. These source-level checks guard the actual wiring: reverting
// the fix (or copy-pasting the old pattern into a new call site) must fail
// loudly here, not just silently ship a corrupted browse-card click again.
test('ShowListCard routes its ticket CTA through the shared affiliate-utils helpers, not a hand-rolled beacon', () => {
  const source = showListCardSource();
  assert.match(source, /from ['"]@\/lib\/affiliate-utils['"]/, 'must import the shared affiliate-utils helpers');
  assert.match(source, /buildAffiliateUrl\(/, 'must call the shared buildAffiliateUrl()');
  assert.match(source, /trackTicketClick\(/, 'must call the shared trackTicketClick()');
  assert.doesNotMatch(source, /sendBeacon/, 'must not hand-roll its own PostHog beacon');
});

test('ShowListCard never hardcodes distinct_id or is_affiliate for its ticket CTA', () => {
  const source = showListCardSource();
  assert.doesNotMatch(source, /browse-click/, 'must not reintroduce the fake per-surface distinct_id literal');
  assert.doesNotMatch(source, /is_affiliate:\s*true/, 'is_affiliate must be derived from buildAffiliateUrl, never hardcoded');
});
