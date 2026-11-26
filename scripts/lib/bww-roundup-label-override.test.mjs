// BRO-8224: BWW roundups (my-fair-lady-2018, saint-joan-2018, summer-2018)
// label New York Stage Review critics "New York Theatre Review", which
// resolves to the blog newyorktheatrereview. The URL host or the critic
// decides. Per CLAUDE.md rule 15 this require()s the real functions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { roundupLabelOverride } = require('./bww-roundup-parser.js');

const L = 'newyorktheatrereview';

test('NYTR label over an NYSR URL is nysr', () => {
  assert.equal(roundupLabelOverride({ outletId: L, url: 'http://nystagereview.com/2018/04/25/saint-joan-shaws-other-fair-lady-grounded-and-soaring/', criticName: 'Elysa Gardner' }), 'nysr');
  assert.equal(roundupLabelOverride({ outletId: L, url: 'https://www.newyorkstagereview.com/x/' }), 'nysr');
});

test('NYTR label over the blog URL stays the blog', () => {
  assert.equal(roundupLabelOverride({ outletId: L, url: 'https://newyorktheatrereview.blogspot.com/2026/09/x.html', criticName: 'Elysa Gardner' }), null);
});

test('NYTR label over some other host is left alone', () => {
  assert.equal(roundupLabelOverride({ outletId: L, url: 'https://medium.com/x', criticName: 'Jesse Oxfeld' }), null);
});

test('no URL: an NYSR critic moves to nysr, anyone else stays', () => {
  assert.equal(roundupLabelOverride({ outletId: L, criticName: 'Jesse Oxfeld' }), 'nysr');
  assert.equal(roundupLabelOverride({ outletId: L, criticName: 'Steven Suskin' }), 'nysr');
  assert.equal(roundupLabelOverride({ outletId: L, criticName: 'Jane Doe' }), null);
  assert.equal(roundupLabelOverride({ outletId: L }), null);
});

test('other outlets are never touched', () => {
  assert.equal(roundupLabelOverride({ outletId: 'nysr', url: 'http://nystagereview.com/x' }), null);
  assert.equal(roundupLabelOverride({ outletId: 'nytimes', url: 'http://nystagereview.com/x', criticName: 'Elysa Gardner' }), null);
  assert.equal(roundupLabelOverride({ outletId: null }), null);
});

test('extractBWWRoundupReviews files the mislabelled entry under nysr, no duplicate stub', () => {
  const { extractBWWRoundupReviews } = require('../gather-reviews.js');
  const href = 'http://nystagereview.com/2018/04/25/saint-joan-shaws-other-fair-lady-grounded-and-soaring/';
  const quote = 'Condola Rashad, who assumes the role in Manhattan Theatre Club\'s stirring new Broadway revival of Saint Joan, exudes a very different kind of purity.';
  const body = `Ben Brantley, The New York Times: The production of Saint Joan falls a bit short of its promise tonight. Elysa Gardner, New York Theatre Review: ${quote}`;
  const ld = { '@type': 'NewsArticle', articleBody: body, datePublished: '2018-04-26' };
  const html = `<html><body><script type="application/ld+json">${JSON.stringify(ld)}</script>`
    + `<p>Elysa Gardner, <a href="${href}" target="_blank">New York Theatre Review</a>: ${quote}</p></body></html>`;
  const log = console.log; console.log = () => {};
  let reviews;
  try { reviews = extractBWWRoundupReviews(html, 'saint-joan-2018', 'https://www.broadwayworld.com/article/x', 'Saint Joan'); }
  finally { console.log = log; }
  const gardner = reviews.filter((r) => r.criticName === 'Elysa Gardner');
  assert.equal(gardner.length, 1);
  assert.equal(gardner[0].outletId, 'nysr');
  assert.equal(gardner[0].outlet, 'New York Stage Review');
  assert.equal(reviews.filter((r) => r.outletId === L).length, 0);
  assert.equal(reviews.filter((r) => r.outletId === 'nysr').length, 1, 'no Unknown domain-supplement duplicate');
});
