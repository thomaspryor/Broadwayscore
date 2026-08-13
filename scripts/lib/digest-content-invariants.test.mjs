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

test('real assembly path v3: zero buttons; every named row lands in the Automation queue', () => {
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
  // Digest v3 (owner mandate 2026-08-02): NO buttons — auto-dispatch replaced
  // them. The report block must exist instead.
  assert.equal(countFixThisButtons(html), 0);
  assert.ok(html.includes('Automation queue'));
});

test('real assembly path v3: zero errors, one warning -> reported in the autofix block, no button', () => {
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
  assert.ok(html.includes('Automation queue'));
});

test('real assembly path v3: no dispatch secret changes nothing — zero buttons either way, invariant passes', () => {
  const health = healthWith([{ name: 'Test Suite red', message: 'x' }]);
  const { subject, html } = composeDigestEmail({
    sections: { health }, now: NOW, dispatchSecret: null, dispatchConfigPath: NO_CONFIG_PATH,
  });
  const result = assertDigestInvariants(html, { health, subject });
  assert.deepEqual(result.violations, []);
  assert.equal(countFixThisButtons(html), 0);
});

test('real assembly path v3: the composed email contains ZERO dispatch action URLs', () => {
  const health = healthWith([
    { name: 'A', message: 'a' }, { name: 'B', message: 'b' }, { name: 'C', message: 'c' },
  ]);
  const { html } = composeDigestEmail({
    sections: { health }, now: NOW, dispatchSecret: SECRET, dispatchConfigPath: NO_CONFIG_PATH,
  });
  assert.equal(extractActionUrls(html).length, 0);
});

test('regression bait v3: reintroducing ANY Fix-this anchor turns the invariant red', () => {
  const html = '<div><a href="https://broadwayscorecard.com/api/autonomous-action?action=dispatch&sig='+ 'a'.repeat(64) +'">Fix this →</a></div>';
  const result = assertDigestInvariants(html, { health: null, subject: 'x' });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => /NO Fix-this buttons/.test(v)));
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

test('unit: catches a stray Fix-this button on a hand-built fixture', () => {
  const health = healthWith([{ name: 'A', message: 'a' }, { name: 'B', message: 'b' }]);
  const html = '<div>Fix needed: A</div><a>Fix this →</a>'; // only 1 button for 2 errors
  const result = assertDigestInvariants(html, { health });
  assert.equal(result.ok, false);
  assert.ok(result.violations.some(v => /NO Fix-this buttons/.test(v)));
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

test('real assembly path v3: nameless health rows never crash the render or the invariant', () => {
  const health = healthWith([{ name: 'A', message: 'a' }, { message: 'no name' }]);
  const { subject, html } = composeDigestEmail({ sections: { health }, now: NOW, dispatchSecret: SECRET, dispatchConfigPath: NO_CONFIG_PATH });
  const result = assertDigestInvariants(html, { health, subject });
  assert.deepEqual(result.violations, []);
  assert.equal(result.ok, true);
});

test('unit: verifySecret upgrades sig check to real HMAC verification on any action URL present', () => {
  // Composed v3 emails carry no action URLs, so this guard is exercised on a
  // fixture: if an action URL ever reappears, its sig must verify.
  const { buildDispatchUrl } = require('./dispatch-link.js');
  const url = buildDispatchUrl({ conditionKey: 'health-check:A', title: 'BSC Daily: A', exp: 1893456000, secret: SECRET, baseUrl: 'https://broadwayscorecard.com' });
  const html = `<a href="${url.replace(/&/g, '&amp;')}">view</a>`;
  const good = assertDigestInvariants(html, { verifySecret: SECRET });
  assert.ok(!good.violations.some(v => /does not verify/.test(v)));
  const bad = assertDigestInvariants(html, { verifySecret: 'wrong-secret' });
  assert.ok(bad.violations.some(v => /does not verify against the given secret/.test(v)));
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
