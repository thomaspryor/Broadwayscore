/**
 * BRO-4357 / BRO-3936: BWW roundup Method 1 must not mint an outlet from
 *  - a comma list of 3+ people (WYPR radio segment host + guests), or
 *  - a bare person name the excerpt merely mentions (evita-2012 cast members).
 * Real functions only (CLAUDE.md section 15); synthetic HTML, no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { extractBWWRoundupReviews } = require('../../scripts/gather-reviews.js');
const { isMultiPersonOutlet, isMentionedPersonOutlet } = require('../../scripts/lib/bww-jsonld-author.js');
const never = () => false;

function makeLiveBlogHtml(postings) {
  const ld = {
    '@type': 'LiveBlogPosting',
    articleBody: postings.map(p => p.text || '').join('\n\n'),
    liveBlogUpdate: postings.map(p => {
      const entry = {
        '@type': 'BlogPosting',
        headline: p.headline,
        articleBody: p.text || p.headline,
      };
      if (p.author) entry.author = { '@type': 'Person', name: p.author };
      return entry;
    }),
  };
  return `<html><body><script type="application/ld+json">${JSON.stringify(ld)}</script></body></html>`;
}

const URL_ = 'https://www.broadwayworld.com/article/Review-Roundup-TEST-20251001';

describe('isMultiPersonOutlet', () => {
  test('host + guests list is rejected', () => {
    assert.strictEqual(isMultiPersonOutlet('J. Wynn Rousuck, Tom Hall, Sam Bermas-Dawes, Rob Sivak', never), true);
  });
  test('two names, a registered outlet, or a plain outlet name are kept', () => {
    assert.strictEqual(isMultiPersonOutlet('Tom Hall, Rob Sivak', never), false);
    assert.strictEqual(isMultiPersonOutlet('Theater Pizzazz', never), false);
    assert.strictEqual(isMultiPersonOutlet('A B, C D, E F', () => true), false);
  });
});

describe('isMentionedPersonOutlet', () => {
  const excerpt = 'Mr. Brantley writes that Ricky Martin brings charm to Che.';
  test('person mentioned mid-excerpt with no critic is rejected', () => {
    assert.strictEqual(isMentionedPersonOutlet('Ricky Martin', null, excerpt, never), true);
  });
  test('kept when a critic exists, when absent from excerpt, or when registered', () => {
    assert.strictEqual(isMentionedPersonOutlet('Ricky Martin', 'Ben Brantley', excerpt, never), false);
    assert.strictEqual(isMentionedPersonOutlet('Jon Sobel', null, excerpt, never), false);
    assert.strictEqual(isMentionedPersonOutlet('Ricky Martin', null, excerpt, () => true), false);
  });
  test('substring of a longer word is not a mention', () => {
    assert.strictEqual(isMentionedPersonOutlet('Ricky Martin', null, 'xx Ricky Martinez sings', never), false);
  });
});

describe('extractBWWRoundupReviews drops the phantom slots', () => {
  test('multi-person author posting yields no review', () => {
    const html = makeLiveBlogHtml([
      { author: 'J. Wynn Rousuck, Tom Hall, Sam Bermas-Dawes, Rob Sivak', headline: 'Midday segment on the show', text: 'Rousuck reviews the tour.' },
    ]);
    const reviews = extractBWWRoundupReviews(html, 'water-for-elephants-tour-2025', URL_);
    assert.ok(!reviews.some(r => /rousuck-tom-hall/.test(r.outletId)), JSON.stringify(reviews.map(r => r.outletId)));
  });
  test('person mentioned in excerpt yields no review', () => {
    const html = makeLiveBlogHtml([
      { author: 'Ricky Martin', headline: 'Evita on Broadway', text: 'The staging is lush, and Ricky Martin is a charmer as Che.' },
    ]);
    const reviews = extractBWWRoundupReviews(html, 'evita-2012', URL_);
    assert.ok(!reviews.some(r => r.outletId === 'ricky-martin'), JSON.stringify(reviews.map(r => r.outletId)));
  });
});
