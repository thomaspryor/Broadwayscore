/**
 * Byline capture: curly apostrophes and trailing suffixes — audit S7-T4 (BRO-4204).
 *
 * The inline "By Name" regex in scripts/lib/byline-extraction.js rejected the
 * curly apostrophe (’) and its entity forms, so "Holly O’Mahony" captured as
 * "Holly O"; and every capture path kept what rode along with the name —
 * ", Chief Theatre Critic", "(she/her)", "<br>" — minting a second critic
 * page per artifact. The real functions are required (§15).
 *
 * Run: node --test tests/unit/byline-capture-suffixes.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { extractByline } = require('../../scripts/lib/byline-extraction.js');
const { normalizeBylineCapture, stripBylineSuffixes } = require('../../scripts/lib/byline-normalization.js');

test('inline "By Name" capture accepts the curly apostrophe and its entity forms', () => {
  assert.equal(extractByline('<h1>Title</h1><p>By Holly O’Mahony <br>Some text</p>'), 'Holly O’Mahony');
  assert.equal(extractByline('<h1>Title</h1><p>By Holly O&#8217;Mahony <br>Some text</p>'), 'Holly O’Mahony');
  // &rsquo; decodes to the straight apostrophe (decodeEntities), still whole.
  assert.equal(extractByline('<h1>Title</h1><p>By Holly O&rsquo;Mahony <br>Some text</p>'), "Holly O'Mahony");
  assert.equal(extractByline("<h1>Title</h1><p>By Holly O'Mahony <br>Some text</p>"), "Holly O'Mahony");
});

test('trailing ", Chief Theatre Critic" is stripped at capture', () => {
  assert.equal(extractByline('<meta name="author" content="Dominic Cavendish, Chief Theatre Critic">'), 'Dominic Cavendish');
  assert.equal(extractByline('<span class="byline">By Dominic Cavendish, Chief Theatre Critic</span>'), 'Dominic Cavendish');
});

test('trailing "(she/her)" is stripped at capture', () => {
  assert.equal(extractByline('<meta name="author" content="Sarah Crompton (she/her)">'), 'Sarah Crompton');
  assert.equal(extractByline('<a rel="author" href="/authors/sarah">Sarah Crompton (she/her)</a>'), 'Sarah Crompton');
});

test('trailing <br> / stray ">" is stripped at capture', () => {
  assert.equal(extractByline('<span class="byline">Michael Sommers<br></span>'), 'Michael Sommers');
  assert.equal(extractByline('<p class="byline">By Michael Sommers<br/></p>'), 'Michael Sommers');
  assert.equal(extractByline('<meta name="author" content="Michael Sommers>">'), 'Michael Sommers');
  // The pre-existing shape still works.
  assert.equal(extractByline('<span class="byline">Michael Sommers</span>'), 'Michael Sommers');
});

test('stripBylineSuffixes: the audit artifacts, on the exact strings', () => {
  assert.equal(stripBylineSuffixes('Dominic Cavendish, Chief Theatre Critic'), 'Dominic Cavendish');
  assert.equal(stripBylineSuffixes('Sarah Crompton (she/her)'), 'Sarah Crompton');
  assert.equal(stripBylineSuffixes('Michael Sommers<br>'), 'Michael Sommers');
  assert.equal(stripBylineSuffixes('Michael Sommers>'), 'Michael Sommers');
  assert.equal(stripBylineSuffixes('Holly O’Mahony'), 'Holly O’Mahony');
  // Stacked and varied forms.
  assert.equal(stripBylineSuffixes('Sarah Crompton (she/her), Theatre Critic'), 'Sarah Crompton');
  assert.equal(stripBylineSuffixes('Jane Doe [they/them]'), 'Jane Doe');
  assert.equal(stripBylineSuffixes('Jane Doe she/her'), 'Jane Doe');
  assert.equal(stripBylineSuffixes('Jane Doe, Editor-in-Chief'), 'Jane Doe');
  assert.equal(stripBylineSuffixes('Jane Doe - Theatre Critic at Large'), 'Jane Doe');
  assert.equal(stripBylineSuffixes('Jane Doe | Senior Arts Editor'), 'Jane Doe');
  assert.equal(stripBylineSuffixes('Jane Doe (Theatre Critic)'), 'Jane Doe');
});

test('stripBylineSuffixes never touches the name itself', () => {
  assert.equal(stripBylineSuffixes('Chief Editor'), 'Chief Editor');           // no separator → not a suffix
  assert.equal(stripBylineSuffixes('Jane Doe, Chris Host'), 'Jane Doe, Chris Host'); // co-byline, not a title
  assert.equal(stripBylineSuffixes('Rob Weinert-Kendt'), 'Rob Weinert-Kendt');
  assert.equal(stripBylineSuffixes('Jane Doe (UK)'), 'Jane Doe (UK)');
  assert.equal(stripBylineSuffixes("Sara O'Brien"), "Sara O'Brien");
  assert.equal(stripBylineSuffixes(''), '');
  assert.equal(stripBylineSuffixes(null), null);
  assert.equal(stripBylineSuffixes(undefined), undefined);
  // Idempotent.
  assert.equal(stripBylineSuffixes(stripBylineSuffixes('Dominic Cavendish, Chief Theatre Critic')), 'Dominic Cavendish');
});

test('normalizeBylineCapture applies the same suffix rules (one implementation, wired)', () => {
  assert.equal(normalizeBylineCapture('Dominic Cavendish, Chief Theatre Critic'), 'Dominic Cavendish');
  assert.equal(normalizeBylineCapture('Sarah Crompton (she/her)'), 'Sarah Crompton');
  assert.equal(normalizeBylineCapture('Michael Sommers<br>'), 'Michael Sommers');
  assert.equal(normalizeBylineCapture('Michael Sommers>'), 'Michael Sommers');
  assert.equal(normalizeBylineCapture('Holly O’Mahony'), 'Holly O’Mahony');
  // Existing guarantees hold.
  assert.equal(normalizeBylineCapture('Chief Editor'), 'Chief Editor');
  assert.equal(normalizeBylineCapture('Senior Editor Jane Doe'), 'Jane Doe');
  assert.equal(normalizeBylineCapture('ELYSA GARDNER'), 'Elysa Gardner');
  assert.equal(normalizeBylineCapture('Frank Rizzo\n\nPlus Icon'), 'Frank Rizzo');
});
