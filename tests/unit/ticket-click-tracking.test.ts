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

// BRO-3466 / BRO-3617: the global `navigator` binding differs by Node major.
// Node 20 (what .github/workflows/test.yml pins) has NO global `navigator`;
// Node 21+ (typical local dev) ships one as a configurable getter-only
// accessor. The first version of withMockedBrowser read
// `globalThis.navigator.sendBeacon` unconditionally, so it was green on the
// author's local Node and red on CI ("Cannot read properties of undefined
// (reading 'sendBeacon')") — and the BRO-2392 session pushed it having never
// seen the failure. Two defences below:
//   1. withMockedBrowser installs a fresh `navigator` via defineProperty on
//      EVERY runtime (no "is it already there?" branch to get wrong) and
//      restores the original descriptor afterwards.
//   2. Every beacon test runs under BOTH global shapes via withNavigatorShape,
//      whatever Node is actually executing it. This guards the MOCK (a future
//      edit that reads navigator before defining it fails on every Node), so
//      a local run can no longer be green while CI's Node is red.
// 'absent' = no global navigator (Node 20, the CI pin at time of writing);
// 'present' = a getter-only accessor (Node 21+). Keep the version mapping
// HERE, not in the labels — labels surface in CI logs and must not go stale
// when the pin bumps.
type NavigatorShape = 'absent' | 'present';
const NAVIGATOR_SHAPES: readonly NavigatorShape[] = ['absent', 'present'];

function withNavigatorShape(shape: NavigatorShape, fn: () => void) {
  const g = globalThis as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  try {
    if (shape === 'absent') {
      delete g.navigator;
      assert.equal('navigator' in globalThis, false, 'shape setup must remove the global navigator');
    } else if (!original) {
      // Emulate Node 21+'s getter-only accessor so the "can't assign, must
      // redefine" path is exercised even on a runtime that has no navigator.
      Object.defineProperty(globalThis, 'navigator', { get: () => ({}), configurable: true });
    }
    fn();
  } finally {
    delete g.navigator;
    if (original) Object.defineProperty(globalThis, 'navigator', original);
  }
  assert.equal('navigator' in globalThis, original !== undefined, 'shape teardown must restore the pre-test global');
}

function withMockedBrowser(distinctId: string | undefined, fn: () => void) {
  const sentBeacons: { url: string; body: string }[] = [];
  const g = globalThis as Record<string, unknown>;
  // Descriptors, not values, for BOTH globals: restoring `window` by
  // assignment would leave `'window' in globalThis` true (value undefined)
  // after the first test — the same assign-vs-define trap as navigator.
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  // Define, never assign: a pre-existing Node 21+ `navigator` is a getter-only
  // accessor (assignment throws in strict mode), but it IS configurable, and
  // on Node 20 there is nothing to assign to at all. defineProperty is the one
  // operation that works identically in both cases.
  Object.defineProperty(globalThis, 'navigator', {
    value: {
      sendBeacon: (url: string, body: string) => {
        sentBeacons.push({ url, body });
        return true;
      },
    },
    configurable: true,
    writable: true,
  });
  Object.defineProperty(globalThis, 'window', {
    value: {
      posthog: distinctId !== undefined ? { get_distinct_id: () => distinctId } : undefined,
      location: { href: 'https://broadwayscorecard.com/browse' },
    },
    configurable: true,
    writable: true,
  });
  try {
    fn();
  } finally {
    delete g.window;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    delete g.navigator;
    if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  }
  return sentBeacons;
}

const BROWSE_CLICK = {
  showId: 'hamilton', showName: 'Hamilton', platform: 'TodayTix',
  pageType: 'browse', showStatus: 'open', isAffiliate: true, linkPosition: 0,
} as const;

for (const shape of NAVIGATOR_SHAPES) {
  test(`trackTicketClick sends the real PostHog distinct_id, never a hardcoded per-surface placeholder [global navigator ${shape}]`, () => {
    withNavigatorShape(shape, () => {
      const beacons = withMockedBrowser('real-visitor-123', () => trackTicketClick(BROWSE_CLICK));
      assert.equal(beacons.length, 1);
      const payload = JSON.parse(beacons[0].body);
      assert.equal(payload.properties.distinct_id, 'real-visitor-123');
      assert.notEqual(payload.properties.distinct_id, 'browse-click');
    });
  });

  test(`trackTicketClick falls back to "anonymous" (not a page-specific literal) when PostHog has no distinct id yet [global navigator ${shape}]`, () => {
    withNavigatorShape(shape, () => {
      const beacons = withMockedBrowser(undefined, () => trackTicketClick(BROWSE_CLICK));
      assert.equal(beacons.length, 1);
      const payload = JSON.parse(beacons[0].body);
      assert.equal(payload.properties.distinct_id, 'anonymous');
    });
  });
}

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
