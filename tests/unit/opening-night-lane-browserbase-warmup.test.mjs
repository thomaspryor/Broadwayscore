// BRO-6872: the lane's Browserbase fetcher clears TB's Cloudflare check with one page per new session, logs a dropped
// connection, and reconnects to a still-running session before spending a new one. Real fetcher, fake browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bbf = require('../../scripts/lib/opening-night-lane/browserbase-fetch.js');

const TB = 'https://www.talkinbroadway.com/page/world/SchoolGirls.html';
const KEYS = { BROWSERBASE_API_KEY: 'k', BROWSERBASE_PROJECT_ID: 'p' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function harness({ read, connect, ...opts } = {}) {
  const st = { sessions: 0, connects: [], events: [], logs: [], browsers: [] };
  const mkBrowser = () => {
    let connected = true; const handlers = [];
    const b = {
      isConnected: () => connected,
      on: (ev, fn) => { if (ev === 'disconnected') handlers.push(fn); },
      close: async () => { if (!connected) return; connected = false; handlers.forEach((h) => h()); },
      drop: () => { connected = false; handlers.forEach((h) => h()); }, // the remote end closes the connection
      contexts: () => [{ newPage: async () => ({ close: async () => {} }) }],
    };
    st.browsers.push(b);
    return b;
  };
  const fetcher = bbf.createBrowserbaseFetcher({
    env: KEYS, log: (m) => st.logs.push(m),
    createSession: async () => { st.sessions++; return { id: `sess${st.sessions}aaaa`, connectUrl: `wss://bb/${st.sessions}` }; },
    connect: async (url) => { st.connects.push(url); if (connect) return connect(url, mkBrowser); return mkBrowser(); },
    readPage: async (_p, url) => {
      st.events.push(`start ${url}`);
      const r = read ? await read(url) : (await sleep(20), { status: 200, finalUrl: url, html: '<html>tb</html>', challenge: false });
      st.events.push(`end ${url}`);
      return r;
    },
    ...opts,
  });
  return { fetcher, st };
}

test('a new session reads one page first; the rest start only after it settles, then run together', async () => {
  const { fetcher, st } = harness();
  await Promise.all([1, 2, 3, 4].map((i) => fetcher.fetch(`${TB}?${i}`)));
  assert.equal(st.sessions, 1);
  assert.equal(st.events[0], `start ${TB}?1`);
  assert.equal(st.events[1], `end ${TB}?1`, st.events.join(' | '));
  assert.deepEqual(st.events.slice(2, 5).map((e) => e.split(' ')[0]), ['start', 'start', 'start'], 'the rest go in parallel');
  // A second pass on the same session has no warm-up.
  st.events.length = 0;
  await Promise.all([5, 6].map((i) => fetcher.fetch(`${TB}?${i}`)));
  assert.deepEqual(st.events.slice(0, 2).map((e) => e.split(' ')[0]), ['start', 'start']);
});

test('a warm-up that stays behind the challenge still lets the waiting pages go', async () => {
  const { fetcher, st } = harness({ read: async (url) => { await sleep(10); return /\?1$/.test(url) ? { status: 403, html: 'Just a moment', challenge: true } : { status: 200, finalUrl: url, html: 'review', challenge: false }; } });
  const out = await Promise.allSettled([1, 2, 3].map((i) => fetcher.fetch(`${TB}?${i}`)));
  assert.equal(out[0].status, 'rejected');
  assert.ok(/Cloudflare challenge/.test(out[0].reason.message));
  assert.deepEqual(out.slice(1).map((o) => o.status), ['fulfilled', 'fulfilled']);
  assert.equal(st.sessions, 1);
});

test('a dropped connection is logged, and the still-running session is reconnected instead of paying for a new one', async () => {
  const { fetcher, st } = harness();
  await fetcher.fetch(TB);
  st.browsers[0].drop();
  assert.ok(st.logs.some((l) => /session sess1aaa dropped after \d+ s \(0 pages open\)/.test(l)), st.logs.join('\n'));
  st.events.length = 0;
  await Promise.all([1, 2].map((i) => fetcher.fetch(`${TB}?${i}`)));
  assert.equal(st.sessions, 1, 'no new session');
  assert.deepEqual(st.connects, ['wss://bb/1', 'wss://bb/1']);
  assert.ok(st.logs.some((l) => /reconnected to session sess1aaa/.test(l)));
  assert.deepEqual(st.events.slice(0, 2).map((e) => e.split(' ')[0]), ['start', 'start'], 'cleared stays cleared after a reconnect');
  assert.deepEqual(fetcher.stats().drops, 1);
});

test('a reconnect that fails or hangs opens a new session, and a late connection is closed', async () => {
  let n = 0; let late = null;
  const { fetcher, st } = harness({
    reconnectTimeoutMs: 30,
    connect: async (url, mk) => { n++; if (n === 2) { await sleep(80); late = mk(); return late; } return mk(); },
  });
  await fetcher.fetch(TB);
  st.browsers[0].drop();
  await fetcher.fetch(TB);
  assert.equal(st.sessions, 2);
  assert.deepEqual(st.connects, ['wss://bb/1', 'wss://bb/1', 'wss://bb/2']);
  assert.ok(st.logs.some((l) => /reconnect to sess1aaa failed \(reconnect timed out\)/.test(l)), st.logs.join('\n'));
  await sleep(120);
  assert.equal(late.isConnected(), false, 'the late connection is closed');
});

test('closing a session ourselves (rotation, close) is not a drop and is never reconnected', async () => {
  let t = 0;
  const { fetcher, st } = harness({ now: () => t, sessionTimeoutSec: 600 });
  await fetcher.fetch(TB);
  t = 400e3; // past rotation (600 s - 300 s)
  await fetcher.fetch(TB);
  assert.equal(st.sessions, 2);
  assert.deepEqual(st.connects, ['wss://bb/1', 'wss://bb/2']);
  await fetcher.close();
  assert.equal(st.logs.filter((l) => /dropped/.test(l)).length, 0, st.logs.join('\n'));
  assert.equal(fetcher.stats().drops, 0);
});

test('a dropped session already due for rotation is replaced, not reconnected', async () => {
  let t = 0;
  const { fetcher, st } = harness({ now: () => t, sessionTimeoutSec: 600 });
  await fetcher.fetch(TB);
  t = 400e3;
  st.browsers[0].drop();
  await fetcher.fetch(TB);
  assert.deepEqual(st.connects, ['wss://bb/1', 'wss://bb/2']);
});

test('after a warm-up that stayed behind the challenge, the next page warms up alone: no burst on a session that never cleared', async () => {
  const { fetcher, st } = harness({ read: async (url) => { await sleep(10); return /\?1$/.test(url) ? { status: 403, html: 'Just a moment', challenge: true } : { status: 200, finalUrl: url, html: 'review', challenge: false }; } });
  await Promise.allSettled([1, 2, 3, 4].map((i) => fetcher.fetch(`${TB}?${i}`)));
  const kinds = st.events.map((e) => e.split(' ')[0]);
  assert.deepEqual(kinds.slice(0, 4), ['start', 'end', 'start', 'end'], st.events.join(' | '));
  assert.deepEqual(kinds.slice(4), ['start', 'start', 'end', 'end'], 'once one page cleared, the rest run together');
});

test('a warm-up whose page never opens times out instead of holding the session, and the next page warms up', async () => {
  let opened = 0;
  const { fetcher } = harness({
    fetchTimeoutMs: 40,
    connect: async (_url, mk) => { const b = mk(); b.contexts = () => [{ newPage: () => (opened++ === 0 ? new Promise(() => {}) : Promise.resolve({ close: async () => {} })) }]; return b; },
  });
  const out = await Promise.allSettled([1, 2].map((i) => fetcher.fetch(`${TB}?${i}`)));
  assert.ok(/timed out/.test(out[0].reason.message), 'the hung page is bounded by the fetch deadline');
  assert.equal(out[1].status, 'rejected', 'a waiter is bounded by its own deadline too');
  const next = await fetcher.fetch(`${TB}?3`);
  assert.equal(next.status, 200, 'the session is not left waiting on a dead warm-up');
});

test('a dropped session that is not taken back is released before a new one opens', async () => {
  const released = [];
  let n = 0;
  const { fetcher, st } = harness({
    releaseSession: async (id) => { released.push(id); },
    connect: async (_url, mk) => { n++; if (n === 2) throw new Error('gone'); return mk(); },
  });
  await fetcher.fetch(TB);
  st.browsers[0].drop();
  await fetcher.fetch(TB);
  assert.deepEqual(released, ['sess1aaaa']);
  assert.equal(st.sessions, 2);
});

test('close() during a pending reconnect does not open (and bill) a new session', async () => {
  let n = 0;
  const { fetcher, st } = harness({
    reconnectTimeoutMs: 30,
    connect: async (_url, mk) => { n++; if (n === 2) { await sleep(200); } return mk(); },
  });
  await fetcher.fetch(TB);
  st.browsers[0].drop();
  const pendingFetch = fetcher.fetch(TB).catch((e) => e);
  await sleep(5);
  await fetcher.close();
  const e = await pendingFetch;
  assert.ok(e && e.bbUnavailable, String(e));
  assert.equal(st.sessions, 1);
  assert.equal(fetcher.stats().off, 'closed');
});
