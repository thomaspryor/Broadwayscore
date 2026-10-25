// BRO-5886: encrypted HTML handoff from a cloud session to execute-approved-fix.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const h = require('./html-handoff.js');

const URL_ = 'https://bachtrack.com/review-example-opera-october-2026';
const body = '<p>' + 'A review paragraph about the opera. '.repeat(40) + '</p>';
const page = (canon) => `<html><head><title>Review</title>${canon ? `<link rel="canonical" href="${canon}">` : ''}</head><body>${body}</body></html>`;
const { publicKey, privateKey } = h.generateKeyPair();

test('round trip: decrypt returns the exact HTML, and the envelope holds no plain text', () => {
  const html = page(URL_);
  const env = h.encryptHtml(html, URL_, publicKey);
  assert.equal(h.envelopeProblem(env), null);
  assert.ok(!JSON.stringify(env).includes('review paragraph'));
  assert.equal(h.decryptHtml(env, URL_, privateKey), html);
});

test('the url is bound in: an envelope replayed under another url fails', () => {
  const env = h.encryptHtml(page(URL_), URL_, publicKey);
  assert.throws(() => h.decryptHtml(env, 'https://bachtrack.com/other', privateKey));
});

test('tampered ciphertext fails the GCM tag', () => {
  const env = h.encryptHtml(page(URL_), URL_, publicKey);
  const ct = Buffer.from(env.ct, 'base64'); ct[0] ^= 1;
  assert.throws(() => h.decryptHtml({ ...env, ct: ct.toString('base64') }, URL_, privateKey));
});

test('an envelope for another key is refused by key id before decrypting', () => {
  const other = h.generateKeyPair();
  const env = h.encryptHtml(page(URL_), URL_, other.publicKey);
  assert.throws(() => h.decryptHtml(env, URL_, privateKey), /encrypted to key/);
});

test('size caps: oversize html refused at encrypt, oversize ciphertext refused by shape check', () => {
  assert.throws(() => h.encryptHtml('x'.repeat(h.MAX_HTML_BYTES + 1), URL_, publicKey), /max/);
  const env = h.encryptHtml(page(URL_), URL_, publicKey);
  assert.match(h.envelopeProblem({ ...env, ct: 'A'.repeat(h.MAX_CIPHERTEXT_B64 + 1) }), /max/);
});

test('htmlUrlProblem: matching canonical passes; missing or other canonical is refused', () => {
  assert.equal(h.htmlUrlProblem(page(URL_), URL_), null);
  assert.match(h.htmlUrlProblem(page(null), URL_), /no canonical/);
  assert.match(h.htmlUrlProblem(page('https://bachtrack.com/some-other-review'), URL_), /does not match/);
  assert.match(h.htmlUrlProblem('<html></html>', URL_), /under 500 bytes/);
});

test('actionProblem refuses bad fields; ingestArgs builds argv without a shell', () => {
  const a = h.buildAction({ showId: 'show-2026', url: URL_, outlet: 'bachtrack', critic: 'Susan Stempleski', publishDate: '2026-10-20', html: page(URL_), publicKeyPem: publicKey });
  assert.equal(h.actionProblem(a), null);
  assert.match(h.actionProblem({ ...a, showId: '../etc' }), /bad showId/);
  assert.match(h.actionProblem({ ...a, critic: 'x; rm -rf /' }), /bad critic/);
  assert.match(h.actionProblem({ ...a, url: 'file:///etc/passwd' }), /http/);
  assert.match(h.actionProblem({ ...a, publishDate: '20 Oct' }), /publishDate/);
  assert.deepEqual(h.ingestArgs(a, '/tmp/p.html'), [
    'scripts/ingest-review-from-url.js', '--show=show-2026', `--url=${URL_}`, '--html-file=/tmp/p.html',
    '--outlet=bachtrack', '--critic=Susan Stempleski', '--publish-date=2026-10-20',
  ]);
});

test('executeHandoff: decrypts to a temp file, runs ingest once, removes the file', () => {
  const a = h.buildAction({ showId: 'show-2026', url: URL_, html: page(URL_), publicKeyPem: publicKey });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-test-'));
  const calls = [];
  const res = h.executeHandoff(a, {
    privateKeyPem: privateKey, tmpDir,
    run: (args) => { const f = args.find((x) => x.startsWith('--html-file=')).slice(12); calls.push(fs.readFileSync(f, 'utf8')); },
  });
  assert.equal(res.ok, true, res.reason);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], page(URL_));
  assert.deepEqual(fs.readdirSync(tmpDir), []);
});

