import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { applyUtm } = require('./email-utm.js');

const opts = { source: 'newsletter', campaign: 'weekly-2026-05-30' };
// Output is entity-escaped (&amp;) to stay valid HTML and match escapeHtml() in templates.
const Q = 'utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=weekly-2026-05-30';

test('tags a plain first-party content link', () => {
  const out = applyUtm('<a href="https://broadwayscorecard.com/show/giant">x</a>', opts);
  assert.equal(out, `<a href="https://broadwayscorecard.com/show/giant?${Q}">x</a>`);
});

test('inserts UTMs BEFORE the #fragment', () => {
  const out = applyUtm('<a href="https://broadwayscorecard.com/tony-awards/predictions/2025-2026#best-musical">x</a>', opts);
  assert.equal(out, `<a href="https://broadwayscorecard.com/tony-awards/predictions/2025-2026?${Q}#best-musical">x</a>`);
});

test('merges with an existing query string', () => {
  const out = applyUtm('<a href="https://broadwayscorecard.com/x?ref=email">x</a>', opts);
  assert.ok(out.includes('ref=email'));
  assert.ok(out.includes('utm_source=newsletter'));
});

test('decodes &amp;-escaped multi-param query before parsing (no junk amp; param)', () => {
  const out = applyUtm('<a href="https://broadwayscorecard.com/x?a=1&amp;b=2">x</a>', opts);
  // Exact output: original a/b params preserved, &amp; separators throughout,
  // and crucially NOT a corrupted `amp;b` param (which raw new URL() would emit).
  assert.equal(out, `<a href="https://broadwayscorecard.com/x?a=1&amp;b=2&amp;${Q}">x</a>`);
});

test('skips a link already tagged with &amp;-escaped utm_source', () => {
  const html = '<a href="https://broadwayscorecard.com/x?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=other">x</a>';
  assert.equal(applyUtm(html, opts), html);
});

test('tolerates whitespace around href=', () => {
  const out = applyUtm('<a href = "https://broadwayscorecard.com/x">x</a>', opts);
  assert.ok(out.includes('utm_source=newsletter'));
});

test('does NOT match data-href / x-href (href= is a substring)', () => {
  const html = '<div data-href="https://broadwayscorecard.com/x">z</div>';
  assert.equal(applyUtm(html, opts), html, 'data-href must be left untouched');
  // ...but a real href elsewhere in the same string still gets tagged
  const mixed = '<div data-href="https://broadwayscorecard.com/x"><a href="https://broadwayscorecard.com/y">y</a></div>';
  const out = applyUtm(mixed, opts);
  assert.ok(out.includes('data-href="https://broadwayscorecard.com/x"'), 'data-href untouched');
  assert.ok(out.includes('/y?utm_source=newsletter'), 'real href tagged');
});

test('is idempotent — running twice equals running once', () => {
  const html = '<a href="https://broadwayscorecard.com/show/giant">x</a><a href="https://broadwayscorecard.com/about">y</a>';
  const once = applyUtm(html, opts);
  const twice = applyUtm(once, opts);
  assert.equal(twice, once);
});

test('does not tag links already carrying utm_source (inline edits)', () => {
  const html = '<a href="https://broadwayscorecard.com/x?utm_source=newsletter&utm_medium=email&utm_campaign=other">x</a>';
  assert.equal(applyUtm(html, opts), html);
});

test('skips unsubscribe / unfollow / api links', () => {
  for (const url of [
    'https://broadwayscorecard.com/unsubscribe?email=a@b.com',
    'https://broadwayscorecard.com/unfollow?email=a@b.com&show=giant',
    'https://broadwayscorecard.com/api/unsubscribe?email=a@b.com',
  ]) {
    const html = `<a href="${url}">x</a>`;
    assert.equal(applyUtm(html, opts), html, `should skip ${url}`);
  }
});

test('skips the Resend unsubscribe merge token', () => {
  const html = '<a href="{{{RESEND_UNSUBSCRIBE_URL}}}">unsubscribe</a>';
  assert.equal(applyUtm(html, opts), html);
});

test('skips external hosts (social, fonts, github)', () => {
  for (const url of [
    'https://instagram.com/bwayscorecard',
    'https://x.com/BwayScorecard',
    'https://fonts.googleapis.com/css2?family=Inter',
    'https://github.com/thomaspryor/Broadwayscore/issues/1',
  ]) {
    const html = `<a href="${url}">x</a>`;
    assert.equal(applyUtm(html, opts), html, `should skip ${url}`);
  }
});

test('handles single-quoted href', () => {
  const out = applyUtm("<a href='https://broadwayscorecard.com/x'>x</a>", opts);
  assert.equal(out, `<a href='https://broadwayscorecard.com/x?${Q}'>x</a>`);
});

test('tags every content link in a realistic multi-link email', () => {
  const html = [
    '<a href="https://broadwayscorecard.com">logo</a>',
    '<a href="https://broadwayscorecard.com/show/giant">Giant</a>',
    '<a href="https://broadwayscorecard.com/about">About</a>',
    '<a href="https://broadwayscorecard.com/unsubscribe?email=a@b.com">unsub</a>',
    '<a href="https://instagram.com/bwayscorecard">ig</a>',
  ].join('');
  const out = applyUtm(html, opts);
  // 3 content links tagged, unsubscribe + social untouched
  assert.equal((out.match(/utm_source=newsletter/g) || []).length, 3);
  assert.ok(out.includes('/unsubscribe?email=a@b.com">'));
  assert.ok(out.includes('instagram.com/bwayscorecard">'));
});

test('throws when source or campaign missing', () => {
  assert.throws(() => applyUtm('<a href="x">y</a>', { source: 'newsletter' }));
  assert.throws(() => applyUtm('<a href="x">y</a>', { campaign: 'c' }));
});
