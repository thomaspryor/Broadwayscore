// tests/unit/cookie-renew-outlets.test.mjs — BRO-7705: automatic login
// renewal for nytimes, newyorker, wapo, thetimes, ft, telegraph.
//
// Drives the real modules (CLAUDE.md §15): adapter selection, the Keychain
// gate (one alert, sticky, self-clearing), expiry scheduling, failure
// classification, the shared probes' floors against the anonymous/subscriber
// body lengths measured live on 2026-11-17, the two-sample browser control,
// and the CLI guards (never in CI/cloud; unknown outlets are refused, not
// silently dropped).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const renew = require('../../scripts/lib/cookie-renew.js');
const { COOKIE_PROBES, classifyWalledProbe } = require('../../scripts/lib/cookie-probes.js');
const { FLOWS, runLoginFlow } = require('../../scripts/lib/cookie-login-adapters.js');
const bprobe = require('../../scripts/lib/cookie-browser-probe.js');
const { ADAPTERS } = require('../../scripts/lib/browser-outlet-adapters.js');

const NEW = ['nytimes', 'newyorker', 'wapo', 'thetimes', 'ft', 'telegraph'];
const DAY = 86400 * 1000;
const NOW = Date.parse('2026-11-17T12:00:00Z');
const sec = (ms) => Math.floor(ms / 1000);

test('every outlet has a probe, a login adapter with a browser flow, and auth cookies', () => {
  for (const o of ['thestage', ...NEW]) {
    const cfg = renew.RENEW_OUTLETS[o];
    assert.ok(cfg, `${o} in RENEW_OUTLETS`);
    assert.ok(COOKIE_PROBES[o], `${o} has a walled probe`);
    const a = renew.loginAdapterFor(o);
    assert.ok(a, `${o} has a login adapter`);
    assert.equal(typeof FLOWS[a.kind], 'function', `${o}: flow ${a.kind} exists`);
    assert.ok(Array.isArray(cfg.cookieDomains) && cfg.cookieDomains.length, `${o} cookieDomains`);
    assert.ok(cfg.authCookies.length, `${o} has measured auth cookies`);
    assert.equal(cfg.manualOnly, undefined, `${o} is not manual-only`);
  }
  assert.equal(renew.loginAdapterFor('nope'), null);
});

test('adapter selection: NYT, New Yorker, FT and Telegraph need only the email (Gmail code); the rest need email + password', () => {
  for (const o of ['nytimes', 'newyorker', 'ft', 'telegraph']) assert.deepEqual(renew.loginAdapterFor(o).credentials, ['email'], o);
  assert.equal(renew.loginAdapterFor('nytimes').kind, 'nyt-otp');
  assert.match('Log in with code 123456', renew.loginAdapterFor('nytimes').otp.codePattern);
  assert.equal('Your one time code is 654321'.match(renew.loginAdapterFor('newyorker').otp.codePattern)[1], '654321');
  for (const o of ['wapo', 'thetimes', 'thestage']) {
    assert.deepEqual(renew.loginAdapterFor(o).credentials, ['email', 'password'], o);
  }
  assert.equal(renew.loginAdapterFor('thetimes').kind, 'one-step-password');
  assert.equal(renew.loginAdapterFor('wapo').kind, 'two-step-password');
});

// Real email wording, 2026-11-19 (codes replaced). FT's password route ends in an
// hCaptcha puzzle and Telegraph no longer offers a password step, so both sign in
// by emailed code; these pin the Gmail parsers to what the outlets actually send.
test('FT and Telegraph sign in by emailed code, parsed from their real email wording', () => {
  assert.equal(renew.loginAdapterFor('ft').kind, 'ft-otp');
  assert.equal(renew.loginAdapterFor('telegraph').kind, 'telegraph-otp');
  const ft = renew.loginAdapterFor('ft').otp;
  assert.equal(ft.fromFilter, 'mail.ft.com');
  assert.equal('To complete your secure login, please enter the following code on your FT screen:\n*482913*\nPlease note'.match(ft.codePattern)[1], '482913');
  const tg = renew.loginAdapterFor('telegraph').otp;
  assert.equal(tg.fromFilter, 'telegraph.co.uk');
  assert.equal('Subject: 370123 is your verification code'.match(tg.codePattern)[1], '370123');
  assert.equal('no code in this one'.match(tg.codePattern), null);
});

test('password and FT flows disable passkeys first (FT stalls on a WebAuthn prompt otherwise)', async () => {
  for (const o of ['wapo', 'ft']) {
    const page = emptyPage();
    await runLoginFlow(page, renew.loginAdapterFor(o), renew.RENEW_OUTLETS[o], { email: 'a@b.c', password: 'pw' }, { pollOtp: async () => null });
    assert.ok(page.initScripts.length >= 1, o);
  }
});

test('profiles are shared with the gap-driver adapters (same Chrome profile = same device)', () => {
  assert.equal(renew.profileNameFor('nytimes'), 'nyt');
  for (const o of ['thestage', 'nytimes', 'newyorker', 'wapo', 'thetimes', 'telegraph']) {
    const name = renew.profileNameFor(o);
    assert.ok(ADAPTERS[name], `${o} -> profile ${name} is a browser-outlet adapter profile`);
    assert.ok(renew.RENEW_OUTLETS[o].cookieDomains.includes(ADAPTERS[name].cookieDomain), `${o} cookie domain matches the adapter`);
  }
});

test('missingCredentials lists only absent Keychain items', () => {
  const nyt = renew.loginAdapterFor('nytimes');
  assert.deepEqual(renew.missingCredentials(nyt, { email: null }), ['email']);
  assert.deepEqual(renew.missingCredentials(nyt, { email: 'a@b.c' }), []);
  assert.deepEqual(renew.missingCredentials(renew.loginAdapterFor('wapo'), { email: 'a@b.c' }), ['password']);
});

