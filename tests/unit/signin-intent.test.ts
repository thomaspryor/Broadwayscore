/**
 * Mid-task sign-ins (BRO-6917 Part 3). Locks: only rating/bookmark contexts count,
 * a later header sign-in clears an abandoned mid-task marker, stale markers
 * are ignored, and blocked storage never throws.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MIDFLOW_TTL_MS,
  isMidFlowContext,
  isMidFlowFresh,
  recordSignInIntent,
  hasMidFlowSignIn,
  clearMidFlowSignIn,
  type IntentStore,
} from '../../src/lib/signin-intent';

function memStore(): IntentStore & { data: Record<string, string> } {
  const data: Record<string, string> = {};
  return {
    data,
    getItem: k => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = v; },
    removeItem: k => { delete data[k]; },
  };
}

test('only in-page actions count as mid-task', () => {
  for (const c of ['rating', 'watchlist', 'watchlist_local']) assert.equal(isMidFlowContext(c), true, c);
  for (const c of ['generic', 'critic', '', null, undefined, 'header']) assert.equal(isMidFlowContext(c as string), false, String(c));
});

test('freshness window', () => {
  const now = 1_000_000_000;
  assert.equal(isMidFlowFresh(now - 1000, now), true);
  assert.equal(isMidFlowFresh(now - MIDFLOW_TTL_MS, now), true);
  assert.equal(isMidFlowFresh(now - MIDFLOW_TTL_MS - 1, now), false);
  assert.equal(isMidFlowFresh(undefined, now), false);
  assert.equal(isMidFlowFresh(NaN, now), false);
  assert.equal(isMidFlowFresh(now + 10 * 60_000, now), false);
});

test('rating sign-in leaves a marker; header sign-in after it removes it', () => {
  const s = memStore();
  const now = 5_000_000;
  recordSignInIntent('rating', now, s);
  assert.equal(hasMidFlowSignIn(now + 1000, s), true);
  recordSignInIntent('generic', now + 2000, s);
  assert.equal(hasMidFlowSignIn(now + 3000, s), false);
});

test('stale marker is ignored; clear removes it; garbage is not mid-task', () => {
  const s = memStore();
  recordSignInIntent('watchlist_local', 0, s);
  assert.equal(hasMidFlowSignIn(MIDFLOW_TTL_MS + 5, s), false);
  recordSignInIntent('watchlist', 10, s);
  assert.equal(hasMidFlowSignIn(20, s), true);
  clearMidFlowSignIn(s);
  assert.equal(hasMidFlowSignIn(20, s), false);
  s.setItem('bsc_signin_midflow', '{not json');
  assert.equal(hasMidFlowSignIn(20, s), false);
});

test('blocked storage never throws', () => {
  const broken: IntentStore = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
    removeItem: () => { throw new Error('blocked'); },
  };
  assert.doesNotThrow(() => recordSignInIntent('rating', 1, broken));
  assert.equal(hasMidFlowSignIn(1, broken), false);
  assert.doesNotThrow(() => clearMidFlowSignIn(broken));
  assert.equal(hasMidFlowSignIn(1, null), false);
});

// Direct callers of signIn / sendEmailCode (My Shows provider buttons) start a
// sign-in with no prompt in front of them, so they must clear a leftover mark.
// The context must hand out the clearing wrappers, never the raw functions;
// only the sign-in modal's own handlers use the raw ones.
test('AuthContext exposes signIn and sendEmailCode through the mark-clearing wrappers', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../../src/contexts/AuthContext.tsx', import.meta.url), 'utf8');
  const value = src.slice(src.indexOf('<AuthContext.Provider'), src.indexOf('</AuthContext.Provider>'));
  assert.match(value, /signIn: signInDirect,/);
  assert.match(value, /sendEmailCode: sendEmailCodeDirect,/);
  assert.doesNotMatch(value, /^\s*signIn,$/m);
  assert.doesNotMatch(value, /^\s*sendEmailCode,$/m);
  const wrapper = src.slice(src.indexOf('const signInDirect'), src.indexOf('const handleModalClose'));
  assert.match(wrapper, /clearMidFlowSignIn\(\);\s*return signIn\(/);
  assert.match(wrapper, /clearMidFlowSignIn\(\);\s*return sendEmailCode\(/);
});
