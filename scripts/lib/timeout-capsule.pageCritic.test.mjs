import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { classifyTimeoutPage } = createRequire(import.meta.url)('./timeout-capsule.js');

const page = (by) => `<html><body><p>Time Out says</p><p>The Unbelievers: Theater review by ${by} Lauren Ambrose plays a mother whose son has vanished.</p></body></html>`;

test('wrong critic on a real review page exposes the page byline (BRO-7041)', () => {
  const r = classifyTimeoutPage({ html: withMeta('Billy McEntee', 'Billy McEntee'), critic: 'Adam Feldman', showYear: 2026 });
  assert.equal(r.verdict, 'wrong_critic');
  assert.equal(r.pageCritic, 'Billy McEntee');
});

test('matching critic stays a review', () => {
  assert.equal(classifyTimeoutPage({ html: page('Adam Feldman'), critic: 'Adam Feldman', showYear: 2026 }).verdict, 'review');
});

const withMeta = (author, by) => `<html><head><meta name="author" content="${author}"/></head>` + page(by).slice(6);

test('multi-word and punctuated bylines use the meta author, never a two-word guess', () => {
  const a = classifyTimeoutPage({ html: withMeta('Mary Kate Smith', 'Mary Kate Smith'), critic: 'Adam Feldman', showYear: 2026 });
  assert.equal(a.pageCritic, 'Mary Kate Smith');
  const b = classifyTimeoutPage({ html: withMeta('Billy McEntee', 'Billy McEntee.'), critic: 'Adam Feldman', showYear: 2026 });
  assert.equal(b.pageCritic, 'Billy McEntee');
});

test('no meta author, or one that disagrees with the printed byline: no re-credit', () => {
  assert.equal(classifyTimeoutPage({ html: page('Billy McEntee'), critic: 'Adam Feldman', showYear: 2026 }).pageCritic, null);
  assert.equal(classifyTimeoutPage({ html: withMeta('Someone Else', 'Billy McEntee'), critic: 'Adam Feldman', showYear: 2026 }).pageCritic, null);
});