test('credentialGate: missing Keychain items alert once, stay stopped, and clear themselves once added', () => {
  const ft = renew.loginAdapterFor('wapo'); // a password outlet
  const first = renew.credentialGate({}, ft, { email: null, password: null }, '2026-11-17T00:00:00Z');
  assert.equal(first.action, 'stop-new');
  assert.equal(first.state.needsHuman.code, 'creds-missing');
  assert.deepEqual(first.missing, ['email', 'password']);
  // Next run: still missing -> sticky, no second alert.
  const second = renew.credentialGate(first.state, ft, { email: null, password: null }, '2026-11-17T06:00:00Z');
  assert.equal(second.action, 'stop-sticky');
  assert.equal(second.state.needsHuman.at, '2026-11-17T00:00:00Z');
  const d = renew.decideLogin(second.state, NOW);
  assert.equal(d.allowed, false);
  assert.equal(d.escalate, false, 'a sticky stop never re-alerts');
  assert.match(d.reason, /clears itself/);
  // Owner adds the items -> cleared without --reset, login allowed.
  const third = renew.credentialGate(second.state, ft, { email: 'a@b.c', password: 'x' }, '2026-11-17T12:00:00Z');
  assert.equal(third.action, 'proceed');
  assert.equal(third.state.needsHuman, null);
  assert.equal(renew.decideLogin(third.state, NOW).allowed, true);
});

test('credentialGate never clears a different needs-human stop (failed login, login limit)', () => {
  const st = { logins: [], needsHuman: { at: 'x', reason: 'login did not produce a session: captcha', code: 'login-failed' } };
  const g = renew.credentialGate(st, renew.loginAdapterFor('wapo'), { email: 'a', password: 'b' }, 'y');
  assert.equal(g.action, 'proceed');
  assert.equal(g.state.needsHuman.code, 'login-failed');
  assert.equal(renew.decideLogin(g.state, NOW).allowed, false);
  assert.equal(renew.credentialGate(st, null, {}, 'y').action, 'stop-sticky');
});

test('soonestAuthExpiry: the earliest dated auth cookie; session and non-auth cookies ignored', () => {
  const cookies = [
    { name: 'authId', expires: sec(NOW + 10 * DAY) },
    { name: 'authId', expires: sec(NOW + 2 * DAY) },
    { name: 'other', expires: sec(NOW + 1000) },
    { name: 'NYT-S', expires: -1 },
  ];
  assert.deepEqual(renew.soonestAuthExpiry(cookies, ['authId', 'NYT-S']), { name: 'authId', expiresMs: sec(NOW + 2 * DAY) * 1000 });
  assert.equal(renew.soonestAuthExpiry(cookies, ['missing']), null);
  assert.equal(renew.soonestAuthExpiry(null, ['authId']), null);
});

test('planRenewal: renew before the soonest auth cookie lapses, not only after a failure', () => {
  const auth = ['authId'];
  const far = [{ name: 'authId', expires: sec(NOW + 10 * DAY) }];
  const near = [{ name: 'authId', expires: sec(NOW + 2 * DAY) }];
  const gone = [{ name: 'authId', expires: sec(NOW - DAY) }];
  assert.equal(renew.planRenewal({ probeStatus: 'logged-in', cookies: far, authCookies: auth, nowMs: NOW }).action, 'none');
  const p = renew.planRenewal({ probeStatus: 'logged-in', cookies: near, authCookies: auth, nowMs: NOW });
  assert.equal(p.action, 'refresh');
  assert.match(p.reason, /expiring: authId 2\.0d left/);
  assert.equal(renew.planRenewal({ probeStatus: 'logged-in', cookies: gone, authCookies: auth, nowMs: NOW }).action, 'refresh');
  assert.equal(renew.planRenewal({ probeStatus: 'logged-out', cookies: far, authCookies: auth, nowMs: NOW }).action, 'refresh');
  assert.equal(renew.planRenewal({ probeStatus: 'unknown', cookies: far, authCookies: auth, nowMs: NOW }).action, 'refresh');
  // Uncertain probes never lead to a login.
  assert.equal(renew.planRenewal({ probeStatus: 'error', cookies: gone, authCookies: auth, nowMs: NOW }).action, 'stop');
  assert.equal(renew.planRenewal({ probeStatus: 'vacuous', cookies: gone, authCookies: auth, nowMs: NOW }).action, 'stop');
  // The lead is 3 days.
  assert.equal(renew.RENEW_LEAD_MS, 3 * DAY);
});

test('WaPo: wp_ak_signinv2 is not a scheduling cookie (it lapsed while the session still read 6589 chars)', () => {
  const cfg = renew.RENEW_OUTLETS.wapo;
  assert.ok(!cfg.authCookies.includes('wp_ak_signinv2'));
  const cookies = [
    { name: 'wp_ak_signinv2', expires: sec(NOW - 0.7 * DAY) },
    { name: 'wapo_secure_login_id', expires: sec(NOW + 388 * DAY) },
    { name: 'wapo_login_id', expires: sec(NOW + 388 * DAY) },
  ];
  assert.equal(renew.planRenewal({ probeStatus: 'logged-in', cookies, authCookies: cfg.authCookies, nowMs: NOW }).action, 'none');
});

