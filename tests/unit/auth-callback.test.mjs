import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('tsx/cjs/api').register();
const React = require('react');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

// Execute the actual page effect with a controlled clock and SDK. No copy of
// its timeout/session decision logic lives in this harness.
function setup(t, { getSession = async () => ({ data: { session: null } }), loadClient, search = '' } = {}) {
  const calls = { failures: [], reports: [], reads: 0, unsubscribed: 0, cleared: 0 };
  const timers = new Map();
  let timerId = 0;
  for (const name of ['setTimeout', 'setInterval']) {
    t.mock.method(globalThis, name, (fn, ms) => {
      timers.set(++timerId, { fn, ms, interval: name === 'setInterval' });
      return timerId;
    });
  }
  for (const name of ['clearTimeout', 'clearInterval']) t.mock.method(globalThis, name, id => timers.delete(id));
  let authListener;
  const client = { auth: {
    getSession: () => { calls.reads++; return getSession(); },
    onAuthStateChange: fn => {
      authListener = fn;
      return { data: { subscription: { unsubscribe: () => calls.unsubscribed++ } } };
    },
  } };
  const previousWindow = globalThis.window;
  const previousReact = globalThis.React;
  globalThis.React = React;
  globalThis.window = { location: { hash: '', search, origin: 'http://localhost', href: '', replace: url => { globalThis.window.location.href = url; } } };
  t.after(() => {
    if (previousWindow === undefined) delete globalThis.window; else globalThis.window = previousWindow;
    if (previousReact === undefined) delete globalThis.React; else globalThis.React = previousReact;
  });
  const state = [];
  let cursor = 0;
  let effect;
  const originalLoad = Module._load;
  const loader = t.mock.method(Module, '_load', function (name, ...args) {
    if (name === 'react') return { ...React,
      useState: initial => {
        const index = cursor++;
        if (!(index in state)) state[index] = initial;
        return [state[index], value => { state[index] = value; }];
      },
      useEffect: fn => { effect = fn; },
    };
    if (name === '@/lib/supabase') return { getSupabaseClient: () => loadClient ? loadClient(client) : Promise.resolve(client) };
    if (name === '@/lib/deferred-auth') return { getReturnUrl: () => '/my-shows?tab=watchlist', clearReturnUrl: () => calls.cleared++ };
    if (name === '@/lib/ugc-analytics') return {
      markPageLeaving: () => {},
      markSignInFailed: (...args) => calls.failures.push(args),
      reportUgcError: (...args) => calls.reports.push(args),
    };
    return originalLoad.call(this, name, ...args);
  });
  const path = require.resolve('../../src/app/auth/callback/page.tsx');
  delete require.cache[path];
  const Page = require(path).default;
  loader.mock.restore();
  const render = () => { cursor = 0; return Page(); };
  render();
  const cleanup = effect();
  return {
    calls, state, render, cleanup,
    signedIn: () => authListener('SIGNED_IN'),
    async fire(ms) {
      const entry = [...timers].find(([, timer]) => timer.ms === ms);
      if (!entry) return;
      if (!entry[1].interval) timers.delete(entry[0]);
      void entry[1].fn();
      await flush();
    },
  };
}

test('session appearing at the timeout redirects without a false failure', async t => {
  let ready = false;
  const h = setup(t, { getSession: async () => ({ data: { session: ready ? { user: { id: 'user' } } : null } }) });
  await flush();
  await h.fire(500);
  ready = true;
  await h.fire(15000);
  await h.fire(100);
  assert.equal(h.calls.reads, 2, 'one poll and the final session recheck');
  assert.equal(window.location.href, '/my-shows?tab=watchlist');
  assert.deepEqual(h.calls.failures, []);
  assert.equal(h.state[0], false);
  h.cleanup();
});

test('true timeout has friendly copy and a retry into the existing sign-in flow', async t => {
  const h = setup(t);
  await flush();
  await h.fire(15000);
  assert.deepEqual(h.calls.failures, [['google', null, 'timeout']]);
  assert.equal(h.state[0], true);
  const markup = require('react-dom/server').renderToStaticMarkup(h.render());
  assert.match(markup, /Retry/);
  assert.match(markup, /signin=1/);
  const { signInSourceFromSearch } = require('../../src/lib/deferred-auth');
  assert.ok(signInSourceFromSearch('?tab=watchlist&signin=1'), 'Retry opens the existing sign-in prompt');
  assert.match(markup, /tab=watchlist/);
  assert.doesNotMatch(markup, /font-mono|token|Supabase|Timed out/);
  // A late SIGNED_IN still recovers from the retry screen.
  h.signedIn();
  await h.fire(100);
  assert.equal(window.location.href, '/my-shows?tab=watchlist');
  h.cleanup();
});

test('SDK loading past the first deadline can still complete sign-in', async t => {
  let resolveClient;
  let client;
  const h = setup(t, {
    loadClient: value => { client = value; return new Promise(resolve => { resolveClient = resolve; }); },
    getSession: async () => ({ data: { session: { user: { id: 'user' } } } }),
  });
  await h.fire(15000);
  assert.deepEqual(h.calls.failures, []);
  resolveClient(client);
  await flush();
  await h.fire(100);
  assert.equal(window.location.href, '/my-shows?tab=watchlist');
  assert.deepEqual(h.calls.failures, []);
  h.cleanup();
});

test('a stuck SDK eventually offers retry', async t => {
  const h = setup(t, { loadClient: () => new Promise(() => {}) });
  await h.fire(15000);
  await h.fire(5000);
  assert.equal(h.state[0], true);
  assert.deepEqual(h.calls.failures, [['google', null, 'timeout']]);
  h.cleanup();
});

test('successful auth cancels the failure timer', async t => {
  const h = setup(t);
  await flush();
  h.signedIn();
  await h.fire(100);
  await h.fire(15000);
  assert.deepEqual(h.calls.failures, []);
  assert.equal(h.calls.cleared, 1);
  h.cleanup();
  assert.equal(h.calls.unsubscribed, 1);
});

test('unmount while the final session read is pending prevents navigation and failure reporting', async t => {
  let resolveSession;
  const h = setup(t, { getSession: () => new Promise(resolve => { resolveSession = resolve; }) });
  await flush();
  await h.fire(15000);
  h.cleanup();
  resolveSession({ data: { session: { user: { id: 'user' } } } });
  await flush();
  await h.fire(100);
  assert.equal(window.location.href, '');
  assert.deepEqual(h.calls.failures, []);
});

test('provider errors stay in telemetry and never render raw details', t => {
  const h = setup(t, { search: '?error=server_error&error_description=internal+provider+details' });
  const markup = require('react-dom/server').renderToStaticMarkup(h.render());
  assert.match(markup, /Retry/);
  assert.doesNotMatch(markup, /server_error|internal provider details/);
  assert.equal(h.calls.reports[0][1].code, 'server_error');
});
