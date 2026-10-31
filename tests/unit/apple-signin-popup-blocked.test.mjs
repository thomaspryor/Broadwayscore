import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs/api').register();
const React = require('react');
const { act } = React;
const { JSDOM } = require('jsdom');
const blockedMessage = 'Your browser blocked the Apple window. Allow pop-ups for this site, or continue with Google.';

// Run the real provider, modal and Apple SDK wrapper. Only external SDKs and
// analytics are replaced; no sign-in decisions are copied into this harness.
async function setup(t) {
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://broadwayscorecard.com', pretendToBeVisual: true });
  const globals = {
    window: dom.window, self: dom.window, document: dom.window.document, React,
    requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
    cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  dom.window.scrollTo = () => {};
  const calls = { popups: 0, inits: [], tokens: [], reports: [], google: 0 };
  let popupError = { error: 'popup_blocked_by_browser' };
  let synchronousError = false;
  dom.window.AppleID = { auth: {
    init: config => calls.inits.push(config),
    signIn: () => {
      calls.popups++;
      if (synchronousError) throw popupError;
      return popupError ? Promise.reject(popupError) : Promise.resolve({ authorization: { id_token: 'test-token', code: 'test-code' } });
    },
  } };
  const client = { auth: {
    getSession: async () => ({ data: { session: null } }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signInWithIdToken: async args => { calls.tokens.push(args); return { data: {}, error: null }; },
    signInWithOAuth: async () => { calls.google++; return { error: null }; },
  } };
  const analytics = new Proxy({}, { get: (_, key) => (...args) => { if (key === 'reportUgcError') calls.reports.push(args); } });
  const originalLoad = Module._load;
  const loader = t.mock.method(Module, '_load', function (name, ...args) {
    if (name === '@/lib/supabase') return {
      getSupabaseClient: async () => client, isSupabaseConfigured: () => true,
      hasStoredSupabaseSession: () => false, urlHasAuthResult: () => false, onSupabaseClientReady: () => () => {},
    };
    if (name === '@/lib/ugc-analytics' || name === './ugc-analytics') return analytics;
    if (name === '@/lib/auto-subscribe') return { autoSubscribeOnSignIn() {} };
    if (name === '@/components/show-cards') return {
      Modal: require('../../src/components/show-cards/Modal.tsx').default,
      ModalCloseButton: ({ onClick }) => React.createElement('button', { onClick, 'aria-label': 'Close' }, 'Close'),
    };
    return originalLoad.call(this, name, ...args);
  });
  for (const path of ['../../src/lib/apple-auth.ts', '../../src/components/auth/SignInModal.tsx', '../../src/contexts/AuthContext.tsx']) delete require.cache[require.resolve(path)];
  const sdk = require('../../src/lib/apple-auth.ts');
  const { AuthProvider, useAuth } = require('../../src/contexts/AuthContext.tsx');
  loader.mock.restore();
  let auth;
  function Consumer() {
    auth = useAuth();
    return null;
  }
  const { createRoot } = require('react-dom/client');
  const root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(AuthProvider, null, React.createElement(Consumer))));
  t.mock.method(console, 'error', () => {});
  t.after(async () => {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
  return {
    sdk, calls, settle,
    setPopupError: error => { popupError = error; },
    throwSynchronously: () => { synchronousError = true; },
    open: () => act(async () => auth.showSignIn()),
    close: () => act(async () => document.querySelector('[aria-label="Close"]').click()),
    apple: () => [...document.querySelectorAll('button')].find(el => /Apple/.test(el.textContent)),
    google: () => [...document.querySelectorAll('button')].find(el => /Google/.test(el.textContent)),
    signInDirectly: () => act(async () => auth.signIn('apple', 'my_shows')),
    loadSDK: async () => {
      const script = document.querySelector('script[src*="appleid"]');
      assert.ok(script, 'the real SDK loader inserted its script');
      await act(async () => { script.onload(); await sdk.prepareAppleSignIn(); });
    },
  };
}

test('first open keeps Apple disabled until preparation finishes, leaving Google available', async t => {
  const h = await setup(t);
  await h.open();
  assert.equal(h.apple().disabled, true);
  assert.equal(h.google().disabled, false);
  await act(async () => h.apple().click());
  assert.equal(h.calls.popups, 0);
  await h.loadSDK();
  assert.equal(h.apple().disabled, false);
});

test('blocked popup reaches the modal with accessible recovery copy and status tokens', async t => {
  const h = await setup(t);
  await h.open();
  await h.loadSDK();
  await act(async () => h.apple().click());
  await h.settle();
  const alert = document.querySelector('[role="alert"]');
  assert.equal(alert?.textContent, blockedMessage);
  assert.ok(alert.classList.contains('text-score-skip'));
  assert.equal(h.google().disabled, false);
  assert.equal(h.apple().disabled, false, 'a fresh nonce is ready for retry');
  assert.notEqual(h.calls.inits[0].nonce, h.calls.inits[1].nonce);
  await h.close();
  await h.open();
  assert.equal(document.querySelector('[role="alert"]'), null, 'a new prompt clears the old error');
});

test('error mapping handles Error messages and preserves silent user cancellation', async t => {
  const h = await setup(t);
  await h.open();
  await h.loadSDK();
  for (const error of [new Error('popup_blocked_by_browser'), { error: 'popup_closed_by_user' }, { error: 'user_cancelled_authorize' }, new Error('unknown SDK failure')]) {
    h.setPopupError(error);
    await act(async () => h.apple().click());
    await h.settle();
    const message = document.querySelector('[role="alert"]')?.textContent;
    if (error.message === 'popup_blocked_by_browser') assert.equal(message, blockedMessage);
    else if (error.error) assert.equal(message, undefined);
    else assert.match(message, /try again|Google/i);
  }
});

test('an unprepared caller never opens a popup after waiting for the SDK', async t => {
  const h = await setup(t);
  const attempt = h.sdk.signInWithAppleSDK();
  // Observe rejection immediately so a fail-fast implementation cannot cause an
  // unhandled rejection while the test finishes loading the external SDK.
  const outcome = attempt.then(value => ({ value }), error => ({ error }));
  await h.open();
  await h.loadSDK();
  await h.settle();
  assert.equal(h.calls.popups, 0, 'no popup may open after user activation expires');
  assert.equal((await outcome).error?.message, 'apple_not_prepared');
  h.setPopupError(null);
  const next = h.sdk.signInWithAppleSDK();
  assert.equal(h.calls.popups, 1, 'a prepared attempt opens synchronously');
  assert.equal((await next).idToken, 'test-token');
  await h.settle();
});

test('a synchronous popup failure also prepares a fresh nonce and shows recovery', async t => {
  const h = await setup(t);
  await h.open();
  await h.loadSDK();
  h.throwSynchronously();
  await act(async () => h.apple().click());
  await h.settle();
  assert.equal(document.querySelector('[role="alert"]').textContent, blockedMessage);
  assert.equal(h.apple().disabled, false);
  assert.notEqual(h.calls.inits[0].nonce, h.calls.inits[1].nonce);
});

test('SDK download failure leaves Google available and can recover on reopening', async t => {
  const h = await setup(t);
  await h.open();
  await act(async () => document.querySelector('script[src*="appleid"]').onerror());
  assert.equal(h.apple().disabled, true);
  assert.equal(h.google().disabled, false);
  assert.match(document.querySelector('[role="alert"]').textContent, /unavailable.*Google/);
  await h.close();
  await h.open();
  await h.loadSDK();
  assert.equal(h.apple().disabled, false);
  assert.equal(document.querySelector('[role="alert"]'), null);
});

test('an early direct My Shows tap opens recovery instead of a late popup', async t => {
  const h = await setup(t);
  await h.signInDirectly();
  assert.equal(h.calls.popups, 0);
  assert.match(document.querySelector('[role="alert"]').textContent, /getting ready.*Google/);
  assert.equal(h.apple().disabled, true);
  await h.loadSDK();
  assert.equal(h.apple().disabled, false);
  await act(async () => h.google().click());
  assert.equal(h.calls.google, 1);
  assert.equal(document.querySelector('[role="alert"]'), null);
});