test('authCookiesChanged: re-save only when the session itself changed', () => {
  const a = [{ domain: '.x.com', name: 'authId', value: 'v1', expires: 100 }, { domain: '.x.com', name: '_ga', value: 'g1' }];
  assert.equal(renew.authCookiesChanged(a, [...a], ['authId']), false);
  assert.equal(renew.authCookiesChanged(a, [a[0], { ...a[1], value: 'g2' }], ['authId']), false, 'tracking cookie churn is not a renewal');
  assert.equal(renew.authCookiesChanged(a, [{ ...a[0], value: 'v2' }, a[1]], ['authId']), true);
  assert.equal(renew.authCookiesChanged(a, [{ ...a[0], expires: 100 + 5 * 86400 }, a[1]], ['authId']), true, 'a rolled expiry is a renewal');
  assert.equal(renew.authCookiesChanged(a, [{ ...a[0], expires: 999 }, a[1]], ['authId']), false, 'sub-day sliding expiry is not (no push every run)');
  assert.equal(renew.authCookiesChanged([], a, ['authId']), true, 'no saved session -> save');
  assert.equal(renew.authCookiesChanged(a, [a[0], { ...a[1], value: 'g2' }], []), true, 'no auth list -> any change counts');
});

test('classifyLoginFailure: bot challenge, captcha, emailed code, rejection, unknown', () => {
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/login', html: '<title>Verifying Device</title>' }), 'bot-challenge');
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/', html: '<title>Security Verification</title>' }), 'bot-challenge');
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/', html: '<div class="g-recaptcha">' }), 'captcha');
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/', html: 'Enter the code we sent' }), 'code');
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/login', html: 'Incorrect password' }), 'rejected');
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/', html: '<p>hello</p>' }), 'unknown');
});

test('worstExitCode picks the most severe outlet result', () => {
  assert.equal(renew.worstExitCode([0, 0, 3, 1]), 3);
  assert.equal(renew.worstExitCode([0, 4, 3]), 4);
  assert.equal(renew.worstExitCode([]), 0);
});

// Body lengths measured on 2026-11-17 for the same url with the subscriber
// session and with none. The anonymous length must classify logged-out (not
// "logged in", the old NYT/FT bug) and the subscriber length logged-in.
const MEASURED = {
  nytimes: { sub: 6170, anon: 2904 },
  wapo: { sub: 6589, anon: 309 },
  newyorker: { sub: 8474, anon: 645 },
  ft: { sub: 3035, anon: 2312, anonHtml: '<title>Subscribe to read | Financial Times</title>' },
  thetimes: { sub: 2775, anon: 0 },
};
for (const [o, m] of Object.entries(MEASURED)) {
  test(`probe ${o}: anonymous ${m.anon} chars reads logged-out, subscriber ${m.sub} logged-in, never vacuous`, () => {
    const p = COOKIE_PROBES[o];
    // Production path (every probe field, incl. subscriberMarker).
    const cls = (len, html = '<p>article</p>', control) => bprobe.classify(p, { html, body: 'x'.repeat(len) }, control);
    const anonPage = { html: m.anonHtml || '<p>teaser</p>', body: 'x'.repeat(m.anon) };
    assert.equal(cls(m.anon, anonPage.html), 'logged-out');
    assert.equal(cls(m.sub, '<p>article</p>', anonPage), 'logged-in');
  });
}

test('browser-only probes: The Times, FT, New Yorker, Telegraph (bot walls / client-side paywalls)', () => {
  for (const o of ['thetimes', 'ft', 'newyorker', 'telegraph']) assert.equal(COOKIE_PROBES[o].browserOnly, true, o);
  for (const o of ['nytimes', 'wapo', 'thestage']) assert.ok(!COOKIE_PROBES[o].browserOnly, o);
});

test('a bot challenge is never logged-out or vacuous, on either side of the probe', () => {
  const p = COOKIE_PROBES.thetimes;
  const base = { minBody: p.minBody, wallMarker: p.wallMarker, gateMarker: p.gateMarker };
  const times = { html: '<html><title>Verifying Device</title></html>', body: '' };
  const ft403 = { html: '<title>Security Verification</title>', body: '' };
  assert.equal(classifyWalledProbe({ ...base, withCookies: times }), 'error');
  assert.equal(classifyWalledProbe({ ...base, withCookies: ft403, withoutCookies: ft403 }), 'error');
  assert.equal(classifyWalledProbe({ ...base, withCookies: { html: '<p>', body: 'x'.repeat(3000) }, withoutCookies: times }), 'error');
});

test('classifyWithControl: one anonymous full read is not enough to call the probe vacuous', async () => {
  const p = COOKIE_PROBES.telegraph;
  // Subscriber pages carry is-subscriber--true (subscriberMarker); `full` is a
  // control that is ALSO marked subscriber, i.e. a meaningless probe.
  const sub = { html: '<div class="is-subscriber--true"><p>article</p>', body: 'x'.repeat(2556) };
  const walled = { html: '<div class="martech-paywall__blur">', body: 'x'.repeat(168) };
  const full = { html: '<div class="is-subscriber--true"><p>article</p>', body: 'x'.repeat(2556) };
  const calls = [];
  const flaky = async (_p, o) => { calls.push(o.waitMs || 0); return calls.length === 1 ? full : walled; };
  const r = await bprobe.classifyWithControl(p, sub, { anon: flaky });
  assert.equal(r.status, 'logged-in');
  assert.deepEqual(calls, [0, 8000], 'second control waits longer');
  const always = async () => full;
  assert.equal((await bprobe.classifyWithControl(p, sub, { anon: always })).status, 'vacuous');
  let n = 0;
  const once = async () => { n++; return walled; };
  assert.equal((await bprobe.classifyWithControl(p, sub, { anon: once })).status, 'logged-in');
  assert.equal(n, 1, 'no second control when the first is walled');
});

