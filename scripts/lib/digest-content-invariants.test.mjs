import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { assertDigestInvariants, extractActionUrls, countFixThisButtons } = require('./digest-content-invariants.js');
const { composeDigestEmail } = require('../send-morning-digest.js');

const NOW = new Date('2026-07-30T11:30:00Z');
const SECRET = 'test-hmac-secret-not-real';
// A path that never exists on disk — composeDigestEmail's JSON.parse read
// fails and falls back to {}, so baseUrl defaults to the real prod host
// exactly like a live run with no override configured.
const NO_CONFIG_PATH = '/nonexistent/digest-content-invariants-test-config.json';

function healthWith(errors, warns = []) {
  return { generatedAt: NOW.toISOString(), errors, warns, queued: [] };
}

test('real assembly path: N health errors -> N Fix-this buttons, all invariants pass', () => {
  const health = healthWith([
    { name: 'Test Suite red', message: 'unit tests failing on main' },
    { name: 'Deploy stuck', message: 'vercel-deploy.yml has not run in 12h' },
  ], [{ name: 'SEO: LCP elevated' }]);

  const { subject, html } = composeDigestEmail({
    sections: { health },
    now: NOW,
    dispatchSecret: SECRET,
    dispatchConfigPath: NO_CONFIG_PATH,
  });

  const result = assertDigestInvariants(html, { health, subject });
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
  assert.equal(countFixThisButtons(html), 2);
});

test('real assembly path: zero errors -> zero Fix-this buttons, still passes', () => {
  const health = healthWith([], [{ name: 'SEO: LCP elevated' }]);
  const { subject, html } = composeDigestEmail({
    sections: { health },
    now: NOW,
    dispatchSecret: SECRET,
    dispatchConfigPath: NO_CONFIG_PATH,
  });
  const result = assertDigestInvariants(html, { health, subject });
  assert.deepEqual(result.violations, []);
  assert.equal(countFixThisButtons(html), 0);
});

test('real assembly path: no dispatch secret -> no buttons attached, but errors still render (fail-soft, not fail-invisible)', () => {
  const health = healthWith([{ name: 'Test Suite red', message: 'x' }]);
  const { html } = composeDigestEmail({
    sections: { health },
    now: NOW,
    dispatchSecret: null,
    dispatchConfigPath: NO_CONFIG_PATH,
  });
  // No secret -> no fixUrl -> no button. This is the ONE state where the
  // count invariant is expected to legitimately mismatch (0 buttons for 1
  // error) — assertDigestInvariants still flags it, which is correct: the
  // owner should know a fix-worthy morning shipped without a tappable link.
  const result = assertDigestInvariants(html, { health });
  assert.equal(result.ok, false);
  assert.match(result.violations[0], /expected 1 "Fix this" button/);
});

test('real assembly path: every action URL is https, correct host, 64-hex sig', () => {
  const health = healthWith([
    { name: 'A', message: 'a' }, { name: 'B', message: 'b' }, { name: 'C', message: 'c' },
  ]);
  const { html } = composeDigestEmail({
    sections: { health }, now: NOW, dispatchSecret: SECRET, dispatchConfigPath: NO_CONFIG_PATH,
  });
  const urls = extractActionUrls(html);
  assert.equal(urls.length, 3);
  for (const url of urls) {
    const u = new URL(url);
    assert.equal(u.protocol, 'https:');
    assert.equal(u.hostname, 'broadwayscorecard.com');
    assert.match(u.searchParams.get('sig'), /^[0-9a-f]{64}$/);
  }
});

test('regression bait: deleting the attachHealthFixUrls call would make this RED (proves the test can see the #634 class)', () => {
  // This test does not itself delete the line — see the card's acceptance
  // criteria for the manual RED/GREEN proof — but it pins the contract that
  // makes that deletion visible: composeDigestEmail (the real function
  // main() calls) must be the one producing the buttons, not a fixture the
  // test hand-assembles.
  const health = healthWith([{ name: 'X', message: 'x' }]);
  const { html } = composeDigestEmail({
    sections: { health }, now: NOW, dispatchSecret: SECRET, dispatchConfigPath: NO_CONFIG_PATH,
  });
  assert.equal(countFixThisButtons(html), 1);
  assert.ok(health.errors[0].fixUrl, 'attachHealthFixUrls must have mutated health.errors[0].fixUrl in place');
});

