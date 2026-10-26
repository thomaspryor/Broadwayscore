/**
 * Money Scorecard email gate (BRO-6210): the unlock contract, the separate
 * list, popup suppression and the paywall markup. Runs in the tsx unit batch
 * (test.yml) and imports src TS directly, like gate-logic.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const gate = await import('../../src/lib/money-gate.ts');
const email = await import('../../src/lib/money-email.ts');
const { emailCaptureConfig } = await import('../../src/config/email-capture.ts');
const hooks = await import('../../src/hooks/useFormspreeSubscribed.ts');
const supa = await import('../../src/lib/supabase.ts');
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
  assert.match(tsx, />Unlock the Money Scorecard</);
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
  for (const ok of ['ab@b.co', ' Name.Last+tag@Example.org ']) assert.equal(gate.isValidMoneyEmail(ok), true, ok);
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

test('fake addresses are refused: junk locals, disposable domains, bad format (BRO-6339)', () => {
  for (const bad of ['a@a1a.com', 'x@gmail.com', 'aaaa@gmail.com', 'test@gmail.com', 'Asdf@yahoo.com']) {
    assert.equal(email.moneyEmailProblem(bad), 'junk', bad);
    assert.equal(gate.isValidMoneyEmail(bad), false, bad);
  }
  for (const bad of ['x@mailinator.com', 'jane@sub.mailinator.com', 'jane@YOPMAIL.com']) {
    assert.equal(email.moneyEmailProblem(bad), 'disposable', bad);
  }
  assert.equal(email.moneyEmailProblem('nope'), 'format');
  for (const ok of ['jane.doe@gmail.com', 'tom@att.net', 'sam@mba.berkeley.edu', 'me2@notmailinator.com']) {
    assert.equal(email.moneyEmailProblem(ok), null, ok);
  }
});

test('common domain typos get a suggestion, real domains do not (BRO-6339)', () => {
  assert.equal(email.suggestMoneyEmail('jane@gmial.com'), 'jane@gmail.com');
  assert.equal(email.suggestMoneyEmail('Jane@gmail.co'), 'jane@gmail.com');
  assert.equal(email.suggestMoneyEmail('jane@yaho.com'), 'jane@yahoo.com');
  assert.equal(email.suggestMoneyEmail('jane@hotmial.com'), 'jane@hotmail.com');
  assert.equal(email.suggestMoneyEmail('jane@gmail.com'), null);
});

async function withDoh(handler, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const dohReply = (body, ok = true) => ({ ok, status: ok ? 200 : 503, json: async () => body });

test('mail-server check: no MX and no A refuses; MX, A fallback, errors and timeouts accept', async () => {
  const byType = (mx, a) => async (url) => {
    const u = new URL(String(url));
    assert.equal(u.host, 'dns.google');
    return u.searchParams.get('type') === 'MX' ? dohReply(mx) : dohReply(a);
  };
  const none = { Status: 0 };
  const mxHit = { Status: 0, Answer: [{ type: 15, data: '10 mail.att.net.' }] };
  const aHit = { Status: 0, Answer: [{ type: 1, data: '1.2.3.4' }] };
  assert.equal(await withDoh(byType(none, none), () => email.domainAcceptsMail('a@a1a.com')), false);
  assert.equal(await withDoh(byType({ Status: 3 }, { Status: 3 }), () => email.domainAcceptsMail('a@nope.invalid')), false);
  assert.equal(await withDoh(byType(mxHit, none), () => email.domainAcceptsMail('t@att.net')), true);
  assert.equal(await withDoh(byType(none, aHit), () => email.domainAcceptsMail('t@a.example')), true);
  assert.equal(await withDoh(byType({ Status: 0, Answer: [{ type: 15, data: '0 .' }] }, none), () => email.domainAcceptsMail('t@nullmx.test')), false);
  // fail open
  assert.equal(await withDoh(async () => { throw new Error('offline'); }, () => email.domainAcceptsMail('t@att.net')), true);
  assert.equal(await withDoh(async () => dohReply({}, false), () => email.domainAcceptsMail('t@att.net')), true);
  assert.equal(await withDoh(async () => dohReply({ Status: 2 }), () => email.domainAcceptsMail('t@att.net')), true);
  const hang = (url, { signal }) => new Promise((_, rej) => signal.addEventListener('abort', () => rej(new Error('aborted'))));
  assert.equal(await withDoh(hang, () => email.domainAcceptsMail('t@att.net', 30)), true);
});

test('database function mirrors the disposable and junk rules (BRO-6339)', () => {
  const sql = read('supabase/migrations/20261026b_money_signup_reject_fake_emails.sql');
  for (const d of email.DISPOSABLE_DOMAINS) assert.ok(sql.includes(`'${d}'`), `domain ${d} in SQL`);
  const sqlDomains = [...sql.match(/unnest\(ARRAY\[(.*?)\]\)/s)[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sqlDomains, [...email.DISPOSABLE_DOMAINS]);
  for (const l of ['test', 'asdf', 'qwerty']) assert.ok(sql.includes(`'${l}'`), `local ${l} in SQL`);
  assert.match(sql, /length\(v_local\) < 2/);
  assert.match(sql, /DELETE FROM public\.money_scorecard_signups WHERE email = 'a@a1a\.com'/);
  assert.match(sql, /invalid email/, 'client maps this body to "invalid"');
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.money_scorecard_signup\(TEXT, TEXT, TEXT\) TO anon, authenticated/);
});

test('gate card wires the suggestion and the fail-open mail-server check (BRO-6339)', () => {
  const src = read('src/components/biz/MoneyGate.tsx');
  assert.match(src, /domainAcceptsMail\(email\)/);
  assert.match(src, /suggestMoneyEmail\(email\)/);
  assert.match(src, /data-money-suggestion/);
});