// A page whose login form is not there: every flow must report formMissing
// (a needs-human stop) instead of throwing or "succeeding".
function emptyPage() {
  const gotos = []; const initScripts = [];
  const loc = { first: () => loc, count: async () => 0, fill: async () => {}, click: async () => {}, press: async () => {}, waitFor: async () => {} };
  return {
    gotos, initScripts,
    goto: async (u) => { gotos.push(u); },
    waitForTimeout: async () => {},
    waitForSelector: async () => { throw new Error('timeout'); },
    waitForLoadState: async () => {},
    waitForFunction: async () => {},
    locator: () => loc,
    getByRole: () => loc,
    getByText: () => loc,
    getByLabel: () => loc,
    frameLocator: () => { const f = { first: () => f, getByRole: () => loc }; return f; },
    addInitScript: async () => { initScripts.push(1); },
    url: () => 'https://example.test/login',
    content: async () => '<html></html>',
    keyboard: { press: async () => {} },
  };
}
for (const o of ['thestage', ...NEW]) {
  test(`login flow for ${o} goes to its login url and reports a missing form`, async () => {
    const page = emptyPage();
    const adapter = renew.loginAdapterFor(o);
    let polled = false;
    const r = await runLoginFlow(page, adapter, renew.RENEW_OUTLETS[o], { email: 'a@b.c', password: 'pw' }, { pollOtp: async () => { polled = true; return null; } });
    assert.equal(r.formMissing, true);
    assert.deepEqual(page.gotos, [renew.RENEW_OUTLETS[o].loginUrl]);
    assert.equal(polled, false, 'no one-time code requested when the form is missing');
  });
}

test('runLoginFlow refuses an unknown adapter kind', async () => {
  await assert.rejects(() => runLoginFlow(emptyPage(), { kind: 'nope' }, {}, {}), /no login flow/);
});

const run = (script, argv, env = {}) => spawnSync(process.execPath, [path.join(REPO, 'scripts', script), ...argv], {
  encoding: 'utf8', env: { ...process.env, CI: '', GITHUB_ACTIONS: '', CLAUDE_CODE_REMOTE: '', ...env }, timeout: 30000,
});

test('renew-cookies refuses CI and cloud sessions before touching anything', () => {
  for (const env of [{ CI: 'true' }, { GITHUB_ACTIONS: 'true' }, { CLAUDE_CODE_REMOTE: 'true' }]) {
    const r = run('renew-cookies.js', ['--outlets=all', '--probe-only'], env);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /Refusing to run in CI\/cloud/);
  }
});

test('renew-cookies and verify-cookie-login refuse unknown outlets instead of dropping them', () => {
  const a = run('renew-cookies.js', ['--outlets=nytimes,bogus', '--probe-only']);
  assert.equal(a.status, 1);
  assert.match(a.stderr, /Unknown or unsupported outlet\(s\): bogus/);
  const b = run('verify-cookie-login.js', ['--outlets=bogus']);
  assert.equal(b.status, 1);
  assert.match(b.stderr, /Unknown outlet\(s\): bogus/);
});

test('cookie alerts and CI expiry lines point auto-renewed outlets at renew-cookies.js, not the Safari dance', () => {
  const { buildAlert } = require('../../scripts/lib/cookie-expiry-alert.js');
  for (const o of NEW) assert.match(buildAlert({ name: o, layer: 2, authDays: 1, message: 'm' }).hint, new RegExp(`renew-cookies\\.js --outlet=${o}`));
  assert.match(buildAlert({ name: 'variety', layer: 2, authDays: 1, message: 'm' }).hint, /extract-safari-cookies/);
  const { checkAuthExpiry } = require('../../scripts/check-cookie-health.js');
  const soon = [{ name: 'authId', expires: Date.now() / 1000 + 2 * 86400 }];
  assert.match(checkAuthExpiry(soon, ['authId'], 'thetimes').message, /renew-cookies\.js --outlet=thetimes/);
  assert.match(checkAuthExpiry(soon, ['authId'], 'someoutlet').message, /Safari/);
});

test('confirmWall: a short body alone never confirms logged-out', () => {
  const { confirmWall } = require('../../scripts/lib/cookie-browser-probe.js');
  const p = COOKIE_PROBES.newyorker;
  const page = (html, httpStatus = 200) => ({ html, httpStatus, body: '' });
  assert.equal(confirmWall({ status: 'logged-out', page: page('<div class="InContentBarrier">'), hasAuthCookie: true }, p).ok, true);
  assert.equal(confirmWall({ status: 'logged-out', page: page('<p>short</p>'), hasAuthCookie: true }, p).ok, false, 'auth cookie + no marker = uncertain');
  assert.equal(confirmWall({ status: 'logged-out', page: page('<p>short</p>'), hasAuthCookie: false }, p).ok, true, 'no session to lose');
  assert.equal(confirmWall({ status: 'logged-out', page: page('<div class="InContentBarrier">', 404), hasAuthCookie: false }, p).ok, false, 'non-200 never confirms');
  assert.equal(confirmWall({ status: 'error', page: page('x'), hasAuthCookie: false }, p).ok, false);
});

test('hasAuthCookie: a metered free read without the auth cookie is not a session', () => {
  assert.equal(renew.hasAuthCookie([{ name: 'tmg_session', value: 'x' }], renew.RENEW_OUTLETS.telegraph.authCookies), true);
  assert.equal(renew.hasAuthCookie([{ name: 'tmg_session', value: '' }], renew.RENEW_OUTLETS.telegraph.authCookies), false);
  assert.equal(renew.hasAuthCookie([{ name: 'consent', value: 'x' }], renew.RENEW_OUTLETS.telegraph.authCookies), false);
  assert.equal(renew.hasAuthCookie([], []), true, 'no auth list = not checked');
});

test('trackUncertain: one digest alert after 12h stuck (BRO-7765) on an uncertain probe, reset on any other result', () => {
  const t0 = Date.parse('2026-11-17T00:00:00Z');
  let r = renew.trackUncertain({}, 1, t0);
  assert.equal(r.alert, false);
  r = renew.trackUncertain(r.state, 1, t0 + 11 * 3600e3);
  assert.equal(r.alert, false);
  r = renew.trackUncertain(r.state, 1, t0 + 13 * 3600e3);
  assert.equal(r.alert, true);
  r = renew.trackUncertain(r.state, 1, t0 + 25 * 3600e3);
  assert.equal(r.alert, false, 'only once');
  r = renew.trackUncertain(r.state, 0, t0 + 26 * 3600e3);
  assert.equal(r.state.uncertainSince, null);
  assert.equal(r.state.uncertainAlerted, false);
});

