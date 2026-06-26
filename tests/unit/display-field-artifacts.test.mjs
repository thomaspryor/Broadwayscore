/**
 * Save-time guards for [html-entity] + [jsonld-artifact] display-field artifacts.
 *
 * Detector/guard symmetry (CLAUDE.md §15): validate-data's CHECK 4/5 and the
 * review-file-writer save-time guard share hasJsonLdArtifact /
 * hasUndecodedHtmlEntities from text-cleaning.js. A value the detector flags must
 * be fully cleanable by the guard — so decodeHtmlEntities must cover every named
 * entity the detector regex lists (egrave/euml were previously missing).
 *
 * Run: node --test tests/unit/display-field-artifacts.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  decodeHtmlEntities,
  hasUndecodedHtmlEntities,
  hasJsonLdArtifact,
} = require('../../scripts/lib/text-cleaning.js');

test('hasUndecodedHtmlEntities flags named, smart-quote, and numeric entities', () => {
  assert.equal(hasUndecodedHtmlEntities('Daniel D&#8217;Addario'), true);
  assert.equal(hasUndecodedHtmlEntities('Nicky &amp; Rosie'), true);
  assert.equal(hasUndecodedHtmlEntities('caf&eacute;'), true);
  assert.equal(hasUndecodedHtmlEntities('M&egrave;re'), true);
  assert.equal(hasUndecodedHtmlEntities('Dom O&#x27;Hanlon'), true);
  // clean values + non-strings
  assert.equal(hasUndecodedHtmlEntities('Ben Brantley'), false);
  assert.equal(hasUndecodedHtmlEntities('Café'), false);
  assert.equal(hasUndecodedHtmlEntities(null), false);
  assert.equal(hasUndecodedHtmlEntities(undefined), false);
});

test('predicate flags EVERY entity the decoder handles (symmetry by construction)', () => {
  // hasUndecodedHtmlEntities is defined as "decode would change it", so any
  // entity added to the decoder is automatically flagged — including the
  // grave/circumflex/tilde set added alongside this guard.
  for (const e of ['agrave', 'egrave', 'igrave', 'ograve', 'ugrave', 'euml',
    'iuml', 'acirc', 'ecirc', 'icirc', 'ocirc', 'ucirc', 'atilde', 'otilde',
    'aring', 'oslash', 'aelig', 'szlig', 'eacute', 'amp', 'ldquo']) {
    assert.equal(hasUndecodedHtmlEntities(`x&${e};y`), true, `&${e}; not flagged`);
  }
  // bare ampersand / clean text → not flagged
  assert.equal(hasUndecodedHtmlEntities('Tom & Jerry'), false);
  assert.equal(hasUndecodedHtmlEntities('plain name'), false);
});

test('decoder fully cleans every named entity the detector flags (symmetry invariant)', () => {
  // Each entity in the detector list must decode to a non-entity value, i.e.
  // hasUndecodedHtmlEntities(decode(x)) === false for any single-entity input.
  const named = ['eacute', 'egrave', 'euml', 'oacute', 'uacute', 'iacute',
    'aacute', 'ntilde', 'ccedil', 'amp', 'quot', 'ldquo', 'rdquo', 'lsquo',
    'rsquo', 'mdash', 'ndash', 'hellip'];
  for (const e of named) {
    const decoded = decodeHtmlEntities(`x&${e};y`);
    assert.equal(hasUndecodedHtmlEntities(decoded), false, `&${e}; not fully decoded → "${decoded}"`);
  }
  // numeric forms too
  assert.equal(hasUndecodedHtmlEntities(decodeHtmlEntities('a&#8217;b')), false);
  assert.equal(hasUndecodedHtmlEntities(decodeHtmlEntities('a&#x27;b')), false);
});

test('decoder produces the correct characters for the real corpus cases', () => {
  assert.equal(decodeHtmlEntities('Daniel D&#8217;Addario'), 'Daniel D’Addario');
  assert.equal(decodeHtmlEntities('Nicky &amp; Rosie Chambers'), 'Nicky & Rosie Chambers');
  assert.equal(decodeHtmlEntities('Dom O&#x27;Hanlon'), "Dom O'Hanlon");
  assert.equal(decodeHtmlEntities('M&egrave;re'), 'Mère');
  assert.equal(decodeHtmlEntities('na&iuml;ve'), 'naïve');
});

test('hasJsonLdArtifact flags structured-data markers, not normal prose', () => {
  assert.equal(hasJsonLdArtifact('{"@type":"Review"}'), true);
  assert.equal(hasJsonLdArtifact('"@context":"https://schema.org"'), true);
  assert.equal(hasJsonLdArtifact('...reviewBody: great show'), true);
  assert.equal(hasJsonLdArtifact('itemReviewed something'), true);
  assert.equal(hasJsonLdArtifact('A genuinely moving production.'), false);
  assert.equal(hasJsonLdArtifact(null), false);
});

// ── Save-time guard wired into review-file-writer (end-to-end) ──
test('writer decodes entities and drops JSON-LD at save', () => {
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-disp-'));
  const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');

  const r = createOrMergeReviewFile('test-show-2026', {
    outlet: 'Variety', outletId: 'variety',
    criticName: 'Daniel D&#8217;Addario',
    url: 'https://variety.com/2026/legit/reviews/some-review-1234567890/',
    source: 'test',
    fields: { fullText: 'A real review body.', pullQuote: '{"@type":"Review","reviewBody":"x"}', excerpt: 'caf&eacute; society' },
  }, { reviewTextsDir: dir });

  const written = JSON.parse(fs.readFileSync(r.filepath, 'utf8'));
  assert.equal(written.criticName, 'Daniel D’Addario', 'criticName entity decoded');
  assert.equal(written.excerpt, 'café society', 'excerpt entity decoded');
  assert.equal(written.pullQuote, undefined, 'JSON-LD pullQuote dropped');
  assert.ok(!hasUndecodedHtmlEntities(written.criticName));
});

test('merge replaces a stored JSON-LD pullQuote with a clean incoming one (no data loss)', () => {
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfw-merge-'));
  const { createOrMergeReviewFile } = require('../../scripts/lib/review-file-writer.js');
  const base = { outlet: 'Variety', outletId: 'variety', criticName: 'Jane Critic',
    url: 'https://variety.com/2026/legit/reviews/x-1234509876/', source: 'test' };

  // First write lands a JSON-LD pullQuote (simulating an earlier bad scrape).
  createOrMergeReviewFile('merge-show-2026', { ...base, fields: { fullText: 'body', pullQuote: '{"@type":"Review","reviewBody":"junk"}' } }, { reviewTextsDir: dir });
  // Second write (merge) brings a clean pullQuote — it must win, not be blocked.
  const r2 = createOrMergeReviewFile('merge-show-2026', { ...base, fields: { pullQuote: 'A genuinely great show.' } }, { reviewTextsDir: dir });

  const written = JSON.parse(fs.readFileSync(r2.filepath, 'utf8'));
  assert.equal(written.pullQuote, 'A genuinely great show.', 'clean incoming pullQuote replaced the JSON-LD blob');
});
