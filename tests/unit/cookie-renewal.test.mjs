// timebomb-audit-exempt: the lock-reclaim test measures lock age as Date.now() minus fs mtime (renew.LOCK_STALE_MS); clock-shift cannot move the filesystem clock, so every fresh lock looks stale
// tests/unit/cookie-renewal.test.mjs — BRO-4183 automatic cookie renewal.
//
// Covers the guards that keep renew-cookies.js from repeating the
// 2026-03-30 device-limit incident (login gate, fail-closed lock), the probe
// that decides whether to log in at all, and the two bundle-side changes
// that keep renewed cookies from being clobbered: the extractor skipping
// auto-renewed outlets and the loader's per-outlet / newest-wins meta.
// Every assertion drives the real module (CLAUDE.md §15).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { classifyWalledProbe, COOKIE_PROBES } = require('../../scripts/lib/cookie-probes.js');
const renew = require('../../scripts/lib/cookie-renew.js');
const loader = require('../../scripts/lib/cookie-loader.js');

const long = 'x'.repeat(2000);
const HOUR = 3600 * 1000;

test('classifyWalledProbe: logged-in / logged-out / vacuous / error', () => {
  const p = { minBody: 1200, wallMarker: /THIS IS NOT A PAYWALL/i };
  const walled = { html: '<div>THIS IS NOT A PAYWALL</div>', body: '' };
  assert.equal(classifyWalledProbe({ ...p, withCookies: { html: '<p>', body: long }, withoutCookies: walled }), 'logged-in');
  assert.equal(classifyWalledProbe({ ...p, withCookies: { html: '<p>', body: 'short' }, withoutCookies: walled }), 'logged-out');
  // Long body but the wall marker is present: still logged out.
  assert.equal(classifyWalledProbe({ ...p, withCookies: { html: 'THIS IS NOT A PAYWALL', body: long } }), 'logged-out');
  // The old A Doll's House probe: full body with no cookies.
  assert.equal(classifyWalledProbe({ ...p, withCookies: { html: '<p>', body: long }, withoutCookies: { html: '<p>', body: long } }), 'vacuous');
  assert.equal(classifyWalledProbe({ ...p, withCookies: { html: '', body: '' } }), 'error');
  assert.ok(COOKIE_PROBES.thestage.url.startsWith('https://www.thestage.co.uk/reviews/'));
});

test('classifyWalledProbe: with gateMarker, an unrecognised short page is error, never logged-out', () => {
  const p = { minBody: 1200, wallMarker: /THIS IS NOT A PAYWALL/i, gateMarker: COOKIE_PROBES.thestage.gateMarker };
  const gate = { html: '<a href="https://www.thestage.co.uk/registration?utm_source=Reggate">create a free account</a>', body: '' };
  const challenge = { html: '<title>Just a moment...</title><div id="cf-chl-widget"></div>', body: '' };
  assert.equal(classifyWalledProbe({ ...p, withCookies: gate, withoutCookies: gate }), 'logged-out');
  // Cloudflare challenge on the cookie fetch: uncertain, so no login.
  assert.equal(classifyWalledProbe({ ...p, withCookies: challenge, withoutCookies: gate }), 'error');
  // Challenge on the control fetch: can't tell what the wall looks like.
  assert.equal(classifyWalledProbe({ ...p, withCookies: gate, withoutCookies: challenge }), 'error');
  assert.equal(classifyWalledProbe({ ...p, withCookies: { html: '<p>', body: long }, withoutCookies: gate }), 'logged-in');
});

test('decideLogin: first login allowed', () => {
  assert.deepEqual(renew.decideLogin(undefined, Date.now()), { allowed: true, escalate: false, reason: 'ok' });
});

test('decideLogin: cooldown blocks a second login inside 20h without escalating', () => {
  const now = Date.now();
  const d = renew.decideLogin({ logins: [new Date(now - 2 * HOUR).toISOString()] }, now);
  assert.equal(d.allowed, false);
  assert.equal(d.escalate, false);
  assert.match(d.reason, /cooldown/);
});

