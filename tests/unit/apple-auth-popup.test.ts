/**
 * Apple sign-in on the web: Safari blocks a popup opened after an await, so
 * once prepareAppleSignIn() has run, signInWithAppleSDK() must call
 * AppleID.auth.signIn() before it yields (BRO-4615: 5 of 5 web attempts failed
 * with popup_blocked_by_browser).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls: string[] = [];
let inits = 0;
const g = globalThis as unknown as Record<string, unknown>;
g.window = globalThis;
g.location = { origin: 'https://broadwayscorecard.com' };
g.document = {
  createElement: () => ({}) as Record<string, unknown>,
  head: { appendChild: (el: { onload?: () => void }) => { el.onload?.(); } },
};
g.AppleID = {
  auth: {
    init: () => { inits++; },
    signIn: () => {
      calls.push('signIn');
      return Promise.resolve({ authorization: { id_token: 'tok', code: 'c' } });
    },
  },
};

test('a prepared Apple sign-in opens the popup synchronously, inside the tap', async () => {
  const { prepareAppleSignIn, signInWithAppleSDK } = await import('../../src/lib/apple-auth');
  await prepareAppleSignIn();
  assert.equal(inits, 1);
  const p = signInWithAppleSDK();
  assert.deepEqual(calls, ['signIn'], 'signIn ran before the first await');
  const r = await p;
  assert.equal(r.idToken, 'tok');
  assert.equal(typeof r.nonce, 'string');
  assert.ok(r.nonce.length >= 32);
});

test('each attempt gets a fresh nonce, and a retry is prepared after the first settles', async () => {
  const { prepareAppleSignIn, signInWithAppleSDK } = await import('../../src/lib/apple-auth');
  // Wait for the re-prepare itself, not a fixed sleep: it hashes the nonce with
  // crypto.subtle (thread pool), which took over 20ms on a loaded CI runner
  // (test.yml run 42531505934). prepareAppleSignIn() returns the in-flight promise.
  await prepareAppleSignIn();
  calls.length = 0;
  const first = await signInWithAppleSDK();
  await prepareAppleSignIn();
  const p = signInWithAppleSDK();
  assert.deepEqual(calls, ['signIn', 'signIn'], 'the retry also opens without waiting');
  const second = await p;
  assert.notEqual(first.nonce, second.nonce);
});