test('isCredsMissingStop accepts the new code and the legacy reason only', () => {
  assert.equal(renew.isCredsMissingStop({ code: 'creds-missing', reason: 'x' }), true);
  assert.equal(renew.isCredsMissingStop({ reason: 'Keychain credentials missing' }), true);
  assert.equal(renew.isCredsMissingStop({ code: 'login-failed', reason: 'bad password' }), false);
  assert.equal(renew.isCredsMissingStop(null), false);
});

test('cookieInDomains is a suffix match, not a substring match', () => {
  assert.equal(renew.cookieInDomains({ domain: '.ft.com' }, ['ft.com']), true);
  assert.equal(renew.cookieInDomains({ domain: 'markets.ft.com' }, ['ft.com']), true);
  assert.equal(renew.cookieInDomains({ domain: '.microsoft.com' }, ['ft.com']), false);
});

test('loginRefusal: Mac only, never CI or cloud', () => {
  const { loginRefusal } = require('../../scripts/lib/cookie-login-adapters.js');
  assert.equal(loginRefusal({}, 'darwin'), null);
  assert.match(loginRefusal({ CI: 'true' }, 'darwin'), /CI or a cloud/);
  assert.match(loginRefusal({ CLAUDE_CODE_REMOTE: 'true' }, 'darwin'), /CI or a cloud/);
  assert.match(loginRefusal({}, 'linux'), /darwin/);
});

test('standalone logins count toward the renew login ledger (device limit sees every session)', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const { recordStandaloneLogin } = require('../../scripts/lib/cookie-login-adapters.js');
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bro7705-')), 'state.json');
  fs.writeFileSync(p, JSON.stringify({ nytimes: { logins: ['2026-11-16T00:00:00Z'], needsHuman: null }, wapo: { logins: [] } }));
  recordStandaloneLogin('nytimes', p);
  const s = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(s.nytimes.logins.length, 2);
  assert.deepEqual(s.wapo.logins, [], 'other outlets untouched');
  assert.equal(renew.decideLogin(s.nytimes, Date.now()).allowed, false, 'two logins in 7 days -> the next renew run escalates instead of logging in');
});

// gmail search prints oldest first; the poller must type the NEWEST code
// (BRO-7705 review 2026-11-19: it took the first = oldest, a superseded code).
test('pickNewestCode takes the newest message: subject first, then its body', () => {
  const { pickNewestCode } = require('../../scripts/lib/otp-login-helpers.js');
  const tg = renew.loginAdapterFor('telegraph').otp.codePattern;
  const out = '2 match(es)\nuid=10 | Thu | Telegraph | 111111 is your verification code\nuid=11 | Thu | Telegraph | 222222 is your verification code';
  assert.equal(pickNewestCode(out, tg, () => ''), '222222');
  const ft = renew.loginAdapterFor('ft').otp.codePattern;
  const reads = [];
  const bodies = { 20: 'enter the following code on your FT screen: *333333*', 21: 'enter the following code on your FT screen: *444444*' };
  const ftOut = 'uid=20 | Your FT.com access code\nuid=21 | Your FT.com access code';
  assert.equal(pickNewestCode(ftOut, ft, (u) => { reads.push(u); return bodies[u]; }), '444444');
  assert.deepEqual(reads, ['21'], 'reads the newest body first and stops');
  const mixed = 'uid=30 | Your FT.com access code\nuid=31 | Your FT weekly digest';
  assert.equal(pickNewestCode(mixed, ft, (u) => (u === '30' ? bodies[20] : 'news')), '333333');
  assert.equal(pickNewestCode('no matches', ft, () => ''), null);
});

// Metered outlets (live renewal 2026-11-19 read 'vacuous' for both): a fresh
// anonymous browser can get a full free read. The page still names the reader,
// so the control counts as walled. Shapes below are the measured markers.
test('metered free reads in the control are not vacuous (Telegraph subscriber class, New Yorker meter bar)', async () => {
  const full = (n) => 'x'.repeat(n);
  const tg = COOKIE_PROBES.telegraph;
  const tgSub = { html: '<div class="articleRendererHTML logged-in--true is-subscriber--true">', body: full(2556) };
  const tgFree = { html: '<div class="articleRendererHTML logged-in--false is-subscriber--false">', body: full(2556) };
  const tgWalled = { html: '<div class="is-subscriber--false"><div class="martech-paywall__blur">', body: full(168) };
  assert.equal(bprobe.classify(tg, tgSub, tgFree), 'logged-in', 'free read with is-subscriber--false is not vacuous');
  assert.equal(bprobe.classify(tg, tgSub, tgWalled), 'logged-in');
  assert.equal(bprobe.classify(tg, tgFree), 'logged-out', 'a full body without the subscriber class is not a login');
  assert.equal((await bprobe.classifyWithControl(tg, tgSub, { anon: async () => tgFree })).status, 'logged-in');
  assert.equal(bprobe.classify(tg, tgSub, tgSub), 'vacuous', 'control also marked subscriber -> vacuous');
  // Review 2026-11-19: reader classes count only in a rendered class attribute.
  const cssLeak = { html: '<style>.is-subscriber--true .x{}</style><div class="is-subscriber--false">', body: full(2556) };
  assert.equal(bprobe.classify(tg, cssLeak), 'logged-out', 'subscriber class in CSS text is not a login');
  // A login is spent only on the rendered paywall, never on the reader class alone.
  const classOnly = { status: 'logged-out', page: { html: tgFree.html, httpStatus: 200 }, hasAuthCookie: true };
  assert.equal(bprobe.confirmWall(classOnly, tg).ok, false);
  assert.equal(bprobe.confirmWall({ ...classOnly, page: { html: tgWalled.html, httpStatus: 200 } }, tg).ok, true);

  const ny = COOKIE_PROBES.newyorker;
  const bundle = '"DualOfferInContentBarrier.subscriptionOffersLabel"';
  const nySub = { html: `<p class="paywall">${bundle}`, body: full(8474) };
  const nyFree = { html: `<div class="PaywallBarThinWrapper-iTSHA" data-testid="paywall-bar-thin">${bundle}`, body: full(8474) };
  assert.equal(bprobe.classify(ny, nySub, nyFree), 'logged-in', 'meter bar marks the free read as walled');
  assert.equal(bprobe.classify(ny, nyFree), 'logged-out');
  assert.equal(bprobe.classify(ny, nySub, nySub), 'vacuous', 'no bar on the control either -> vacuous');
  assert.ok(!ny.loginWallMarker.test(nySub.html), 'bundle string alone is not a wall');
  assert.ok(!ny.wallMarker.test('<div data-testid="paywall-barrier-copy">'), 'paywall-barrier is not the meter bar');
  assert.ok(ny.loginWallMarker.test(nyFree.html));
  assert.ok(bprobe.confirmWall({ status: 'logged-out', page: { html: nyFree.html, httpStatus: 200 }, hasAuthCookie: true }, ny).ok);
  assert.ok(!bprobe.confirmWall({ status: 'logged-out', page: { html: nySub.html, httpStatus: 200 }, hasAuthCookie: true }, ny).ok);
});