test('executeHandoff refuses without the key, on a wrong page, and reports an ingest failure', () => {
  const run = () => {};
  const good = h.buildAction({ showId: 'show-2026', url: URL_, html: page(URL_), publicKeyPem: publicKey });
  assert.match(h.executeHandoff(good, { run }).reason, /not set/);
  // A session could encrypt any page; CI re-checks the canonical after decrypting.
  const wrong = { ...good, html: h.encryptHtml(page('https://bachtrack.com/elsewhere'), URL_, publicKey) };
  let ran = false;
  assert.match(h.executeHandoff(wrong, { privateKeyPem: privateKey, run: () => { ran = true; } }).reason, /does not match/);
  assert.equal(ran, false);
  const failing = h.executeHandoff(good, { privateKeyPem: privateKey, run: () => { throw new Error('exit 3'); } });
  assert.equal(failing.ok, false);
  assert.match(failing.reason, /ingest failed/);
});

test('planHandoffProblems: key id must match the committed key, total size is capped', () => {
  const a = h.buildAction({ showId: 'show-2026', url: URL_, html: page(URL_), publicKeyPem: publicKey });
  assert.deepEqual(h.planHandoffProblems([a, { type: 'data-edit' }], { publicKeyPem: publicKey }), []);
  const other = h.generateKeyPair();
  assert.match(h.planHandoffProblems([a], { publicKeyPem: other.publicKey })[0], /committed key/);
  const big = { ...a, html: { ...a.html, ct: 'A'.repeat(h.MAX_CIPHERTEXT_B64) } };
  assert.match(h.planHandoffProblems([big, big]).join(' '), /split it/);
});

test('scrubAction drops the ciphertext and keeps a hash; other actions pass through', () => {
  const a = h.buildAction({ showId: 'show-2026', url: URL_, html: page(URL_), publicKeyPem: publicKey });
  const s = h.scrubAction(a);
  assert.equal(s.html.ct, undefined);
  assert.equal(s.html.kid, a.html.kid);
  assert.match(s.html.sha256, /^[0-9a-f]{64}$/);
  assert.equal(s.url, a.url);
  const other = { type: 'data-edit', x: 1 };
  assert.equal(h.scrubAction(other), other);
});

test('keygen plan: matching secret is a no-op, missing pem is re-derived, no secret mints a pair', () => {
  const { plan } = require('../html-handoff-keygen.js');
  assert.equal(plan({ existingPrivatePem: privateKey, committedPublicPem: publicKey }).action, 'none');
  const derived = plan({ existingPrivatePem: privateKey, committedPublicPem: null });
  assert.equal(derived.action, 'commit');
  assert.equal(h.keyId(derived.publicKeyPem), h.keyId(publicKey));
  assert.equal(derived.privateKeyPem, undefined);
  const fresh = plan({ existingPrivatePem: null, committedPublicPem: null });
  assert.equal(fresh.action, 'set-secret');
  assert.ok(fresh.privateKeyPem.includes('PRIVATE KEY'));
  assert.equal(plan({ existingPrivatePem: privateKey, committedPublicPem: publicKey, rotate: true }).action, 'set-secret');
});

test('review fixes: control chars in url refused, scrubbed actions skipped by plan checks, key taken from a file', () => {
  const a = h.buildAction({ showId: 'show-2026', url: URL_, html: page(URL_), publicKeyPem: publicKey });
  assert.match(h.actionProblem({ ...a, url: URL_ + '\n' }), /control/);
  assert.deepEqual(h.planHandoffProblems([h.scrubAction(a)], { publicKeyPem: h.generateKeyPair().publicKey }), []);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-key-'));
  const f = path.join(dir, 'k.pem');
  fs.writeFileSync(f, privateKey, { mode: 0o600 });
  const env = { HTML_HANDOFF_KEY_FILE: f, HTML_HANDOFF_PRIVATE_KEY: 'stale' };
  assert.equal(h.takePrivateKey(env), privateKey);
  assert.equal(fs.existsSync(f), false);
  assert.deepEqual(env, {});
  assert.equal(h.takePrivateKey({}), null);
});

test('shared plan checks: a handoff plan with no committed key fails, a stale kid fails, a good one passes', () => {
  const { handoffPlanProblems } = require('./pending-fix-plan-checks.js');
  const a = h.buildAction({ showId: 'show-2026', url: URL_, html: page(URL_), publicKeyPem: publicKey });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hh-pem-'));
  const pem = path.join(dir, 'pub.pem');
  assert.match(handoffPlanProblems('bro-1.json', [a], { publicKeyPath: pem })[0], /no committed public key/);
  fs.writeFileSync(pem, publicKey);
  assert.deepEqual(handoffPlanProblems('bro-1.json', [a], { publicKeyPath: pem }), []);
  fs.writeFileSync(pem, h.generateKeyPair().publicKey);
  assert.match(handoffPlanProblems('bro-1.json', [a], { publicKeyPath: pem })[0], /committed key/);
  assert.deepEqual(handoffPlanProblems('bro-1.json', [{ type: 'data-edit' }], { publicKeyPath: pem }), []);
});