test('decideLogin: 2 logins in 7 days escalates to needs-human (session ping-pong)', () => {
  const now = Date.now();
  const d = renew.decideLogin({ logins: [new Date(now - 30 * HOUR).toISOString(), new Date(now - 100 * HOUR).toISOString()] }, now);
  assert.equal(d.allowed, false);
  assert.equal(d.escalate, true);
  // Old logins outside the window don't count.
  const ok = renew.decideLogin({ logins: [new Date(now - 30 * HOUR).toISOString(), new Date(now - 8 * 24 * HOUR).toISOString()] }, now);
  assert.equal(ok.allowed, true);
});

test('decideLogin: needs-human is sticky', () => {
  const d = renew.decideLogin({ logins: [], needsHuman: { at: '2026-09-27T00:00:00Z', reason: 'captcha' } }, Date.now());
  assert.equal(d.allowed, false);
  assert.equal(d.escalate, false);
  assert.match(d.reason, /--reset/);
});

test('classifyLoginFailure words the alert', () => {
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/login', html: '<iframe src="https://www.google.com/recaptcha/api2">' }), 'captcha');
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/verify', html: '<input autocomplete="one-time-code">' }), 'code');
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/login', html: 'Your password is incorrect' }), 'rejected');
  assert.equal(renew.classifyLoginFailure({ url: 'https://x/somewhere', html: '<p>hello</p>' }), 'unknown');
});

test('acquireLock is fail-closed while the holder is alive, reclaims a dead holder', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renew-lock-'));
  const lock = path.join(dir, 'x.lock');

  const release = renew.acquireLock(lock);
  assert.equal(typeof release, 'function');
  assert.equal(renew.acquireLock(lock), null, 'second acquire while we hold it');
  release();

  // Lock left by a process that has exited.
  const child = spawn(process.execPath, ['-e', '0']);
  await new Promise((r) => child.on('exit', r));
  fs.writeFileSync(lock, `${child.pid} 2026-09-27T00:00:00Z\n`);
  const again = renew.acquireLock(lock);
  assert.equal(typeof again, 'function', 'dead-PID lock is reclaimed');
  again();
  assert.equal(fs.existsSync(lock), false);

  // Live PID (a reused PID after reboot looks like this) but older than
  // LOCK_STALE_MS: reclaimed rather than skipping every run forever.
  fs.writeFileSync(lock, `${process.pid} old\n`);
  const old = new Date(Date.now() - renew.LOCK_STALE_MS - 60000);
  fs.utimesSync(lock, old, old);
  const third = renew.acquireLock(lock);
  assert.equal(typeof third, 'function', 'age-stale lock is reclaimed');
  third();
});

test('readKeychain returns null instead of throwing when the item is missing', () => {
  const exec = () => { throw new Error('SecKeychainSearchCopyNext: not found'); };
  assert.equal(renew.readKeychain('thestage-password', { exec }), null);
  const seen = [];
  const ok = renew.readKeychain('thestage-email', { exec: (cmd, argv) => { seen.push([cmd, ...argv]); return 'me@example.com\n'; } });
  assert.equal(ok, 'me@example.com');
  assert.deepEqual(seen[0], ['security', 'find-generic-password', '-s', renew.KEYCHAIN_SERVICE, '-a', 'thestage-email', '-w']);
});

// --- cookie-loader per-outlet meta -------------------------------------------

function withBundles(bundles, fn) {
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('COOKIES_BUNDLE_') || k === 'THESTAGE_COOKIES') delete process.env[k];
  bundles.forEach((b, i) => { process.env[`COOKIES_BUNDLE_${i + 1}`] = Buffer.from(JSON.stringify(b)).toString('base64'); });
  loader.clearCache();
  try { return fn(); } finally {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    loader.clearCache();
  }
}

