// BRO-6487: British Theatre (britishtheatre.com) reviews live in <div id="article-body">; the site headline block above it,
// the author line, the newsletter box and related headlines below it must stay out of the body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { extractArticleText, extractBritishTheatreBody } = require('./article-extractor.js');

const P = [
  '"What kind of a musical is this??!" cries Little Sally. The good kind, and the evening never lets up for a second of it.',
  'Greg Kotis and Mark Hollmann have written a show that is intelligent, unique, funny, political and naughty all at once.',
  'The company throws itself at the material with real conviction, and the staging is sharp, quick and always inventive.',
];
const page = (inner, head = '<h1>REVIEW: Urinetown, Apollo Theatre</h1><p>Site headline block with other news about other productions in London.</p>') =>
  `<html><body>${head}<div class="x"><div class="min-w-0" id="article-body"><div class="inner">${inner}</div></div><aside><p>Unrelated sidebar paragraph about booking tickets for something else entirely.</p></aside></body></html>`;
const ps = (a) => a.map((t) => `<p>${t}</p>`).join('');

test('body paragraphs extracted; headline block, author line, newsletter and related are dropped', () => {
  const html = page(ps(P) + '<p>Emily Hardy is a contributor at British Theatre, covering West End productions and casting news.</p><p>Get the latest theatre news, reviews and exclusive offers straight to your inbox.</p><p>Oops! We couldn\'t add your email. Please check and try again.</p><p>London fringe venue closes after first production.</p>');
  const t = extractArticleText(html, 'britishtheatre.com');
  assert.ok(t && t.includes('Little Sally') && t.includes('staging is sharp'));
  assert.ok(!/Emily Hardy|Get the latest|Oops!|fringe venue|Site headline|sidebar/.test(t));
});

test('page without an article-body div: the dedicated extractor returns null so callers use the generic pass', () => {
  const html = '<html><body><article><p>' + P.join(' ') + '</p></article></body></html>';
  assert.equal(extractBritishTheatreBody(html), null);
});

test('too little prose inside article-body is not a body', () => {
  assert.equal(extractBritishTheatreBody(page('<p>Short teaser only about the show that goes nowhere much at all really.</p>')), null);
});

test('single-quoted id and nested divs inside article-body are handled', () => {
  const html = `<html><body><div id='article-body'><div><div>${ps(P)}</div></div></div><p>Outside paragraph that should never be part of the body at all.</p></body></html>`;
  const t = extractBritishTheatreBody(html);
  assert.ok(t && t.includes('Little Sally') && !t.includes('Outside paragraph'));
});
