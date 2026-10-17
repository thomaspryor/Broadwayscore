/**
 * BRO-4977: a BWW roundup entry that reviews another show whose title contains
 * this one ("How Soon is Now?" in the Soon roundup) must not become a review of
 * this show. Cases below are real headlines from the archived roundups, run
 * through the real detector and the real extractBWWRoundupReviews.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { detectForeignTitlePosting, headlineSubjectTitle } = require('./bww-foreign-title.js');
const { extractBWWRoundupReviews } = require('../gather-reviews.js');

describe('detectForeignTitlePosting', () => {
  const foreign = [
    ['Soon', 'The Stage - How Soon is Now? review', 'https://www.thestage.co.uk/reviews/how-soon-is-now-review'],
    ['Cinderella: Buttons Undone!', "New York Theatre Guide - 'Bad Cinderella' review — fairytale reinvention only goes skin-deep",
      'https://www.newyorktheatreguide.com/reviews/bad-cinderella-broadway-review-andrew-lloyd-webber'],
    ['Mean Girls', 'New York Theater - School Girls, or the African Mean Girls Play Broadway Review',
      'https://newyorktheater.me/2026/09/28/school-girls-or-the-african-mean-girls-play-broadway-review/'],
  ];
  for (const [title, headline, url] of foreign) {
    test(`flags "${headline}" on ${title}`, () => {
      const r = detectForeignTitlePosting({ headline, url }, title);
      assert.ok(r, 'expected a foreign-title verdict');
      assert.ok(r.extraWords.length > 0);
    });
  }

  // Same show, decorated: none of these may be dropped.
  const same = [
    ['Soon', "New York Theatre Guide - 'Soon' Off-Broadway review — when the end of life meets the beginning of love",
      'https://www.newyorktheatreguide.com/reviews/soon-off-broadway-review'],
    ['Old Friends', "New York Theatre Guide - 'Stephen Sondheim's Old Friends' Broadway review — ebullient show",
      'https://www.newyorktheatreguide.com/reviews/stephen-sondheims-old-friends-broadway-review-bernadette-peters-lea-salonga'],
    ['Old Friends', 'New York Theater - Sondheim’s Old Friends Broadway Review',
      'https://newyorktheater.me/2025/04/08/sondheims-old-friends-broadway-review/'],
    ['Evita', 'WhatsOnStage - Evita with Rachel Zegler review – high-flying, adored and awe-inspiring',
      'https://www.whatsonstage.com/news/evita-with-rachel-zegler-review-high-flying-adored-and-awe-inspiring_1685107/'],
    ['Hello, Dolly!', 'The Arts Desk - Hello, Dolly!, London Palladium review - Imelda Staunton makes every line a deal-breaker',
      'https://theartsdesk.com/theatre/hello-dolly-london-palladium-review-imelda-staunton-makes-every-line-deal-breaker'],
    ['Thelma & Louise: A New Musical', 'Theatre and Tonic - Thelma and Louise at the Young Vic Review',
      'https://theatreandtonic.co.uk/blog/thelma-and-louise-at-the-young-vic-review'],
    // "Review: X ..." runs on into a sentence; never judged.
    ['Prima Facie', "The Daily Beast - Review: Jodie Comer Makes 'Prima Facie' Broadway's Most Powerful Show",
      'https://www.thedailybeast.com/review-jodie-comer-makes-prima-facie-broadways-most-powerful-show'],
    // Creative headline with no title in it: no signal.
    ['Soon', 'One-Minute Critic - What would you do with a few months left? Nick Blaemire’s ‘Soon’ has a theory',
      'https://1minutecritic.com/soon-nick-blaemire-musical-review/'],
  ];
  for (const [title, headline, url] of same) {
    test(`keeps "${headline}" on ${title}`, () => {
      assert.strictEqual(detectForeignTitlePosting({ headline, url }, title), null);
    });
  }

  test('the url must agree with the headline', () => {
    const r = detectForeignTitlePosting(
      { headline: 'The Stage - How Soon is Now? review', url: 'https://www.thestage.co.uk/reviews/soon-review' }, 'Soon');
    assert.strictEqual(r, null);
  });

  test('headlineSubjectTitle reads only "<X> review" headlines', () => {
    assert.strictEqual(headlineSubjectTitle('The Stage - How Soon is Now? review'), 'How Soon is Now');
    assert.strictEqual(headlineSubjectTitle('Exeunt - Review: Bughouse at the Vineyard Theatre'), null);
  });
});

describe('extractBWWRoundupReviews drops the foreign-title entry', () => {
  test('Soon roundup keeps NYTG and drops The Stage "How Soon is Now?"', () => {
    const ld = {
      '@type': 'LiveBlogPosting',
      liveBlogUpdate: [
        { '@type': 'BlogPosting', headline: 'The Stage - How Soon is Now? review',
          articleBody: 'Nostalgia will only carry you so far. What this piece needs is a substantial story, but Owen gives us little insight.',
          url: 'https://www.thestage.co.uk/reviews/how-soon-is-now-review', author: { '@type': 'Person', name: 'Matt Barton' } },
        { '@type': 'BlogPosting', headline: "New York Theatre Guide - 'Soon' Off-Broadway review — when the end of life meets the beginning of love",
          articleBody: 'Blaemire hasn’t drawn these characters with much depth.',
          url: 'https://www.newyorktheatreguide.com/reviews/soon-off-broadway-review', author: { '@type': 'Person', name: 'Joe Dziemianowicz' } },
      ],
    };
    const html = `<html><body><script type="application/ld+json">${JSON.stringify(ld)}</script></body></html>`;
    const reviews = extractBWWRoundupReviews(html, 'soon-off-broadway-2026', 'https://www.broadwayworld.com/article/Review-Roundup-Soon', 'Soon');
    const outlets = reviews.map(r => r.outletId);
    assert.ok(!outlets.includes('thestage'), `The Stage must be dropped, got ${outlets.join(',')}`);
    // Outlet/critic resolution of the kept entry is not this guard's concern;
    // only that the real Soon review survives.
    assert.strictEqual(reviews.length, 1, `the Soon review must be kept, got ${JSON.stringify(reviews.map(r => [r.outletId, r.criticName]))}`);
    assert.ok(reviews.every(r => !r._foreignTitle));
  });
});

describe('foreignTitleEntriesFromHtml / isForeignTitleReview (other roundup parsers, LLM merge)', () => {
  const { foreignTitleEntriesFromHtml, isForeignTitleReview } = require('./bww-foreign-title.js');
  const ld = { '@type': 'LiveBlogPosting', liveBlogUpdate: [
    { '@type': 'BlogPosting', headline: 'The Stage - How Soon is Now? review', url: 'https://www.thestage.co.uk/reviews/how-soon-is-now-review',
      articleBody: 'Nostalgia will only carry you so far. What this piece needs is a substantial story, but Owen gives us little insight.' },
    { '@type': 'BlogPosting', headline: "New York Theatre Guide - 'Soon' Off-Broadway review", url: 'https://www.newyorktheatreguide.com/reviews/soon-off-broadway-review',
      articleBody: 'Blaemire hasn’t drawn these characters with much depth.' },
  ] };
  const entries = foreignTitleEntriesFromHtml(`<script type="application/ld+json">${JSON.stringify(ld)}</script>`, 'Soon');

  test('finds only the foreign posting', () => {
    assert.deepStrictEqual(entries.map(e => e.subjectTitle), ['How Soon is Now']);
  });
  test('matches a parsed review by url (www/trailing slash ignored) or by excerpt', () => {
    assert.ok(isForeignTitleReview({ url: 'https://thestage.co.uk/reviews/how-soon-is-now-review/' }, entries));
    assert.ok(isForeignTitleReview({ url: null, bwwExcerpt: 'Nostalgia will only carry you so far. What this piece needs...' }, entries));
    assert.ok(!isForeignTitleReview({ url: 'https://www.newyorktheatreguide.com/reviews/soon-off-broadway-review' }, entries));
    assert.ok(!isForeignTitleReview({ url: null, bwwExcerpt: 'Blaemire hasn’t drawn these characters with much depth.' }, entries));
  });
  test('apostrophe titles are matched ("Hell\'s Kitchen")', () => {
    const r = detectForeignTitlePosting({ headline: 'X - Hell’s Kitchen Reprise review', url: 'https://x.com/hells-kitchen-reprise-review' }, "Hell's Kitchen");
    assert.ok(r);
    assert.strictEqual(detectForeignTitlePosting({ headline: 'X - Hell’s Kitchen review', url: 'https://x.com/hells-kitchen-review' }, "Hell's Kitchen"), null);
  });
  test('a part/edition suffix is not another show', () => {
    assert.strictEqual(detectForeignTitlePosting({ headline: 'X - Harry Potter and the Cursed Child Parts One and Two review',
      url: 'https://x.com/harry-potter-and-the-cursed-child-parts-one-and-two-review' }, 'Harry Potter and the Cursed Child'), null);
  });
});