test('loader: per-outlet _meta.outlets beats bundle-level _meta', () => {
  const renewed = { extractedAt: '2026-09-27T10:00:00Z', extractedAtUnix: 1790503200, method: 'auto-renew' };
  const b = { _meta: { extractedAt: '2026-07-20T00:00:00Z', extractedAtUnix: 1784505600, outlets: { thestage: renewed } }, thestage: [{ name: 'USER', value: 'new', domain: '.thestage.co.uk' }], variety: [{ name: 'a', value: 'b', domain: '.variety.com' }] };
  withBundles([b], () => {
    assert.equal(loader.loadCookieMeta('thestage').extractedAtUnix, 1790503200);
    assert.equal(loader.loadCookieMeta('thestage').method, 'auto-renew');
    assert.equal(loader.loadCookieMeta('variety').extractedAtUnix, 1784505600, 'others keep the bundle-level time');
    assert.equal(loader.loadCookieMeta('variety').outlets, undefined, 'bundle-level meta is returned without the outlets map');
  });
});

test('loader: same outlet in two bundles, newer meta wins regardless of order', () => {
  const stale = { _meta: { extractedAtUnix: 1700000000 }, thestage: [{ name: 'USER', value: 'dead', domain: '.thestage.co.uk' }] };
  const fresh = { _meta: { pushedAt: 'x', outlets: { thestage: { extractedAtUnix: 1790000000 } } }, thestage: [{ name: 'USER', value: 'live', domain: '.thestage.co.uk' }] };
  for (const order of [[fresh, stale], [stale, fresh]]) {
    withBundles(order, () => {
      assert.equal(loader.loadCookiesByFileKey('thestage').cookies[0].value, 'live');
    });
  }
});

test('loader: a copy with a known timestamp beats a meta-less leftover', () => {
  const leftover = { thestage: [{ name: 'USER', value: 'dead', domain: '.thestage.co.uk' }] };
  const fresh = { _meta: { outlets: { thestage: { extractedAtUnix: 1790000000 } } }, thestage: [{ name: 'USER', value: 'live', domain: '.thestage.co.uk' }] };
  for (const order of [[fresh, leftover], [leftover, fresh]]) {
    withBundles(order, () => {
      assert.equal(loader.loadCookiesByFileKey('thestage').cookies[0].value, 'live');
    });
  }
});

test('loader: bundles with no per-outlet meta behave as before', () => {
  const b = { _meta: { extractedAt: '2026-07-20T00:00:00Z' }, ft: [{ name: 'FTSession', value: 'v', domain: '.ft.com' }] };
  withBundles([b], () => {
    assert.equal(loader.loadCookiesByFileKey('ft').source, 'bundle');
    assert.equal(loader.loadCookieMeta('ft').extractedAt, '2026-07-20T00:00:00Z');
  });
});

// --- extractor: auto-renewed outlets are never overwritten by Safari ----------

