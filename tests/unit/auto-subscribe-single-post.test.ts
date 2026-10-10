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

test('a stale marker (older than 10 min) does not block forever', async () => {
  const m = await import('../../src/lib/auto-subscribe');
  m.__resetForNewPage();
  store.set(m.INFLIGHT_KEY, String(Date.now() - 11 * 60 * 1000));
  respond = 'ok';
  await m.autoSubscribeOnSignIn('c@example.com');
  assert.equal(posts, 1);
});
