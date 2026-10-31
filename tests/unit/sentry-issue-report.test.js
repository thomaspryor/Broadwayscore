const { test } = require('node:test');
const assert = require('node:assert/strict');
const { safePath, safeText, summarizeEvent } = require('../../scripts/lib/sentry-report-format.js');

test('safePath drops query/hash and masks private share tokens', () => {
  assert.equal(safePath('https://broadwayscorecard.com/auth/callback#access_token=abc&x=1'), '/auth/callback');
  assert.equal(safePath('https://broadwayscorecard.com/plans/SECRET123?x=1'), '/plans/:token');
  assert.equal(safePath('/seen/SECRET/extra'), '/seen/:token/extra');
});

test('safeText redacts tokens and emails', () => {
  const t = safeText('failed for a@b.com with access_token=zzz123&y=1');
  assert.ok(!t.includes('a@b.com') && !t.includes('zzz123'), t);
  const j = safeText('bad token eyJhbGciOi.eyJzdWIiOiIx.SflKxwRJSM and Bearer abc.def');
  assert.ok(!j.includes('eyJhbGciOi') && !j.includes('abc.def'), j);
});

test('summarizeEvent shows crash frames, repeated recursion frames, no PII', () => {
  const frames = [];
  for (let i = 0; i < 30; i++) {
    frames.push({ function: i % 2 ? 'walk' : 'visit', filename: 'https://broadwayscorecard.com/_next/static/chunks/app.js', lineNo: 10 + (i % 2), colNo: 5, inApp: true });
  }
  const out = summarizeEvent({
    entries: [
      { type: 'exception', data: { values: [{ type: 'RangeError', value: 'Maximum call stack size exceeded.', stacktrace: { frames } }] } },
      { type: 'request', data: { url: 'https://broadwayscorecard.com/plans/SECRET?email=a@b.com' } },
      { type: 'breadcrumbs', data: { values: [{ category: 'ui.click', message: 'button.save a@b.com' }] } },
    ],
    tags: [{ key: 'browser', value: 'Mobile Safari 18' }, { key: 'ugc_op', value: 'auth.apple_sign_in' }],
    user: { id: '123', email: 'a@b.com', ip_address: '1.2.3.4' },
  });
  assert.match(out, /RangeError: Maximum call stack size exceeded/);
  assert.match(out, /most repeated frames/);
  assert.match(out, /x15 /);
  assert.match(out, /app\.js:10:5|app\.js:11:5/, 'camelCase lineNo/colNo must be read');
  assert.match(out, /page: \/plans\/:token/);
  assert.match(out, /Mobile Safari 18/);
  for (const leak of ['SECRET', 'a@b.com', '1.2.3.4']) assert.ok(!out.includes(leak), `leaked ${leak}`);
});

test('tokens in titles, messages and navigation breadcrumbs are masked', () => {
  const t = safeText('Failed to fetch https://broadwayscorecard.com/plans/SECRET?code=abc123&x=1');
  assert.ok(!t.includes('SECRET') && !t.includes('abc123'), t);
  const out = summarizeEvent({
    entries: [
      { type: 'exception', data: { values: [
        { type: 'Error', value: 'cause', stacktrace: { frames: [] } },
        { type: 'TypeError', value: 'thrown last', stacktrace: { frames: [] } },
      ] } },
      { type: 'breadcrumbs', data: { values: [{ category: 'navigation', data: { to: '/seen/TOK?email=a%40b.com' } }] } },
    ],
  });
  assert.ok(!out.includes('TOK') && !out.includes('a%40b.com'), out);
  assert.ok(out.indexOf('thrown last') < out.indexOf('cause'), 'thrown exception comes first');
});

test('summarizeEvent survives an event with no entries', () => {
  assert.doesNotThrow(() => summarizeEvent({}));
});