test('subject invariant: non-empty and under 120 chars on the real assembled subject', () => {
  const health = healthWith([{ name: 'X', message: 'x' }], [{ name: 'Y' }]);
  const { subject } = composeDigestEmail({
    sections: { health }, now: NOW, dispatchSecret: SECRET, dispatchConfigPath: NO_CONFIG_PATH,
  });
  const result = assertDigestInvariants('<div>placeholder</div>', { subject });
  assert.deepEqual(result.violations, []);
  assert.ok(subject.length > 0 && subject.length < 120);
});

test('unit: catches a mismatched button count on a hand-built fixture', () => {
  const health = healthWith([{ name: 'A', message: 'a' }, { name: 'B', message: 'b' }]);
  const html = '<div>Fix needed: A</div><a>Fix this →</a>'; // only 1 button for 2 errors
  const result = assertDigestInvariants(html, { health });
  assert.equal(result.ok, false);
  assert.match(result.violations[0], /expected 2 .* found 1/);
});

test('unit: catches a non-https or wrong-host action URL', () => {
  const badHost = '<a href="https://evil.example.com/api/autonomous-action?action=dispatch&sig=' + 'a'.repeat(64) + '">Fix this →</a>';
  const r1 = assertDigestInvariants(badHost, {});
  assert.equal(r1.ok, false);
  assert.match(r1.violations.join(' '), /expected "broadwayscorecard\.com"/);

  const badProtocol = '<a href="http://broadwayscorecard.com/api/autonomous-action?action=dispatch&sig=' + 'a'.repeat(64) + '">Fix this →</a>';
  const r2 = assertDigestInvariants(badProtocol, {});
  assert.equal(r2.ok, false);
  assert.match(r2.violations.join(' '), /not https/);
});

test('unit: catches an invalid (non-64-hex) sig', () => {
  const html = '<a href="https://broadwayscorecard.com/api/autonomous-action?action=dispatch&sig=short">Fix this →</a>';
  const result = assertDigestInvariants(html, {});
  assert.equal(result.ok, false);
  assert.match(result.violations.join(' '), /missing\/invalid 64-hex sig/);
});

test('unit: catches unrendered template artifacts (undefined/NaN text node, [object Object])', () => {
  assert.equal(assertDigestInvariants('<div>undefined</div>', {}).ok, false);
  assert.equal(assertDigestInvariants('<div>NaN</div>', {}).ok, false);
  assert.equal(assertDigestInvariants('<div>[object Object]</div>', {}).ok, false);
  // Sentence containing the word "undefined" as prose must NOT false-positive.
  assert.equal(assertDigestInvariants('<div>Property foo is undefined in prod.</div>', {}).ok, true);
});

test('real assembly path: nameless health error is not counted against the button total (matches attachHealthFixUrls own skip)', () => {
  const health = healthWith([{ name: 'A', message: 'a' }, { message: 'no name, skipped by attachHealthFixUrls' }]);
  const { html } = composeDigestEmail({
    sections: { health }, now: NOW, dispatchSecret: SECRET, dispatchConfigPath: NO_CONFIG_PATH,
  });
  assert.equal(countFixThisButtons(html), 1);
  const result = assertDigestInvariants(html, { health });
  assert.deepEqual(result.violations, []);
});

test('real assembly path: verifySecret upgrades sig check to real HMAC verification — wrong secret fails, right secret passes', () => {
  const health = healthWith([{ name: 'A', message: 'a' }]);
  const { html } = composeDigestEmail({
    sections: { health }, now: NOW, dispatchSecret: SECRET, dispatchConfigPath: NO_CONFIG_PATH,
  });
  const good = assertDigestInvariants(html, { health, verifySecret: SECRET });
  assert.deepEqual(good.violations, []);

  const bad = assertDigestInvariants(html, { health, verifySecret: 'wrong-secret' });
  assert.equal(bad.ok, false);
  assert.match(bad.violations.join(' '), /does not verify against the given secret/);
});

test('unit: countFixThisButtons requires an actual anchor, not bare prose containing the phrase', () => {
  assert.equal(countFixThisButtons('<p>You should Fix this issue yourself.</p>'), 0);
  assert.equal(countFixThisButtons('<a href="https://x">Fix this →</a>'), 1);
});

test('unit: subject empty or too long fails', () => {
  assert.equal(assertDigestInvariants('<div>x</div>', { subject: '' }).ok, false);
  assert.equal(assertDigestInvariants('<div>x</div>', { subject: 'x'.repeat(120) }).ok, false);
  assert.equal(assertDigestInvariants('<div>x</div>', { subject: 'x'.repeat(119) }).ok, true);
});