const HARNESS = `
import importlib.util, json, os, sys, time
spec = importlib.util.spec_from_file_location("ext", sys.argv[1])
ext = importlib.util.module_from_spec(spec); spec.loader.exec_module(ext)
root = sys.argv[2]; mode = sys.argv[3]
cdir = os.path.join(root, "data", "cookies"); os.makedirs(cdir, exist_ok=True)
renewed = [{"name": "USER", "value": "RENEWED", "domain": ".thestage.co.uk", "path": "/", "expires": 0, "httpOnly": True, "secure": True}]
json.dump(renewed, open(os.path.join(cdir, "thestage.json"), "w"))
json.dump([{"name": "v", "value": "LOCALVARIETY", "domain": ".variety.com", "path": "/", "expires": 0, "httpOnly": False, "secure": True}], open(os.path.join(cdir, "variety.json"), "w"))
json.dump({"thestage": {"extractedAt": "2026-09-27T10:00:00+00:00", "extractedAtUnix": 1790503200, "method": "auto-renew"}, "variety": {"extractedAt": "2026-09-01T00:00:00+00:00", "extractedAtUnix": 1788220800}}, open(os.path.join(cdir, "_extracted-at.json"), "w"))
future = time.time() + 86400 * 30
safari = [
  {"name": "USER", "value": "DEAD_FROM_SAFARI", "domain": ".thestage.co.uk", "path": "/", "expires": future, "httpOnly": False, "secure": True},
  {"name": "v", "value": "SAFARIVARIETY", "domain": ".variety.com", "path": "/", "expires": future, "httpOnly": False, "secure": True},
]
ext.PROJECT_ROOT = root
ext.COOKIE_FILE = sys.argv[1]
ext.parse_binary_cookies = lambda p: safari
class Failed:
    returncode = 1
    stderr = "HTTP 403: Resource not accessible by integration"
ext.subprocess.run = (lambda *a, **k: Failed()) if mode == "push-fail" else (lambda *a, **k: None)
sidecar_before = open(os.path.join(cdir, "_extracted-at.json")).read()
os.remove(os.path.join(cdir, ".gitignore")) if os.path.exists(os.path.join(cdir, ".gitignore")) else None
sys.argv = ["extract"] + {"from-local": ["--from-local", "--dry-run"], "push-fail": ["--from-local", "--push"]}.get(mode, [])
exit_code = 0
try:
    ext.main()
except SystemExit as e:
    exit_code = e.code
bundles = ext.build_bundles(
  {"thestage": renewed, "variety": []},
  {"thestage": ext.outlet_meta_entry({"extractedAt": "a", "extractedAtUnix": 1, "method": "auto-renew"})},
  {"pushedAt": "now"}, 46 * 1024)
print("RESULT " + json.dumps({
  "stage": json.load(open(os.path.join(cdir, "thestage.json"))),
  "variety": json.load(open(os.path.join(cdir, "variety.json"))),
  "meta": json.load(open(os.path.join(cdir, "_extracted-at.json"))),
  "staleExists": os.path.exists(os.path.join(cdir, "thestage.json.stale")),
  "sidecarUnchanged": open(os.path.join(cdir, "_extracted-at.json")).read() == sidecar_before,
  "gitignoreCreated": os.path.exists(os.path.join(cdir, ".gitignore")),
  "exit": exit_code,
  "bundles": bundles,
}))
`;

function runExtractor(mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'renew-ext-'));
  const out = execFileSync('python3', ['-c', HARNESS, path.join(REPO, 'scripts', 'extract-safari-cookies.py'), root, mode], { encoding: 'utf8' });
  const line = out.split('\n').find((l) => l.startsWith('RESULT '));
  return { out, result: JSON.parse(line.slice(7)) };
}

test('extractor Safari run: auto-renewed thestage keeps its local cookies and meta; others refresh from Safari', () => {
  const { out, result } = runExtractor('safari');
  assert.equal(result.stage[0].value, 'RENEWED');
  assert.equal(result.meta.thestage.method, 'auto-renew');
  assert.equal(result.staleExists, false);
  assert.equal(result.variety[0].value, 'SAFARIVARIETY', 'non-renewed outlets still come from Safari');
  assert.match(out, /thestage: 1 cookies \[auto-renewed by renew-cookies\.js; Safari skipped\]/);
});

test('extractor --from-local: bundles come from local files, Safari untouched, per-outlet meta attached', () => {
  const { out, result } = runExtractor('from-local');
  assert.match(out, /--from-local: Safari not read/);
  assert.match(out, /COOKIES_BUNDLE_1: \d+ outlets/);
  assert.match(out, /thestage/);
  assert.equal(result.variety[0].value, 'LOCALVARIETY', 'from-local never rewrites local files');
  const [b] = result.bundles;
  assert.deepEqual(b._meta.outlets.thestage, { extractedAt: 'a', extractedAtUnix: 1, method: 'auto-renew' });
  assert.equal(b._meta.pushedAt, 'now');
  assert.equal(b._meta.outlets.variety, undefined);
  assert.equal(result.sidecarUnchanged, true, '--from-local leaves _extracted-at.json byte-identical');
  assert.equal(result.gitignoreCreated, false, '--from-local creates no files');
});

test('extractor --from-local --push: a failed secret push exits non-zero', () => {
  const { out, result } = runExtractor('push-fail');
  assert.match(out, /✗ COOKIES_BUNDLE_1: HTTP 403/);
  assert.equal(result.exit, 1);
});
