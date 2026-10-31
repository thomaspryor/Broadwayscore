/**
 * Profitability Scorecard email gate (BRO-6210): the unlock contract, the separate
 * list, popup suppression, paywall markup and admin signup panel. Runs with
 * plain node (the card acceptance command) and in the tsx unit batch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { require as tsxRequire } from 'tsx/cjs/api';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const gate = tsxRequire('../../src/lib/money-gate.ts', import.meta.url);
const { emailCaptureConfig } = tsxRequire('../../src/config/email-capture.ts', import.meta.url);
const hooks = tsxRequire('../../src/hooks/useFormspreeSubscribed.ts', import.meta.url);
const supa = tsxRequire('../../src/lib/supabase.ts', import.meta.url);
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

function runBoot({ stored = null, items = {}, cookie = '', storageThrows = false } = {}) {
  const attrs = new Set();
  const documentElement = {
    hasAttribute: (a) => attrs.has(a),
    setAttribute: (a) => attrs.add(a),
  };
  const localStorage = {
    getItem: (k) => {
      if (storageThrows) throw new Error('blocked');
      if (k === gate.MONEY_UNLOCK_KEY) return stored;
      return Object.hasOwn(items, k) ? items[k] : null;
    },
  };
  vm.runInNewContext(gate.MONEY_GATE_BOOT_SCRIPT, { document: { documentElement, cookie }, localStorage });
  return attrs.has(gate.MONEY_UNLOCK_ATTR);
}

test('boot script unlocks from localStorage, from the cookie fallback, and never throws', () => {
  assert.equal(runBoot(), false);
  assert.equal(runBoot({ stored: '1' }), true);
  assert.equal(runBoot({ cookie: `a=b; ${gate.MONEY_UNLOCK_COOKIE}=1` }), true);
  assert.equal(runBoot({ storageThrows: true, cookie: `${gate.MONEY_UNLOCK_COOKIE}=1` }), true);
  assert.equal(runBoot({ cookie: `${gate.MONEY_UNLOCK_COOKIE}=10` }), false, 'cookie match is exact');
  assert.equal(runBoot({ cookie: `x${gate.MONEY_UNLOCK_COOKIE}=1` }), false, 'cookie name is anchored');
});

test('existing subscribers and signed-in readers bypass the gate (BRO-6248)', () => {
  const { SUBSCRIBED_KEY, SUBSCRIBED_KEY_PREFIX } = hooks;
  for (const k of [SUBSCRIBED_KEY, `${SUBSCRIBED_KEY_PREFIX}broadway`, `${SUBSCRIBED_KEY_PREFIX}west-end`]) {
    assert.equal(runBoot({ items: { [k]: 'true' } }), true, `boot: ${k}`);
    assert.equal(runBoot({ items: { [k]: 'false' } }), false, `boot: ${k}=false stays locked`);
    assert.equal(gate.hasExistingAccess((x) => (x === k ? 'true' : null)), true, k);
  }
  assert.equal(runBoot({ items: { [supa.SUPABASE_STORAGE_KEY]: '{"access_token":"x"}' } }), true, 'boot: stored session');
  assert.equal(gate.hasExistingAccess((x) => (x === supa.SUPABASE_STORAGE_KEY ? '{}' : null)), true);
  assert.equal(gate.hasExistingAccess(() => null), false);
  assert.equal(gate.hasExistingAccess(() => { throw new Error('blocked'); }), false, 'blocked storage fails closed');
  // Unrelated captures do not count: the pop-up's local copy and the money key's lookalikes.
  assert.equal(runBoot({ items: { bsc_user_data: '{"email":"a@b.co"}', bsc_email_recaptured: 'true' } }), false);

  const tsx = read('src/components/biz/MoneyGate.tsx');
  assert.match(tsx, /if \(isAuthenticated && unlockForExistingReader\(\)\) setBypass\(\{ reason: 'account', when: 'midvisit' \}\);/, 'signing in mid-visit unlocks');
  assert.match(tsx, /addEventListener\('bsc_subscribed', onSubscribed\)/, 'subscribing mid-visit unlocks');
  assert.match(tsx, /else document\.documentElement\.removeAttribute\('data-money-unlocked'\);/, 'a stale page-only unlock is cleared on navigation');
  // The bypass never persists the money unlock or joins the money list.
  const fn = read('src/lib/money-gate.ts').match(/export function unlockForExistingReader[\s\S]*?\n}/)[0];
  assert.doesNotMatch(fn, /localStorage|cookie|submitMoneySignup/);
});

test('money_gate_bypassed reports why the gate was skipped, once per page view', () => {
  const { SUBSCRIBED_KEY, SUBSCRIBED_KEY_PREFIX } = hooks;
  const only = (key, val) => (k) => (k === key ? val : null);
  assert.equal(gate.existingAccessReason(only(supa.SUPABASE_STORAGE_KEY, '{}')), 'account');
  assert.equal(gate.existingAccessReason(only(`${SUBSCRIBED_KEY_PREFIX}west-end`, 'true')), 'subscriber');
  assert.equal(gate.existingAccessReason(only(SUBSCRIBED_KEY, 'false')), null);
  assert.equal(gate.existingAccessReason(() => { throw new Error('blocked'); }), null);
  // An account holder who is also subscribed reports as an account.
  assert.equal(gate.existingAccessReason((k) => (k === SUBSCRIBED_KEY ? 'true' : k === supa.SUPABASE_STORAGE_KEY ? '{}' : null)), 'account');
  assert.equal(gate.moneyUnlockReason(), null, 'server render: never unlocked');

  // In a browser: a money-list sign-up wins, the cookie covers blocked storage.
  const inBrowser = (store, cookie = '') => {
    const saved = { window: globalThis.window, localStorage: globalThis.localStorage, document: globalThis.document };
    globalThis.window = {};
    globalThis.localStorage = { getItem: store === 'throw' ? () => { throw new Error('blocked'); } : (k) => store[k] ?? null };
    globalThis.document = { cookie };
    try { return gate.moneyUnlockReason(); } finally { Object.assign(globalThis, saved); }
  };
  assert.equal(inBrowser({ [gate.MONEY_UNLOCK_KEY]: '1', [supa.SUPABASE_STORAGE_KEY]: '{}' }), 'unlocked');
  assert.equal(inBrowser({ [SUBSCRIBED_KEY]: 'true' }), 'subscriber');
  assert.equal(inBrowser({ [supa.SUPABASE_STORAGE_KEY]: '{}' }), 'account');
  assert.equal(inBrowser('throw', `x=1; ${gate.MONEY_UNLOCK_COOKIE}=1`), 'unlocked');
  assert.equal(inBrowser('throw'), null);
  assert.equal(inBrowser({ [SUBSCRIBED_KEY]: 'false' }), null);

  const src = read('src/lib/money-gate.ts');
  const reason = src.match(/export function moneyUnlockReason[\s\S]*?\n}/)[0];
  assert.ok(reason.indexOf("'unlocked'") < reason.indexOf('existingAccessReason'), 'a money-list sign-up wins over account/subscriber');
  assert.match(src, /export function isMoneyUnlocked\(\): boolean \{\s*return moneyUnlockReason\(\) !== null;/, 'one source of truth for unlocked');

  const tsx = read('src/components/biz/MoneyGate.tsx');
  assert.match(tsx, /track\('money_gate_bypassed', \{ page, reason, when \}\);/);
  assert.match(tsx, /captureEvent\('money_gate_bypassed', \{ page, reason, when, path: window\.location\.pathname \}\);/);
  assert.match(tsx, /if \(bypassTracked\) return;\s*bypassTracked = true;/, 'once per page view');
  assert.match(tsx, /if \(mountedGates === 0\) bypassTracked = false;/, 'resets when the page is left');
  assert.match(tsx, /if \(reason\) setBypass\(\{ reason, when: 'load' \}\);/, 'load-time unlock is counted');
  assert.match(tsx, /unlockForExistingReader\(\)\) setBypass\(\{ reason: 'subscriber', when: 'midvisit' \}\);/, 'mid-visit subscribe is counted');
  // Like money_gate_shown, it counts only once the content is on screen.
  assert.match(tsx, /if \(entries\.some\(\(e\) => e\.isIntersecting\)\) \{\s*trackMoneyBypass\(page, bypass\);/);
  assert.match(tsx, /io\.observe\(contentRef\.current\);/);
});

test('gate copy: benefit-led, discloses email use, offers sign-in, no em dashes', () => {
  const tsx = read('src/components/biz/MoneyGate.tsx');
  assert.match(tsx, />Unlock the Profitability Scorecard</);
  assert.match(tsx, /Always free\. Show-by-show capitalization, recoupment and box office for every Broadway show\./);
  assert.match(tsx, /One sign&#8209;up unlocks every page\./, 'non-breaking hyphen keeps "sign-up" on one line at 390');
  assert.match(tsx, /\{MONEY_EMAIL_USE\}/);
  assert.match(gate.MONEY_EMAIL_USE, /Unsubscribe anytime\./);
  assert.match(tsx, /Already have an account\?/);
  assert.match(tsx, /showSignIn\('generic', `money_gate:\$\{page\}`\)/);
  assert.match(tsx, /MONEY_ROLES\.map/, 'optional role chips kept');
  for (const t of [tsx, gate.MONEY_EMAIL_USE]) assert.doesNotMatch(t, /\u2014/, 'no em dashes');
});

test('header opening-night CTA is hidden on /biz and while a locked gate is on the page', () => {
  const btn = read('src/components/HeaderSubscribeButton.tsx');
  assert.match(btn, /if \(!isOpen && onBizPage\) return null;/);
  assert.match(btn, /className="header-subscribe-cta /);
  assert.match(read('src/app/globals.css'), /html:not\(\[data-money-unlocked\]\):has\(\.money-gate\) \.header-subscribe-cta \{\s*display: none;/);
});

test('email validation matches the database function', () => {
  for (const ok of ['jo@b.co', ' Name.Last+tag@Example.org ']) assert.equal(gate.isValidMoneyEmail(ok), true, ok);
  for (const bad of ['', 'a@b', 'a b@c.d', '@b.co', 'a@@b.co', `${'x'.repeat(250)}@b.co`]) assert.equal(gate.isValidMoneyEmail(bad), false, bad);
  const sql = read('supabase/migrations/20261025_money_scorecard_signups.sql');
  assert.match(sql, /\^\[\^@\\s\]\+@\[\^@\\s\]\+\\\.\[\^@\\s\]\+\$/, 'same pattern as isValidMoneyEmail');
  for (const r of gate.MONEY_ROLES) assert.ok(sql.includes(`'${r.value}'`), `role ${r.value} accepted by the function`);
});

test('sign-ups go to their own store, never the main list or accounts', () => {
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const src = stripComments(read('src/lib/money-gate.ts') + read('src/components/biz/MoneyGate.tsx'));
  assert.match(src, /rest\/v1\/rpc\/money_scorecard_signup/);
  assert.doesNotMatch(src, /formspree\.io|resend|useFormspreeCapture|new Event\('bsc_subscribed'\)|setItem\(SUBSCRIBED|setItem\(`\$\{SUBSCRIBED/i);
  assert.doesNotMatch(src, /setItem\((EXISTING_|SUPABASE_STORAGE_KEY)/, 'main-list and session flags are read, never written');
  const sql = read('supabase/migrations/20261025_money_scorecard_signups.sql');
  assert.match(sql, /REVOKE ALL ON public\.money_scorecard_signups FROM anon, authenticated/);
  assert.match(sql, /SECURITY DEFINER/);
  assert.match(sql, /interval '1 minute'\) >= 60 THEN/, 'new-row rate cap');
});

test('generic popups are off on /biz and held while a money gate is on screen', () => {
  assert.ok(emailCaptureConfig.excludedPaths.includes('/biz'));
  assert.match(read('src/contexts/ProGateContext.tsx'), /if \(isMoneyGateInView\(\)\) return false;/);
  assert.match(read('src/components/ShowFollowBanner.tsx'), /const gateInView = isMoneyGateInView\(\);/);
  assert.match(read('src/components/ShowFollowBanner.tsx'), /\|\| moneyGateInView\) return null;/, 'an already-open banner hides over the gate');
});

test('paywall structured data points at the gated wrapper class', () => {
  const schema = gate.moneyGatePaywallSchema();
  assert.equal(schema.isAccessibleForFree, false);
  assert.equal(schema.hasPart.cssSelector, '.money-gated');
  assert.match(read('src/components/biz/MoneyGate.tsx'), /className="money-gated money-gate-content"/);
  const css = read('src/app/globals.css');
  assert.match(css, /\.money-gate-content \* \{\s*-webkit-text-fill-color: transparent;/, 'locked figures are not legible');
  assert.match(css, /\.money-gate-content a\[href\^='\/show\/'\]/, 'show names stay a faint teaser');
  assert.match(read('src/components/BizBuzzCard.tsx'), /<MoneyGate page="show-page" preview="short" schema=\{false\}>/, 'show pages are not marked paywalled');
});

test('every show-level money surface is gated', () => {
  const gated = [
    'src/app/biz/page.tsx',
    'src/app/biz/season/[season]/page.tsx',
    'src/components/BizBuzzCard.tsx',
    ...readdirSync(join(ROOT, 'src/app/biz'))
      .filter((d) => ['musicals-since-reopening', 'reviews-and-money', 'fastest-recoups', 'biggest-flops', 'tony-winners'].includes(d))
      .map((d) => `src/app/biz/${d}/page.tsx`),
  ];
  assert.equal(gated.length, 8);
  for (const p of gated) assert.match(read(p), /<MoneyGate page="/, `${p} renders a MoneyGate`);
});

test('a failed save waits in the outbox and is retried until stored (BRO-6289)', async () => {
  const store = {};
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  const env = { url: process.env.NEXT_PUBLIC_SUPABASE_URL, key: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY };
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://db.example';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
  globalThis.window = {};
  globalThis.localStorage = {
    getItem: (k) => store[k] ?? null,
    setItem: (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
  };
  const calls = [];
  let up = false;
  globalThis.fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body).p_email);
    if (!up) throw new Error('network down');
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    // The save fails: the reader is still let in, the address is kept.
    assert.equal(await gate.submitMoneySignup(' Reader@Example.com ', 'investor', 'biz-dashboard:/biz'), 'store_unavailable');
    assert.deepEqual(JSON.parse(store[gate.MONEY_PENDING_KEY]), [{ email: 'reader@example.com', role: 'investor', page: 'biz-dashboard:/biz' }]);

    // Next page view, still down: it stays queued.
    gate.resetMoneyRetryForTests();
    assert.deepEqual(await gate.retryPendingMoneySignups(), { stored: 0, remaining: 1 });
    // Only once per page load.
    assert.deepEqual(await gate.retryPendingMoneySignups(), { stored: 0, remaining: 0 });

    // Store back up: the retry saves it and empties the outbox.
    up = true;
    gate.resetMoneyRetryForTests();
    assert.deepEqual(await gate.retryPendingMoneySignups(), { stored: 1, remaining: 0 });
    assert.equal(store[gate.MONEY_PENDING_KEY], undefined);
    assert.deepEqual(calls, ['reader@example.com', 'reader@example.com', 'reader@example.com']);

    // A save that works never touches the outbox.
    assert.equal(await gate.submitMoneySignup('second@example.com', '', 'show-page:/show/x'), 'stored');
    assert.equal(store[gate.MONEY_PENDING_KEY], undefined);
  } finally {
    Object.assign(globalThis, saved);
    process.env.NEXT_PUBLIC_SUPABASE_URL = env.url;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = env.key;
    gate.resetMoneyRetryForTests();
  }
});

test('every gate retries the outbox on mount', () => {
  const tsx = read('src/components/biz/MoneyGate.tsx');
  assert.match(tsx, /retryPendingMoneySignups\(\)/);
});

// BRO-6331: gate and Email Tom events must reach GA4 (the only analytics that works).
test('gaEvent sends through window.gtag, or holds the event until gtag loads', async () => {
  const { gaEvent } = tsxRequire('../../src/lib/analytics/ga-event.ts', import.meta.url);
  const calls = [];
  globalThis.window = { gtag: (...a) => calls.push(a) };
  gaEvent('money_gate_shown', { page: 'biz-dashboard' });
  assert.deepEqual(calls, [['event', 'money_gate_shown', { page: 'biz-dashboard' }]]);
  globalThis.window = {};
  gaEvent('email_tom_click', { page_path: '/biz' });
  assert.equal(window.dataLayer, undefined, 'must not queue ahead of gtag config');
  window.gtag = (...a) => calls.push(a);
  await new Promise((r) => setTimeout(r, 400));
  assert.deepEqual(calls[1], ['event', 'email_tom_click', { page_path: '/biz' }]);
  delete globalThis.window;
});

test('every money gate event and email_tom_click is wired to GA4', () => {
  const gateSrc = read('src/components/biz/MoneyGate.tsx');
  for (const ev of ['money_gate_shown', 'money_gate_unlocked', 'money_gate_bypassed']) {
    assert.match(gateSrc, new RegExp(`gaEvent\\('${ev}'`), `${ev} missing gaEvent`);
  }
  assert.match(read('src/components/EmailTomLink.tsx'), /gaEvent\('email_tom_click'/);
});

// ---- BRO-6339: fake-email rules ----
const me = tsxRequire('../../src/lib/money-email.ts', import.meta.url);

test('junk, disposable and malformed addresses are refused; real ones pass (BRO-6339)', () => {
  const refused = {
    'a@a1a.com': 'junk', 'x@mailinator.com': 'disposable', 'test@gmail.com': 'junk', 'asdf@gmail.com': 'junk',
    'aaaa@gmail.com': 'junk', 'Test+1@gmail.com': 'junk', 'a@b': 'format', 'foo@sub.mailinator.com': 'disposable',
    'real.person@yopmail.com': 'disposable', 'x@mailinator.com.': 'disposable',
  };
  for (const [e, why] of Object.entries(refused)) {
    assert.equal(me.moneyEmailProblem(e), why, e);
    assert.equal(gate.isValidMoneyEmail(e), false, e);
  }
  for (const ok of ['jane@gmail.com', 'tom.p@att.net', 'x.y@mba.berkeley.edu', 'testa@gmail.com', 'ab@gmail.com', 'notmailinator@gmail.com', 'me@mailinator.com.au', 'aa@family.org']) {
    assert.equal(gate.isValidMoneyEmail(ok), true, ok);
  }
});

test('typo domains get a suggestion, real ones do not (BRO-6339)', () => {
  assert.equal(me.suggestMoneyEmail('jane@gmial.com'), 'jane@gmail.com');
  assert.equal(me.suggestMoneyEmail(' Jane@Gmail.co '), 'Jane@gmail.com');
  assert.equal(me.suggestMoneyEmail('a.b@yaho.com'), 'a.b@yahoo.com');
  assert.equal(me.suggestMoneyEmail('x@hotmial.com'), 'x@hotmail.com');
  assert.equal(me.suggestMoneyEmail('jane@gmail.com'), null);
  assert.equal(me.suggestMoneyEmail('not an email'), null);
  for (const [bad, good] of Object.entries(me.DOMAIN_TYPOS)) assert.notEqual(bad, good);
});

const dohStub = (table) => async (url) => {
  const u = new URL(url);
  const hit = table[`${u.searchParams.get('name')}/${u.searchParams.get('type')}`];
  if (hit === 'throw') throw new Error('network');
  if (hit === 'hang') return new Promise(() => {});
  return { ok: hit !== 'http500', json: async () => hit ?? { Status: 0 } };
};

test('mail-server check refuses only on positive DNS evidence, fails open otherwise (BRO-6339)', async () => {
  const mx = (d) => ({ Status: 0, Answer: [{ type: 15, data: `10 mx.${d}.` }] });
  const t = {
    'att.net/MX': mx('att.net'),
    'a1a.com/MX': { Status: 0 }, 'a1a.com/A': { Status: 0 },
    'noaddr.test/MX': { Status: 0 }, 'noaddr.test/A': { Status: 0 },
    'v6.test/MX': { Status: 0 }, 'v6.test/A': { Status: 0 }, 'v6.test/AAAA': { Status: 0, Answer: [{ type: 28, data: '::1' }] },
    'implicit.test/MX': { Status: 0 }, 'implicit.test/A': { Status: 0, Answer: [{ type: 1, data: '1.2.3.4' }] },
    'gone.test/MX': { Status: 3 },
    'nullmx.test/MX': { Status: 0, Answer: [{ type: 15, data: '0 .' }] },
    'servfail.test/MX': { Status: 2 },
    'down.test/MX': 'throw', 'five.test/MX': 'http500', 'slow.test/MX': 'hang',
  };
  const f = dohStub(t);
  const run = (e, ms) => me.checkMailServer(e, f, ms);
  assert.equal(await run('x@att.net'), 'ok');
  assert.equal(await run('x@noaddr.test'), 'no_mail_server');
  assert.equal(await run('x@v6.test'), 'ok', 'AAAA-only host');
  assert.equal(await run('x@gone.test'), 'no_mail_server');
  assert.equal(await run('x@nullmx.test'), 'no_mail_server');
  assert.equal(await run('x@implicit.test'), 'ok', 'A record fallback');
  for (const d of ['servfail.test', 'down.test', 'five.test']) assert.equal(await run(`x@${d}`), 'ok', `${d} fails open`);
  assert.equal(await run('x@slow.test', 20), 'ok', 'timeout fails open');
  assert.equal(await me.checkMailServer('x@att.net', undefined === 1 ? f : null), 'ok', 'no fetch: fail open');
});

test('submitMoneySignup applies the sync rules and the mail-server check before saving (BRO-6339)', async () => {
  const saved = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch };
  const calls = [];
  const store = new Map();
  globalThis.window = {};
  globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) };
  process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://x.supabase.test';
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'k';
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).startsWith('https://dns.google/')) {
      const d = new URL(url).searchParams.get('name');
      if (d === 'gone.test') return { ok: true, json: async () => ({ Status: 3 }) };
      if (d === 'timeout.test') throw new Error('timeout');
      return { ok: true, json: async () => ({ Status: 0, Answer: [{ type: 15, data: '10 mx.' }] }) };
    }
    return { ok: true, status: 200, text: async () => '' };
  };
  try {
    assert.equal(await gate.submitMoneySignup('a@a1a.com', '', 'p'), 'invalid');
    assert.equal(await gate.submitMoneySignup('x@mailinator.com', '', 'p'), 'invalid');
    assert.equal(calls.length, 0, 'sync refusals make no network call');
    assert.equal(await gate.submitMoneySignup('jane@gone.test', '', 'p'), 'no_mail_server');
    assert.ok(!calls.some((u) => u.includes('/rpc/')), 'no mail server: never saved');
    assert.equal(await gate.submitMoneySignup('jane@gmail.com', '', 'p'), 'stored');
    assert.equal(await gate.submitMoneySignup('jane@timeout.test', '', 'p'), 'stored', 'DNS error still unlocks');
    assert.equal(store.get(gate.MONEY_PENDING_KEY), undefined, 'outbox untouched when stored');
  } finally {
    Object.assign(globalThis, saved);
  }
});

test('the RPC mirrors the TypeScript disposable and junk rules (BRO-6339)', () => {
  const sql = read('supabase/migrations/20261026b_money_signup_reject_junk.sql');
  const arr = (name) => [...sql.match(new RegExp(`${name} TEXT\\[\\] := ARRAY\\[(.*?)\\];`))[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(arr('v_disposable'), [...me.DISPOSABLE_DOMAINS]);
  assert.deepEqual(arr('v_junk'), [...me.JUNK_LOCAL_PARTS]);
  assert.match(sql, /v_local ~ '\^\(\.\)\(\\1\\1\+\)\?\$'/, 'repeated-character rule');
  assert.match(sql, /regexp_replace\(substring\(v_email from '@\(\[\^@\]\*\)\$'\), '\\\.\$', ''\)/, 'trailing dot stripped like the browser');
  assert.match(read('vercel.json'), /connect-src[^"]*https:\/\/dns\.google/, 'CSP allows the MX lookup host');
  assert.match(read('src/components/biz/MoneyGate.tsx'), /setKeepMine\(email\.trim\(\)\); \/\/ offered once/, 'suggestion is offered once');
  assert.match(sql, /split_part\(split_part\(v_email, '@', 1\), '\+', 1\)/, '+tag stripped like the browser');
  assert.match(sql, /v_domain = d OR v_domain LIKE '%\.' \|\| d/, 'subdomains of a disposable domain');
  assert.match(sql, /v_email !~ '\^\[\^@\\s\]\+@\[\^@\\s\]\+\\\.\[\^@\\s\]\+\$'/, 'format check kept');
  assert.match(sql, /DELETE FROM public\.money_scorecard_signups WHERE email = 'a@a1a\.com'/);
  assert.equal([...sql.matchAll(/RAISE EXCEPTION 'invalid email' USING ERRCODE = '22023'/g)].length, 3);
  // The gate maps both refusal kinds to a message and keeps the typo flow.
  const tsx = read('src/components/biz/MoneyGate.tsx');
  assert.match(tsx, /suggestMoneyEmail\(email\)/);
  assert.match(tsx, /MONEY_EMAIL_PROBLEM_MESSAGES\[reason\]/);
  for (const t of [read('src/lib/money-email.ts'), ...Object.values(me.MONEY_EMAIL_PROBLEM_MESSAGES)]) assert.doesNotMatch(t, /—/);
});

// BRO-6380: exercise the actual read and aggregation used by the admin page.
const { readAdminMoneySignups, summarizeMoneySignups } = tsxRequire('../../scripts/lib/admin-money-signups.js', import.meta.url);
const signupNow = new Date('2026-10-27T12:00:00Z');
const signupRow = (email, created_at = '2026-10-27T11:00:00Z', fields = {}) => ({
  email, created_at, role: 'investor', first_page: 'biz-dashboard:/biz', ...fields,
});
const signupResponse = (rows, range = rows.length ? `0-${rows.length - 1}/${rows.length}` : '*/0') => ({
  ok: true, headers: new Headers({ 'content-range': range }), json: async () => rows,
});
const signupOptions = { url: 'https://signups.invalid', serviceKey: 'test-service-key', now: signupNow };

