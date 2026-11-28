import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const cq = require('../../scripts/lib/content-quality.js');

// BRO-7477: therecs.co.uk signs posts "The Recs <initials> - <Full Name>" in the
// author meta and JSON-LD; the whole string failed validation so 47 Recs reviews
// landed as "Unknown".
const URL = 'https://therecs.co.uk/traitorz-the-unauthorized-musical-parody/';
const page = (author) => `<html><head><meta name="author" content="${author}" />
<script type="application/ld+json">{"@graph":[{"@type":"Article","author":{"name":"${author}","@id":"x"}}]}</script></head><body><p>Review.</p></body></html>`;

test('meta author "The Recs RDC - Randall David Cook" resolves to the critic', () => {
  assert.equal(cq.extractAuthorFromHtml(page('The Recs RDC - Randall David Cook'), 'Review.', { url: URL }), 'Randall David Cook');
});

test('other initials and an en dash work', () => {
  assert.equal(cq.extractAuthorFromHtml(page('The Recs EM – Erin Muldoon'), 'Review.', { url: URL }), 'Erin Muldoon');
});

test('apostrophe in the name is kept whole', () => {
  const html = `<meta name="author" content="The Recs SO - Sean O'Brien">`;
  assert.equal(cq.extractAuthorFromHtml(html, '', { url: URL }), "Sean O'Brien");
});

test('JSON-LD only (no meta) still resolves', () => {
  const html = '<html><script>{"author":{"name":"The Recs NB - Nicola Berry"}}</script></html>';
  assert.equal(cq.extractTheRecsByline(html).name, 'Nicola Berry');
});

test('outletId alone (no URL) triggers the override', () => {
  assert.equal(cq.extractAuthorFromHtml(page('The Recs RDC - Randall David Cook'), '', { outletId: 'the-recs' }), 'Randall David Cook');
});

test('bare initials signature with no name yields no critic', () => {
  assert.equal(cq.extractAuthorFromHtml(page('The Recs IT'), 'Review.', { url: URL }), null);
});

test('a word in place of initials is not treated as a signature', () => {
  assert.equal(cq.extractTheRecsByline(page('The Recs Team - Theatre Desk')).name, null);
});

test('bare signature still lets an in-page Reviewer: line win', () => {
  const html = page('The Recs IT').replace('<p>Review.</p>', '<p>Reviewer: Jane Smith</p>');
  assert.equal(cq.extractAuthorFromHtml(html, 'Reviewer: Jane Smith', { url: URL }), 'Jane Smith');
});

test('callers with no url/outletId get the name, never the raw signature', () => {
  assert.equal(cq.extractAuthorFromHtml(page('The Recs RDC - Randall David Cook')), 'Randall David Cook');
  assert.equal(cq.extractAuthorFromHtml('<meta name="author" content="The Recs IT">'), null);
});
