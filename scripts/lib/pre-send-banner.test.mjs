// Round-trip guard for the pre-send banner (task #746): the banner that
// pre-send-check.mjs injects MUST be exactly what create-broadcast-draft.mjs
// strips before PATCHing a subscriber draft. If build and strip ever drift,
// this fails loudly instead of a warning banner silently reaching subscribers
// (the 2026-08-02 incident).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { buildPreSendBanner, stripPreSendBanner } = require_('./pre-send-banner.js');

const PAGE = '<body style="margin:0"><div style="background:#1a1a24">real content <ul><li>x</li></ul></div></body>';

test('strip removes exactly what build injected (round trip)', () => {
  const banner = buildPreSendBanner(['Subject too long: 90 chars', 'Lede contains em dash']);
  const injected = PAGE.replace(/(<body[^>]*>)/, `$1${banner}`);
  const res = stripPreSendBanner(injected);
  assert.equal(res.stripped, true);
  assert.equal(res.html, PAGE);
});

test('banner with nested <ul>/<li> strips fully — no orphan markup', () => {
  const banner = buildPreSendBanner(['a', 'b', 'c']);
  const res = stripPreSendBanner('<body>' + banner + '<p>after</p></body>');
  assert.ok(!res.html.includes('7c2d12'));
  assert.ok(!res.html.includes('PRE-SEND ISSUES'));
  assert.ok(res.html.includes('<p>after</p>'));
});

test('no banner present is a no-op', () => {
  const res = stripPreSendBanner(PAGE);
  assert.equal(res.stripped, false);
  assert.equal(res.html, PAGE);
});

test('banner markup contains no nested div (strip regex invariant)', () => {
  const inner = buildPreSendBanner(['x']).replace(/^\s*<div[^>]*>/, '');
  assert.ok(!inner.includes('<div'), 'nested <div> would truncate the non-greedy strip regex');
});