test('admin counts and daily records exclude only the requested owner patterns', () => {
  const rows = [
    signupRow('reader@example.com'),
    signupRow('boundary@example.com', '2026-10-20T12:00:00Z'),
    signupRow('older@example.com', '2026-10-20T11:59:59Z', { role: null, first_page: null }),
    signupRow('thomas.pryor@example.com'), signupRow(' THOMAS.PRYOR+panel@example.com '),
    signupRow('tom_pryor@example.org'),
    signupRow('tom_pryor2@example.com', '2026-10-26T23:59:59Z'),
    signupRow('other.thomas.pryor@example.com'),
  ];
  const result = summarizeMoneySignups(rows, signupNow);
  assert.equal(result.total, 5);
  assert.equal(result.last7Days, 4, 'rolling seven days includes its exact boundary');
  assert.deepEqual(result.days.map(d => d.date), ['2026-10-27', '2026-10-26', '2026-10-20']);
  assert.deepEqual(result.days[0].signups.map(s => s.email), ['other.thomas.pryor@example.com', 'reader@example.com']);
  assert.deepEqual(result.days[2].signups[1], {
    email: 'older@example.com', createdAt: '2026-10-20T11:59:59.000Z', role: 'Unspecified', firstPage: 'Unspecified',
  });
  assert.equal(result.days[0].signups[0].firstPage, 'biz-dashboard:/biz');
  assert.equal(rows.length, 8, 'read-only, with no writes or input mutation');
});

