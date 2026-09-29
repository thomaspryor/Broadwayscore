/**
 * Critic-name phantom outlets from BWW roundups whose headline outlet was not
 * yet registered (mrs-doubtfire-tour-2025: "ben-ryland" next to
 * media-mikes/Ben Ryland; see scripts/lib/bww-critic-name-phantoms.js).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { dropCriticNamePhantoms } = require('./bww-critic-name-phantoms.js');
const { extractBWWRoundupReviews } = require('../gather-reviews.js');

describe('dropCriticNamePhantoms', () => {
  test('drops a no-critic record whose outletId is another record\'s critic slug, handing its excerpt to the twin', () => {
    const phantom = { outletId: 'ben-ryland', criticName: null, bwwExcerpt: 'padded second act', bwwThumb: 'Meh' };
    const twin = { outletId: 'media-mikes', criticName: 'Ben Ryland', url: 'https://mediamikes.com/x' };
    const { kept, dropped } = dropCriticNamePhantoms([phantom, twin]);
    assert.deepEqual(kept.map((r) => r.outletId), ['media-mikes']);
    assert.equal(dropped.length, 1);
    assert.equal(twin.bwwExcerpt, 'padded second act');
    assert.equal(twin.bwwThumb, 'Meh');
  });

  test('matches accented names and "Unknown" critics', () => {
    const { kept } = dropCriticNamePhantoms([
      { outletId: 'jose-nunez', criticName: 'Unknown' },
      { outletId: 'some-blog', criticName: 'José Núñez' },
    ]);
    assert.deepEqual(kept.map((r) => r.outletId), ['some-blog']);
  });

  test('keeps a real outlet with no critic when nobody\'s name slugs to it', () => {
    const input = [
      { outletId: 'broadwaynews', criticName: null },
      { outletId: 'folsom-times', criticName: 'Bill Sullivan' },
    ];
    assert.equal(dropCriticNamePhantoms(input).kept.length, 2);
  });

  test('keeps a record that has its own critic even if the outletId matches a name', () => {
    const input = [
      { outletId: 'ben-ryland', criticName: 'Ben Ryland' },
      { outletId: 'media-mikes', criticName: 'Ben Ryland' },
    ];
    assert.equal(dropCriticNamePhantoms(input).kept.length, 2);
  });
});

describe('dropCriticNamePhantoms keeps real outlets named after a critic', () => {
  const twin = () => ({ outletId: 'blogcritics', criticName: 'Carole Di Tosti' });
  test('a registered outlet with a domain (critic\'s own site) is kept', () => {
    const own = { outletId: 'carole-di-tosti', criticName: null };
    const { kept } = dropCriticNamePhantoms([own, twin()], { hasDomain: (id) => id === 'carole-di-tosti' });
    assert.equal(kept.length, 2);
  });
  test('a record with its own URL is kept', () => {
    const own = { outletId: 'carole-di-tosti', criticName: null, url: 'https://caroleditosti.com/x' };
    assert.equal(dropCriticNamePhantoms([own, twin()]).kept.length, 2);
  });
});

describe('extractBWWRoundupReviews: unregistered headline outlet + bare author name', () => {
  test('does not emit the critic name as an outlet when the articleBody names the real outlet', () => {
    const ld = {
      '@type': 'LiveBlogPosting',
      articleBody: '',
      liveBlogUpdate: [
        {
          '@type': 'BlogPosting',
          headline: 'Zzq Unregistered Weekly - Theater Review: Mrs. Doubtfire',
          articleBody: 'The musical captures most of the plot of the film.',
          author: { '@type': 'Person', name: 'Qqz Phantomcritic' },
        },
      ],
    };
    const html = `<html><body><script type="application/ld+json">${JSON.stringify(ld)}</script></body></html>`;
    const reviews = extractBWWRoundupReviews(html, 'mrs-doubtfire-tour-2025', 'https://www.broadwayworld.com/article/x');
    // Alone (no twin), the record is kept — that is the pre-existing
    // guard-rail behaviour; the drop only fires when a twin exists.
    const withTwin = dropCriticNamePhantoms([
      ...reviews,
      { outletId: 'zzq-unregistered-weekly', criticName: 'Qqz Phantomcritic' },
    ]).kept;
    assert.ok(!withTwin.some((r) => r.outletId === 'qqz-phantomcritic'),
      `critic-name phantom survived: ${JSON.stringify(withTwin.map((r) => [r.outletId, r.criticName]))}`);
  });
});