// BRO-7922: false FAILs on 2026-11-21 (New Yorker probe url aged free; NYT browser control 403).
test('classifyWithControl: NYT browser control blocked -> session-less profile control decides', async () => {
  const p = COOKIE_PROBES.nytimes;
  assert.equal(p.profileControl, true);
  const sub = { html: '<article>full</article>', body: 'x'.repeat(6170) };
  const blocked = { html: '<script src="https://geo.captcha-delivery.com/x"></script>', body: '', httpStatus: 403 };
  const sessionless = { html: '<div class="regiwall gateway-content">', body: 'x'.repeat(2904), httpStatus: 200 };
  const err404 = { ...sessionless, httpStatus: 404 };
  const r = await bprobe.classifyWithControl(p, sub, { anon: async () => blocked, profileControl: async () => sessionless });
  assert.equal(r.status, 'logged-in');
  // profile control also blocked, or none supplied -> still fails closed as before
  assert.equal((await bprobe.classifyWithControl(p, sub, { anon: async () => blocked, profileControl: async () => blocked })).status, 'control-blocked');
  assert.equal((await bprobe.classifyWithControl(p, sub, { anon: async () => blocked })).status, 'control-blocked');
  // a 404 from the profile control is not evidence
  assert.equal((await bprobe.classifyWithControl(p, sub, { anon: async () => blocked, profileControl: async () => err404 })).status, 'control-blocked');
  // a session-less profile that still reads the full article means the url is free
  const free = { html: '<article>full</article>', body: 'x'.repeat(6170), httpStatus: 200 };
  assert.equal((await bprobe.classifyWithControl(p, sub, { anon: async () => blocked, profileControl: async () => free })).status, 'vacuous');
  // outlets that did not opt in never use it
  const tg = COOKIE_PROBES.telegraph;
  let called = false;
  const r3 = await bprobe.classifyWithControl(tg, sub, { anon: async () => blocked, profileControl: async () => { called = true; return sessionless; } });
  assert.equal(r3.status, 'control-blocked'); assert.equal(called, false);
});

test('profileControlProbe removes only the auth cookies while loading, and always restores them', async () => {
  const jar = [{ name: 'NYT-S', domain: '.nytimes.com', value: 's' }, { name: 'datadome', domain: '.nytimes.com', value: 'd' }];
  const seen = [];
  const ctx = {
    cookies: async () => [...jar],
    clearCookies: async ({ name }) => { const i = jar.findIndex((c) => c.name === name); if (i >= 0) jar.splice(i, 1); },
    addCookies: async (cs) => { jar.push(...cs); },
    pages: () => [{ goto: async () => { seen.push(jar.map((c) => c.name).join(',')); return { status: () => 200 }; }, waitForTimeout: async () => {}, content: async () => '<html></html>' }],
  };
  await bprobe.profileControlProbe(ctx, { url: 'https://www.nytimes.com/x', minBody: 1 }, ['NYT-S'], { waitMs: 0 });
  assert.deepEqual(seen, ['datadome'], 'auth cookie absent, trust cookie present during the load');
  assert.deepEqual(jar.map((c) => c.name).sort(), ['NYT-S', 'datadome']);
  await assert.rejects(bprobe.profileControlProbe(ctx, { url: 'x' }, []));
});

test('classifyWithControl: a vacuous New Yorker probe url rotates to a walled alternate', async () => {
  const p = COOKIE_PROBES.newyorker;
  assert.ok(p.altUrls.length >= 1);
  const full = { html: '<p>article</p>', body: 'x'.repeat(8474) };
  const walled = { html: '<div data-testid="paywall-bar-thin">', body: 'x'.repeat(645) };
  const anon = async (probe) => (probe.url === p.url ? full : walled);
  const loadWithCookies = async () => full;
  const r = await bprobe.classifyWithControl(p, full, { anon, loadWithCookies });
  assert.equal(r.status, 'logged-in');
  assert.equal(r.usedUrl, p.altUrls[0]);
  // no rotation without a loader (verify-cookie-login path) or when every alternate is free
  assert.equal((await bprobe.classifyWithControl(p, full, { anon })).status, 'vacuous');
  assert.equal((await bprobe.classifyWithControl(p, full, { anon: async () => full, loadWithCookies })).status, 'vacuous');
});

