import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { require as tsxRequire } from 'tsx/cjs/api';

const gate = tsxRequire('../../src/lib/money-gate.ts', import.meta.url);

test('the real unlock decision recognizes an account or a money signup', () => {
  const saved = { window: globalThis.window, document: globalThis.document, localStorage: globalThis.localStorage };
  const items = new Map();
  globalThis.window = { location: { search: '' } };
  globalThis.document = { cookie: '' };
  globalThis.localStorage = { getItem: (k) => items.get(k) ?? null };
  try {
    assert.equal(gate.isMoneyUnlocked(), false);
    items.set(gate.EXISTING_SESSION_KEY, '{}');
    assert.equal(gate.isMoneyUnlocked(), true);
    items.clear();
    items.set(gate.MONEY_UNLOCK_KEY, '1');
    assert.equal(gate.isMoneyUnlocked(), true);
  } finally { Object.assign(globalThis, saved); }
});

test('only a gate sign-in joins the money list, once, with retry on failure', async () => {
  const saved = { window: globalThis.window, sessionStorage: globalThis.sessionStorage, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  const env = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  const session = new Map(); const local = new Map(); const calls = [];
  const storage = (map) => ({ getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) });
  globalThis.window = { location: { pathname: '/biz', search: '' } };
  globalThis.sessionStorage = storage(session); globalThis.localStorage = storage(local);
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.invalid'; process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test';
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('https://dns.google/')) return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 15, data: '10 mx.example' }] }) };
    calls.push({ url: String(url), body: init.body });
    return { ok: false, status: 503 };
  };
  try {
    gate.recordMoneySignIn('header');
    await gate.completeMoneySignIn('reader@example.com');
    assert.equal(calls.length, 0);
    gate.recordMoneySignIn('biz_gate');
    await Promise.all([gate.completeMoneySignIn('reader@example.com'), gate.completeMoneySignIn('reader@example.com')]);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].body).p_page, 'biz_gate:/biz');
    assert.equal(JSON.parse(local.get(gate.MONEY_PENDING_KEY))[0].email, 'reader@example.com');
    await gate.completeMoneySignIn('reader@example.com');
    assert.equal(calls.length, 1);
    gate.recordMoneySignIn('biz_gate'); gate.recordMoneySignIn('header');
    await gate.completeMoneySignIn('reader@example.com');
    assert.equal(calls.length, 1);
  } finally {
    Object.assign(globalThis, saved);
    if (env.url === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_URL; else process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
    if (env.key === undefined) delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY; else process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.key;
  }
});

test('gate and auth wire the same source and disclose the list', () => {
  const gateSrc = readFileSync(new URL('../../src/components/biz/MoneyGate.tsx', import.meta.url), 'utf8');
  const auth = readFileSync(new URL('../../src/contexts/AuthContext.tsx', import.meta.url), 'utf8');
  assert.match(gateSrc, /showSignIn\('generic', 'biz_gate'\)/);
  assert.match(gateSrc, /completeMoneySignIn\(user.email\)/);
  assert.match(gateSrc, /\{MONEY_EMAIL_USE\}/);
  assert.equal((auth.match(/recordMoneySignIn\(source\)/g) || []).length, 2);
});
