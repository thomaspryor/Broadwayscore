/**
 * Soft-launch tracking for accounts / ratings / lists (src/lib/ugc-analytics.ts)
 * and the sign-in return-path guard (src/lib/deferred-auth.ts).
 *
 * Requires the real modules (CLAUDE.md rule 15). Browser globals (window,
 * storage, PostHog, Sentry) are minimal stubs installed before import.
 *
 * Run: npx tsx --test tests/unit/ugc-analytics.test.ts
 */

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// Static imports are safe: neither module touches window/storage at load time.
import * as ugc from '../../src/lib/ugc-analytics';
import { safeReturnPath } from '../../src/lib/deferred-auth';

class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

type Captured = { event: string; props: Record<string, unknown>; opts?: { timestamp?: Date } };
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.location = { pathname: '/my-shows', search: '' };
g.sessionStorage = new MemStorage();
g.localStorage = new MemStorage();

let captured: Captured[] = [];
let sentryCalls: { err: Error; ctx: Record<string, unknown> }[] = [];
const fakePosthog = {
  capture: (event: string, props: Record<string, unknown>, opts?: { timestamp?: Date }) => { captured.push({ event, props, opts }); },
  register: () => {},
  unregister: () => {},
};
const fakeSentry = {
  init: () => {},
  captureException: (err: Error, ctx: Record<string, unknown>) => { sentryCalls.push({ err, ctx }); },
  setUser: () => {},
};

beforeEach(() => {
  captured = [];
  sentryCalls = [];
  (g.sessionStorage as MemStorage).clear();
  (g.localStorage as MemStorage).clear();
  g.posthog = fakePosthog;
  g.Sentry = fakeSentry;
});

test('describeSupabaseOp names REST, RPC, auth and functions calls', () => {
  const base = 'https://abc.supabase.co';
  assert.equal(ugc.describeSupabaseOp(`${base}/rest/v1/reviews?select=*`, 'GET'), 'select reviews');
  assert.equal(ugc.describeSupabaseOp(`${base}/rest/v1/reviews`, 'POST'), 'insert reviews');
  assert.equal(ugc.describeSupabaseOp(`${base}/rest/v1/lists?id=eq.1`, 'PATCH'), 'update lists');
  assert.equal(ugc.describeSupabaseOp(`${base}/rest/v1/watchlist?show_id=eq.x`, 'delete'), 'delete watchlist');
  assert.equal(ugc.describeSupabaseOp(`${base}/rest/v1/rpc/reorder_list_items`, 'POST'), 'rpc reorder_list_items');
  assert.equal(ugc.describeSupabaseOp(`${base}/auth/v1/token?grant_type=refresh_token`, 'POST'), 'auth token');
  assert.equal(ugc.describeSupabaseOp(`${base}/functions/v1/delete-account`, 'POST'), 'functions delete-account');
  assert.equal(ugc.describeSupabaseOp('https://broadwayscorecard.com/data/shows.json'), null);
});

test('sentryWorthy keeps session-lifecycle and offline noise out of Sentry', () => {
  assert.equal(ugc.sentryWorthy('insert reviews', { message: 'x', code: 'network' }), false);
  assert.equal(ugc.sentryWorthy('insert reviews', { message: 'x', code: 'no_session' }), false);
  assert.equal(ugc.sentryWorthy('insert watchlist', { message: 'dup', code: '23505', status: 409 }), false);
  assert.equal(ugc.sentryWorthy('select reviews', { message: 'jwt expired', status: 401 }), false);
  assert.equal(ugc.sentryWorthy('auth token', { message: 'Invalid Refresh Token', status: 400 }), false);
  // RLS refusals and server errors are real bugs.
  assert.equal(ugc.sentryWorthy('insert reviews', { message: 'rls', code: '42501', status: 403 }), true);
  assert.equal(ugc.sentryWorthy('rpc reorder_list_items', { message: 'boom', status: 500 }), true);
  assert.equal(ugc.sentryWorthy('auth token', { message: 'boom', status: 500 }), true);
});

test('safeReturnPath only allows same-site paths', () => {
  assert.equal(safeReturnPath('/show/hamilton?rate=1'), '/show/hamilton?rate=1');
  assert.equal(safeReturnPath('/my-shows'), '/my-shows');
  assert.equal(safeReturnPath('//evil.example/x'), '/');
  assert.equal(safeReturnPath('https://evil.example/'), '/');
  assert.equal(safeReturnPath('/\\evil.example'), '/');
  assert.equal(safeReturnPath('javascript:alert(1)'), '/');
  assert.equal(safeReturnPath(''), '/');
  assert.equal(safeReturnPath(null), '/');
});