test('every probe url in COOKIE_PROBES is unique and absolute (rotation list hygiene)', () => {
  const urls = Object.values(COOKIE_PROBES).flatMap((x) => [x.url, ...(x.altUrls || [])]);
  assert.equal(new Set(urls).size, urls.length);
  for (const u of urls) assert.match(u, /^https:\/\//);
});

test('rotation never passes a logged-out profile (alternate walled for the profile too)', async () => {
  const p = COOKIE_PROBES.newyorker;
  const full = { html: '<p>article</p>', body: 'x'.repeat(8474) };
  const walled = { html: '<div data-testid="paywall-bar-thin">', body: 'x'.repeat(645) };
  const r = await bprobe.classifyWithControl(p, full, { anon: async (pr) => (pr.url === p.url ? full : walled), loadWithCookies: async () => walled });
  assert.equal(r.status, 'vacuous', 'a dead session must keep the safe vacuous stop');
});

test('rotation loads alternates with the slow (8s) read so a late paywall bar is not missed', async () => {
  const p = COOKIE_PROBES.newyorker;
  const full = { html: '<p>article</p>', body: 'x'.repeat(8474) };
  const walled = { html: '<div data-testid="paywall-bar-thin">', body: 'x'.repeat(645) };
  const waits = [];
  // A logged-out profile whose paywall bar renders only on the slow read: must NOT come back logged-in.
  const loadWithCookies = async (_alt, o = {}) => { waits.push(o.waitMs); return o.waitMs >= 8000 ? walled : full; };
  const r = await bprobe.classifyWithControl(p, full, { anon: async (pr) => (pr.url === p.url ? full : walled), loadWithCookies });
  assert.ok(waits.length >= 1 && waits.every((w) => w === 8000), `alternates read with waitMs 8000, got ${waits}`);
  assert.equal(r.status, 'vacuous');
});

test('profileControlProbe: a failed cookie restore is logged and rethrown, never silent', async () => {
  const saved = [{ name: 'NYT-S', domain: '.nytimes.com', value: 'v' }];
  const errs = [];
  const orig = console.error; console.error = (m) => errs.push(String(m));
  const page = { goto: async () => {}, waitForTimeout: async () => {}, content: async () => '<p>x</p>', evaluate: async () => 'x', innerText: async () => 'x', close: async () => {} };
  const context = {
    cookies: async () => saved, clearCookies: async () => {},
    addCookies: async () => { throw new Error('boom'); },
    newPage: async () => page,
  };
  try {
    await assert.rejects(() => bprobe.profileControlProbe(context, { url: 'https://www.nytimes.com/x' }, ['NYT-S'], { waitMs: 0 }), /boom/);
  } finally { console.error = orig; }
  assert.ok(errs.some((m) => /RESTORE FAILED/.test(m)), 'restore failure must be logged');
});

test('BRO-8092 class guard: renew-cookies reads rotation alternates in the real profile with the 8s wait', async () => {
  const p = COOKIE_PROBES.newyorker;
  const full = { html: '<p>article</p>', body: 'x'.repeat(8474) };
  const walled = { html: '<div data-testid="paywall-bar-thin">', body: 'x'.repeat(645) };
  const waits = [];
  // A real-shaped context: loadProbe drives page.goto / waitForTimeout / content.
  // The logged-out profile's paywall bar renders only on the slow read.
  const page = {
    goto: async () => ({ status: () => 200 }),
    waitForTimeout: async (ms) => { waits.push(ms); },
    content: async () => (waits[waits.length - 1] >= 8000 ? walled.html : full.html),
  };
  const ctx = { pages: () => [page], cookies: async () => [], clearCookies: async () => {}, addCookies: async () => {} };
  const deps = bprobe.profileDeps(ctx, ['wpn_session']);
  const anon = async (pr) => (pr.url === p.url ? full : walled);
  const r = await bprobe.classifyWithControl(p, full, { anon, ...deps });
  assert.ok(waits.length >= 1 && waits.every((w) => w === 8000), `alternates loaded with waitForTimeout 8000 in the profile, got ${waits}`);
  assert.equal(r.status, 'vacuous', 'a logged-out profile whose bar renders late must not pass');
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(REPO, 'scripts/renew-cookies.js'), 'utf8');
  assert.ok(src.includes('bprobe.profileDeps(context, cfg.authCookies)'), 'renew-cookies must take its in-profile deps from profileDeps');
});

