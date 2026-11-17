/**
 * Google One Tap on desktop (BRO-6917 Part 5). Locks the "quiet by design"
 * rules: desktop only, signed out only, once per session, silent for 14 days
 * after a close, never over the sign-in box or the OAuth return pages, and the
 * pure helpers never throw when storage is blocked.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  DESKTOP_QUERY,
  GOOGLE_WEB_CLIENT_ID,
  ONE_TAP_COOLDOWN_MS,
  ONE_TAP_DELAY_MS,
  ONE_TAP_SOURCE,
  isOneTapPath,
  markAskedThisSession,
  markDismissed,
  oneTapDecision,
  readAskedThisSession,
  readDismissedAt,
  readPromptOutcome,
  shouldCooldown,
  type KeyStore,
  type OneTapContext,
} from '../../src/lib/google-one-tap';

const require = createRequire(import.meta.url);
const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);

function base(over: Partial<OneTapContext> = {}): OneTapContext {
  return {
    clientId: 'x.apps.googleusercontent.com',
    signedIn: false,
    authLoading: false,
    modalOpen: false,
    desktop: true,
    pathname: '/show/hamilton',
    dismissedAt: null,
    askedThisSession: false,
    hasSignInParam: false,
    now: NOW,
    ...over,
  };
}

function memStore(): KeyStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return { data, getItem: k => (k in data ? data[k] : null), setItem: (k, v) => { data[k] = v; } };
}

const throwingStore: KeyStore = {
  getItem() { throw new Error('blocked'); },
  setItem() { throw new Error('blocked'); },
};

test('a signed-out desktop visitor on a normal page is asked', () => {
  assert.deepEqual(oneTapDecision(base()), { ask: true });
});

test('every reason to stay quiet is named', () => {
  const cases: Array<[Partial<OneTapContext>, string]> = [
    [{ clientId: '' }, 'no_client_id'],
    [{ clientId: null }, 'no_client_id'],
    [{ signedIn: true }, 'signed_in'],
    [{ authLoading: true }, 'auth_loading'],
    [{ modalOpen: true }, 'modal_open'],
    [{ desktop: false }, 'not_desktop'],
    [{ pathname: '/auth/complete' }, 'excluded_path'],
    [{ hasSignInParam: true }, 'signin_param'],
    [{ askedThisSession: true }, 'asked_this_session'],
    [{ dismissedAt: NOW - 1000 }, 'cooldown'],
  ];
  for (const [over, reason] of cases) {
    assert.deepEqual(oneTapDecision(base(over)), { ask: false, reason }, JSON.stringify(over));
  }
});

test('the cooldown lasts exactly 14 days, then the card may come back', () => {
  assert.equal(ONE_TAP_COOLDOWN_MS, 14 * 24 * 60 * 60 * 1000);
  assert.equal((oneTapDecision(base({ dismissedAt: NOW - ONE_TAP_COOLDOWN_MS + 1 })) as { ask: boolean }).ask, false);
  assert.equal((oneTapDecision(base({ dismissedAt: NOW - ONE_TAP_COOLDOWN_MS })) as { ask: boolean }).ask, true);
});

test('a dismissal stamped in the future (clock skew) does not silence the card forever', () => {
  assert.equal((oneTapDecision(base({ dismissedAt: NOW + 10 * 24 * 60 * 60 * 1000 })) as { ask: boolean }).ask, true);
  assert.equal(oneTapDecision(base({ dismissedAt: Number.NaN })).ask, true);
});

test('the sign-in return pages, embeds and admin tools never get a card; show pages and the home page do', () => {
  for (const p of ['/auth/complete', '/auth/callback', '/embed/hamilton', '/admin', '/admin/x', '/api/foo', '/unsubscribe', '/reset/abc']) {
    assert.equal(isOneTapPath(p), false, p);
  }
  for (const p of ['/', '/show/hamilton', '/my-shows', '/browse', '/critics/ben-brantley', '/authors', '/administration-notes']) {
    assert.equal(isOneTapPath(p), true, p);
  }
});

test('desktop means a wide screen with a real pointer', () => {
  assert.match(DESKTOP_QUERY, /min-width:\s*1024px/);
  assert.match(DESKTOP_QUERY, /hover:\s*hover/);
  assert.match(DESKTOP_QUERY, /pointer:\s*fine/);
});

test('the card waits out first paint', () => {
  assert.ok(ONE_TAP_DELAY_MS >= 5000 && ONE_TAP_DELAY_MS <= 15000);
});

test('storage helpers round-trip and never throw when storage is blocked', () => {
  const local = memStore();
  assert.equal(readDismissedAt(local), null);
  markDismissed(NOW, local);
  assert.equal(readDismissedAt(local), NOW);
  const session = memStore();
  assert.equal(readAskedThisSession(session), false);
  markAskedThisSession(session);
  assert.equal(readAskedThisSession(session), true);

  assert.equal(readDismissedAt(throwingStore), null);
  assert.equal(readAskedThisSession(throwingStore), false);
  assert.doesNotThrow(() => markDismissed(NOW, throwingStore));
  assert.doesNotThrow(() => markAskedThisSession(throwingStore));
  assert.equal(readDismissedAt(null), null);
  assert.doesNotThrow(() => markDismissed(NOW, null));
  local.data['bsc_onetap_dismissed'] = 'garbage';
  assert.equal(readDismissedAt(local), null);
});

test('prompt outcomes: displayed, refused, skipped, dismissed; missing methods are tolerated', () => {
  assert.equal(readPromptOutcome(null), null);
  assert.deepEqual(readPromptOutcome({ isDisplayed: () => true }), { kind: 'shown' });
  assert.deepEqual(
    readPromptOutcome({ isNotDisplayed: () => true, getNotDisplayedReason: () => 'unregistered_origin' }),
    { kind: 'not_displayed', reason: 'unregistered_origin' },
  );
  assert.deepEqual(
    readPromptOutcome({ isSkippedMoment: () => true, getSkippedReason: () => 'user_cancel' }),
    { kind: 'skipped', reason: 'user_cancel' },
  );
  assert.deepEqual(
    readPromptOutcome({ isDismissedMoment: () => true, getDismissedReason: () => 'credential_returned' }),
    { kind: 'dismissed', reason: 'credential_returned' },
  );
  assert.deepEqual(readPromptOutcome({ isNotDisplayed: () => true }), { kind: 'not_displayed', reason: 'unknown' });
  // FedCM browsers dropped these methods and some throw instead.
  assert.equal(readPromptOutcome({}), null);
  assert.equal(readPromptOutcome({ isNotDisplayed: () => { throw new Error('removed'); } }), null);
});

test('only the visitor closing the card starts our cooldown', () => {
  assert.equal(shouldCooldown({ kind: 'skipped', reason: 'user_cancel' }), true);
  assert.equal(shouldCooldown({ kind: 'skipped', reason: 'tap_outside' }), true);
  // Not a "no": they signed in, we withdrew it, Google restarted it, or it never showed.
  assert.equal(shouldCooldown({ kind: 'dismissed', reason: 'credential_returned' }), false);
  assert.equal(shouldCooldown({ kind: 'dismissed', reason: 'cancel_called' }), false);
  assert.equal(shouldCooldown({ kind: 'skipped', reason: 'issuing_failed' }), false);
  assert.equal(shouldCooldown({ kind: 'not_displayed', reason: 'browser_not_supported' }), false);
  assert.equal(shouldCooldown({ kind: 'shown' }), false);
});

test('the client id has the shape of a Google OAuth client id (the web one, first in the Supabase list)', () => {
  assert.match(GOOGLE_WEB_CLIENT_ID, /^\d+-[a-z0-9]+\.apps\.googleusercontent\.com$/);
});

test('the funnel labels the one_tap source, so its rows are not shown as a raw key', () => {
  const { SOURCE_LABELS } = require('../../scripts/lib/account-metrics.js') as { SOURCE_LABELS: Record<string, string> };
  assert.equal(ONE_TAP_SOURCE, 'one_tap');
  assert.ok(SOURCE_LABELS[ONE_TAP_SOURCE], 'add one_tap to SOURCE_LABELS in scripts/lib/account-metrics.js');
});

test('the site security policy lets Google Identity load (so a future enforced policy cannot silently break One Tap)', () => {
  const vercel = require('../../vercel.json') as { headers: Array<{ headers: Array<{ key: string; value: string }> }> };
  const policy = vercel.headers
    .flatMap(h => h.headers)
    .find(h => h.key === 'Content-Security-Policy-Report-Only')?.value ?? '';
  assert.ok(policy, 'no report-only policy found in vercel.json');
  const directive = (name: string) => (policy.split(';').map(d => d.trim()).find(d => d.startsWith(name + ' ')) ?? '');
  assert.match(directive('script-src'), /https:\/\/accounts\.google\.com\/gsi\/client/);
  assert.match(directive('frame-src'), /https:\/\/accounts\.google\.com\/gsi\//);
  assert.match(directive('connect-src'), /https:\/\/accounts\.google\.com\/gsi\//);
  assert.match(directive('style-src'), /https:\/\/accounts\.google\.com\/gsi\/style/);
});