test('admin reads every result page using a service key and no shared cache', async () => {
  const rows = [signupRow('reader@example.com'), signupRow('tom_pryor@example.com'), signupRow('older@example.com', '2026-10-01T00:00:00Z')];
  let calls = 0;
  const result = await readAdminMoneySignups({ ...signupOptions, fetchImpl: async (url, init) => {
    const offset = Number(url.searchParams.get('offset'));
    assert.equal(url.pathname, '/rest/v1/money_scorecard_signups');
    assert.equal(url.searchParams.get('select'), 'email,created_at,role,first_page');
    assert.equal(url.searchParams.get('order'), 'created_at.desc,email.asc');
    assert.equal(url.searchParams.get('created_at'), `lte.${signupNow.toISOString()}`);
    assert.equal(init.method, 'GET');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.headers.apikey, signupOptions.serviceKey);
    assert.equal(init.headers.Authorization, `Bearer ${signupOptions.serviceKey}`);
    assert.equal(init.headers.Prefer, 'count=exact');
    assert.ok(init.signal instanceof AbortSignal);
    calls++;
    // Even a server cap below our requested limit must not truncate the list.
    return signupResponse(rows.slice(offset, offset + 2), offset === 0 ? '0-1/3' : '2-2/3');
  } });
  assert.equal(calls, 2);
  assert.equal(result.total, 2);
  assert.equal(result.last7Days, 1);
});