test('BRO-8092 class guard (BRO-7705): profileSession never calls a metered free read without the auth cookie a session', async () => {
  const cfg = renew.RENEW_OUTLETS.newyorker;
  // Full article, no paywall bar: the probe alone reads logged-in.
  const probe = { ...COOKIE_PROBES.newyorker, extractBody: () => 'x'.repeat(9000) };
  const ctxWith = (jar) => ({
    pages: () => [{ goto: async () => ({ status: () => 200 }), waitForTimeout: async () => {}, content: async () => '<p>article</p>' }],
    cookies: async () => jar,
  });
  const free = await bprobe.profileSession(ctxWith([{ name: 'other', domain: '.newyorker.com', value: 'v' }]), cfg, probe);
  assert.equal(free.status, 'logged-out', 'no CN_access = no session, whatever the body says');
  assert.equal(free.cookies, null);
  // An auth-cookie name on a look-alike domain is not this outlet's session.
  const lookalike = await bprobe.profileSession(ctxWith([{ name: 'CN_access', domain: '.notnewyorker.com', value: 'v' }]), cfg, probe);
  assert.equal(lookalike.status, 'logged-out');
  const real = await bprobe.profileSession(ctxWith([{ name: 'CN_access', domain: '.newyorker.com', value: 'v' }]), cfg, probe);
  assert.equal(real.status, 'logged-in');
  assert.deepEqual(real.cookies.map((c) => c.name), ['CN_access']);
  // The CLI uses this one implementation, and gates adopt/login on a confirmed wall.
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(REPO, 'scripts/renew-cookies.js'), 'utf8');
  assert.ok(src.includes('bprobe.profileSession(context, cfg, probe, o)'), 'renew-cookies must use cookie-browser-probe.profileSession');
  assert.match(src, /else if \(!c\.ok\) return done\(1, `profile reads logged out but it is not confirmed/, 'renew-cookies lost the confirmed-wall gate before adopt/login');
});

// BRO-8099: verify-cookie-login.js probed the saved jar with classifyWithControl
// and NO deps, so a vacuous primary url never rotated (BRO-7922) and a bot-walled
// anonymous control never fell back to the jar minus its auth cookies: it said
// VACUOUS / BOT-CHECK where renew-cookies.js rotated or passed. Now both go
// through the same profileDeps (classifySavedCookies).
function savedJarContext({ pageFor }) {
  let jar = [];
  let url = null;
  const page = {
    goto: async (u) => { url = u; return { status: () => 200 }; },
    waitForTimeout: async () => {},
    content: async () => pageFor(url, jar),
  };
  return {
    jar: () => jar,
    pages: () => [page],
    newPage: async () => page,
    addCookies: async (cs) => { jar = [...jar.filter((c) => !cs.some((n) => n.name === c.name)), ...cs]; },
    clearCookies: async ({ name }) => { jar = jar.filter((c) => c.name !== name); },
    cookies: async () => jar,
    close: async () => {},
  };
}
const FULL = '<p>' + 'w'.repeat(5000) + '</p>';
const WALL = '<div data-testid="paywall-bar-thin"></div><p>teaser</p>';
const strip = (h) => String(h).replace(/<[^>]*>/g, '');

test('classifySavedCookies rotates a vacuous primary url through altUrls, like renew-cookies', async () => {
  const p = { ...COOKIE_PROBES.newyorker, url: 'https://nyer.test/free', altUrls: ['https://nyer.test/walled'], extractBody: strip };
  // The free primary reads full for everyone; the alternate is walled without a session.
  const anon = async (pr) => ({ html: pr.url.endsWith('/free') ? FULL : WALL, body: strip(pr.url.endsWith('/free') ? FULL : WALL), httpStatus: 200 });
  const ctx = savedJarContext({ pageFor: (u, jar) => (u.endsWith('/free') || jar.some((c) => c.name === 'CN_access') ? FULL : WALL) });
  const r = await bprobe.classifySavedCookies(p, [{ name: 'CN_access', value: 'v', domain: '.nyer.test' }], ['CN_access'], { launch: async () => ctx, anon });
  assert.equal(r.status, 'logged-in');
  assert.equal(r.usedUrl, 'https://nyer.test/walled');
  // A jar with no auth cookie that still reads the full article is a metered free read (live 2026-11-25).
  const ctx2 = savedJarContext({ pageFor: () => FULL });
  const free = await bprobe.classifySavedCookies({ ...p, altUrls: [] }, [{ name: 'other', value: 'v', domain: '.nyer.test' }], ['CN_access'], { launch: async () => ctx2, anon: async () => ({ html: WALL, body: strip(WALL), httpStatus: 200 }) });
  assert.deepEqual([free.status, free.noAuthCookie], ['logged-out', true]);
  // Without the deps (the old verify-cookie-login call) the same jar read vacuous.
  assert.equal((await bprobe.classifyWithControl(p, r.withCookies, { anon })).status, 'vacuous');
});

test('classifySavedCookies falls back to the jar minus its auth cookies when the anonymous control is bot-walled', async () => {
  const p = { url: 'https://nyt.test/a', minBody: 4500, profileControl: true, extractBody: strip };
  const DD = { html: '<script src="https://ct.captcha-delivery.com/c.js"></script>', body: '', httpStatus: 403 };
  const ctx = savedJarContext({ pageFor: (_u, jar) => (jar.some((c) => c.name === 'NYT-S') ? FULL : '<p>gateway-content teaser</p>') });
  const saved = [{ name: 'NYT-S', value: 's', domain: '.nyt.test' }, { name: 'datadome', value: 'd', domain: '.nyt.test' }];
  const r = await bprobe.classifySavedCookies(p, saved, ['NYT-S'], { launch: async () => ctx, anon: async () => DD });
  assert.equal(r.status, 'logged-in', 'the in-jar control replaced the bot-walled anonymous one');
  assert.deepEqual(ctx.jar().map((c) => c.name).sort(), ['NYT-S', 'datadome'], 'auth cookies restored after the control');
  assert.equal((await bprobe.classifyWithControl(p, r.withCookies, { anon: async () => DD })).status, 'control-blocked', 'old no-deps call');
});

test('verify-cookie-login: browser targets use classifySavedCookies; fetch targets carry no altUrls (decided, no browser context)', async () => {
  const fs = await import('node:fs');
  const src = fs.readFileSync(path.join(REPO, 'scripts/verify-cookie-login.js'), 'utf8');
  assert.match(src, /bprobe\.classifySavedCookies\(p, saved, /, 'browser path must share renew-cookies deps');
  assert.doesNotMatch(src, /bprobe\.classifyWithControl\(/, 'a bare classifyWithControl call drops altUrls + profile control');
  const { TARGETS } = require('../../scripts/verify-cookie-login.js');
  for (const t of TARGETS.filter((x) => x.shared && !COOKIE_PROBES[x.outlet].browserOnly)) {
    assert.ok(!(COOKIE_PROBES[t.outlet].altUrls || []).length, `${t.outlet}: altUrls rotation needs the browser path; make it browserOnly`);
  }
});
