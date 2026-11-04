/**
 * Sign-in auto-subscribe must reach Formspree once, even when the OAuth return
 * page navigates away before the POST's response arrives (2026-10-09: every
 * Google sign-in produced two "New submission from Subscriber" emails, one
 * from /auth/complete and one from the page it redirected to).
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env.NEXT_PUBLIC_FORMSPREE_SUBSCRIBER_FORM_ID = 'testform';

const store = new Map<string, string>();
const g = globalThis as unknown as Record<string, unknown>;
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
g.window = { location: { pathname: '/auth/complete' }, dispatchEvent: () => true };
g.Event = class { constructor(public type: string) {} };

let posts = 0;
let respond: 'hang' | 'ok' | 'fail' = 'ok';
g.fetch = async () => {
  posts++;
  if (respond === 'hang') return new Promise(() => {}); // page navigates first
  return { ok: respond === 'ok' };
};

beforeEach(() => { store.clear(); posts = 0; });

test('a navigation before the reply does not cause a second post', async () => {
  const m = await import('../../src/lib/auto-subscribe');
  m.__resetForNewPage();
  respond = 'hang';
  void m.autoSubscribeOnSignIn('a@example.com');
  await new Promise((r) => setImmediate(r));
  m.__resetForNewPage(); // full-page load of the return URL
  respond = 'ok';
  await m.autoSubscribeOnSignIn('a@example.com');
  assert.equal(posts, 1);
});

test('a failed post clears the marker so a later sign-in retries', async () => {
  const m = await import('../../src/lib/auto-subscribe');
  m.__resetForNewPage();
  respond = 'fail';
  await m.autoSubscribeOnSignIn('b@example.com');
  assert.equal(store.get(m.INFLIGHT_KEY), undefined);
  m.__resetForNewPage();
  respond = 'ok';
  await m.autoSubscribeOnSignIn('b@example.com');
  assert.equal(posts, 2);
  assert.equal(store.get('bsc_email_subscribed_broadway'), 'true');
});

test('an older marker still counts as sent (no second post after 10+ min)', async () => {
  const m = await import('../../src/lib/auto-subscribe');
  m.__resetForNewPage();
  // 2026-10-12: second emails 10.5 min and 2 h after /auth/complete.
  store.set(m.INFLIGHT_KEY, String(Date.now() - 2 * 60 * 60 * 1000));
  respond = 'ok';
  await m.autoSubscribeOnSignIn('c@example.com');
  assert.equal(posts, 0);
  assert.equal(store.get('bsc_email_subscribed_broadway'), 'true');
  assert.equal(store.get(m.INFLIGHT_KEY), undefined);
});

// Owner 2026-11-04: critics who sign in from "Claim this page" are told they
// won't be added to a mailing list. The skip is scoped to that one attempt.
test('critic sign-in in progress never joins the mailing list', async () => {
  const m = await import('../../src/lib/auto-subscribe');
  m.__resetForNewPage();
  m.markCriticSignInStarted();
  const u = { id: 'u1', email: 'critic@example.com' };
  assert.equal(m.criticOptOutToRecord(u), true); // moves onto the user id
  await m.autoSubscribeOnSignIn(u.email, u);
  assert.equal(posts, 0);
  // Next page load, metadata write not yet confirmed: still skipped, still to record.
  m.__resetForNewPage();
  assert.equal(m.criticOptOutToRecord(u), true);
  await m.autoSubscribeOnSignIn(u.email, u);
  assert.equal(posts, 0);
});

test('account with no_autosub skips on a fresh device', async () => {
  const m = await import('../../src/lib/auto-subscribe');
  m.__resetForNewPage();
  const u = { id: 'u2', email: 'critic2@example.com', user_metadata: { no_autosub: true } };
  assert.equal(m.criticOptOutToRecord(u), false);
  await m.autoSubscribeOnSignIn(u.email, u);
  assert.equal(posts, 0);
});

test('peeking at Claim, then dismissing, still joins on a normal sign-in', async () => {
  const m = await import('../../src/lib/auto-subscribe');
  m.__resetForNewPage();
  m.markCriticSignInStarted();
  m.clearCriticSignInStarted(); // popup dismissed
  const u = { id: 'u3', email: 'reader@example.com' };
  assert.equal(m.criticOptOutToRecord(u), false);
  await m.autoSubscribeOnSignIn(u.email, u);
  assert.equal(posts, 1);
});

test('a stale critic attempt (over 15 min) does not block a later sign-in', async () => {
  const m = await import('../../src/lib/auto-subscribe');
  m.__resetForNewPage();
  m.markCriticSignInStarted(Date.now() - 16 * 60 * 1000);
  const u = { id: 'u4', email: 'reader2@example.com' };
  assert.equal(m.shouldSkipAutoSubscribe(u), false);
  await m.autoSubscribeOnSignIn(u.email, u);
  assert.equal(posts, 1);
});

test('without any critic flag, sign-in still joins the list', async () => {
  const m = await import('../../src/lib/auto-subscribe');
  m.__resetForNewPage();
  await m.autoSubscribeOnSignIn('reader3@example.com', { id: 'u5' });
  assert.equal(posts, 1);
});