test('an empty or owner-only list is a valid zero, missing credentials make no request', async () => {
  for (const rows of [[], [signupRow('thomas.pryor+test@example.com'), signupRow('tom_pryor@example.com')]]) {
    assert.deepEqual(await readAdminMoneySignups({ ...signupOptions, fetchImpl: async () => signupResponse(rows) }), {
      total: 0, last7Days: 0, days: [],
    });
  }
  let calls = 0;
  for (const missing of [{ url: undefined }, { serviceKey: undefined }]) {
    assert.deepEqual(await readAdminMoneySignups({ ...signupOptions, ...missing, fetchImpl: async () => { calls++; } }), { unavailable: true });
  }
  assert.equal(calls, 0);
});

test('upstream failures and incomplete scans never show partial totals or private errors', async () => {
  const row = signupRow('reader@example.com');
  const cases = [
    async () => { throw new Error('private upstream details'); },
    async () => ({ ok: false }),
    async () => signupResponse([row], '0-0/*'),
    async () => signupResponse([row], '2-2/3'),
    async () => signupResponse([signupRow('reader@example.com', 'invalid')]),
    async () => signupResponse([signupRow('reader@example.com', '2027-01-01T00:00:00Z')]),
    async () => signupResponse([{ created_at: row.created_at }]),
    async () => signupResponse({ error: 'private upstream details' }, '*/0'),
  ];
  for (const fetchImpl of cases) {
    assert.deepEqual(await readAdminMoneySignups({ ...signupOptions, fetchImpl }), { unavailable: true });
  }
  for (const lastPage of [signupResponse([], '*/2'), signupResponse([row], '1-1/3'), { ok: false }]) {
    let calls = 0;
    const result = await readAdminMoneySignups({ ...signupOptions, fetchImpl: async () => ++calls === 1 ? signupResponse([row], '0-0/2') : lastPage });
    assert.equal(calls, 2);
    assert.deepEqual(result, { unavailable: true });
  }
});

test('admin scan is bounded even when upstream advertises more pages', async () => {
  let calls = 0;
  const result = await readAdminMoneySignups({ ...signupOptions, fetchImpl: async () => {
    const offset = calls++;
    return signupResponse([signupRow(`reader${offset}@example.com`)], `${offset}-${offset}/101`);
  } });
  assert.equal(calls, 100);
  assert.deepEqual(result, { unavailable: true });
});

test('the dynamic server admin page authorizes before reading emails and is linked from accounts', () => {
  const page = read('src/app/admin/page.tsx');
  assert.match(page, /if \(!\(await isAdmin\(\)\)\) notFound\(\);/);
  assert.ok(page.indexOf('notFound();') < page.indexOf('await getAdminMoneySignups()'));
  assert.match(page, /dynamic = 'force-dynamic'/);
  assert.match(page, /index: false, follow: false/);
  assert.doesNotMatch(page, /['"]use client['"]/);
  const server = read('src/lib/admin-money-signups.ts');
  assert.match(server, /import 'server-only'/);
  assert.match(server, /readAdminMoneySignups\(/);
  assert.match(server, /serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(read('src/app/admin/accounts/page.tsx'), /href="\/admin"/);
});