test('instrumentedFetch reports a failed REST call to PostHog and Sentry, then returns the response', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ code: 'XX000', message: 'internal' }), { status: 500, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const res = await ugc.instrumentedFetch('https://abc.supabase.co/rest/v1/lists', { method: 'POST' });
    assert.equal(res.status, 500);
    assert.deepEqual(await res.json(), { code: 'XX000', message: 'internal' }, 'body still readable by the caller');
    const err = captured.find((c) => c.event === 'ugc_error');
    assert.ok(err, 'ugc_error captured');
    assert.equal(err.props.op, 'insert lists');
    assert.equal(err.props.error_code, 'XX000');
    assert.equal(err.props.http_status, 500);
    assert.equal(err.props.path, '/my-shows');
    assert.equal(sentryCalls.length, 1);
    assert.equal(sentryCalls[0].err.name, 'UgcError');
    assert.doesNotMatch(sentryCalls[0].err.message, /Failed to fetch/, 'must not match Sentry ignoreErrors');
    assert.deepEqual(sentryCalls[0].ctx.fingerprint, ['ugc', 'insert lists', 'XX000']);

    // Same op + code inside the throttle window: PostHog counts it, Sentry does not.
    await ugc.instrumentedFetch('https://abc.supabase.co/rest/v1/lists', { method: 'POST' });
    assert.equal(captured.filter((c) => c.event === 'ugc_error').length, 2);
    assert.equal(sentryCalls.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('instrumentedFetch reports network failures but not aborts, and rethrows both', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    await assert.rejects(ugc.instrumentedFetch('https://abc.supabase.co/rest/v1/reviews', { method: 'POST' }), TypeError);
    const net = captured.find((c) => c.event === 'ugc_error');
    assert.equal(net?.props.error_code, 'network');
    assert.equal(sentryCalls.length, 0, 'offline is not a Sentry event');

    captured = [];
    globalThis.fetch = (async () => { throw new DOMException('aborted', 'AbortError'); }) as typeof fetch;
    await assert.rejects(ugc.instrumentedFetch('https://abc.supabase.co/rest/v1/reviews'), /aborted/);
    assert.equal(captured.length, 0, 'aborts are not failures');

    // Non-Supabase traffic is passed through untouched.
    globalThis.fetch = (async () => new Response('nope', { status: 404 })) as typeof fetch;
    const res = await ugc.instrumentedFetch('https://broadwayscorecard.com/data/x.json');
    assert.equal(res.status, 404);
    assert.equal(captured.length, 0);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('events fired before PostHog loads wait in the outbox and keep their original time', () => {
  g.posthog = undefined;
  ugc.trackUgc('rating_submitted', { show_id: 'hamilton', rating: 4.5, has_review_text: undefined });
  assert.equal(captured.length, 0);
  const queued = JSON.parse((g.sessionStorage as MemStorage).getItem('bsc_ugc_outbox') || '[]');
  assert.equal(queued.length, 1);
  assert.equal('has_review_text' in queued[0].p, false, 'undefined props are dropped');

  g.posthog = fakePosthog;
  ugc.flushUgcOutbox();
  assert.equal(captured.length, 1);
  assert.equal(captured[0].event, 'rating_submitted');
  assert.equal(captured[0].props.rating, 4.5);
  assert.ok(captured[0].opts?.timestamp instanceof Date);
  assert.equal(queued[0].t, captured[0].opts?.timestamp?.getTime());
  assert.equal((g.sessionStorage as MemStorage).getItem('bsc_ugc_outbox'), null, 'outbox cleared');
});

test('sign_in_completed fires only for a sign-in started on this device', () => {
  // Restored session / tab refocus: SIGNED_IN with no marker → no event.
  ugc.markSignInCompleted({ app_metadata: { provider: 'google' }, created_at: '2020-01-01T00:00:00Z' });
  assert.equal(captured.filter((c) => c.event === 'sign_in_completed').length, 0);

  ugc.markSignInStarted('google', 'show_rating_save');
  assert.equal(captured.at(-1)?.event, 'sign_in_started');
  ugc.markSignInCompleted({ app_metadata: { provider: 'google' }, created_at: new Date().toISOString() });
  const done = captured.find((c) => c.event === 'sign_in_completed');
  assert.ok(done);
  assert.equal(done.props.context, 'show_rating_save');
  assert.equal(done.props.is_new_user, true);
  assert.equal(typeof done.props.seconds_to_complete, 'number');

  // Marker is consumed: a later SIGNED_IN (refocus) does not double count.
  ugc.markSignInCompleted({ app_metadata: { provider: 'google' } });
  assert.equal(captured.filter((c) => c.event === 'sign_in_completed').length, 1);
});

test('sign_in_failed on the OAuth callback recovers the context from the marker', () => {
  ugc.markSignInStarted('google', 'header');
  ugc.markSignInFailed('google', null, 'cancelled');
  const failed = captured.find((c) => c.event === 'sign_in_failed');
  assert.equal(failed?.props.context, 'header');
  assert.equal(failed?.props.reason, 'cancelled');
  assert.equal((g.localStorage as MemStorage).getItem('bsc_signin_pending'), null);
});
