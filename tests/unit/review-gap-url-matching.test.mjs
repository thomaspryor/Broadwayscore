/**
 * Unit tests for urlMatchesShow / titleTokens in scripts/audit-show-review-gap.js
 *
 * Regression for girl-interrupted 2026-06-06: the gap audit matched a "Weather
 * Girl" review to "Girl, Interrupted" on the shared "girl" token alone, which the
 * auto-onboard would then have ingested as a wrong-show review. Short titles now
 * require ALL title tokens to match; longer titles tolerate one missing token.
 *
 * Run: node --test tests/unit/review-gap-url-matching.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { urlMatchesShow, titleTokens, freshnessMsFor, namesLongerShowTitle } = require('../../scripts/audit-show-review-gap.js');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('freshnessMsFor — checkpoint re-audit cadence', () => {
  it('open shows are re-checked within hours (new reviews keep landing)', () => {
    assert.ok(freshnessMsFor({ status: 'open' }, { gaps: 0 }) <= 24 * HOUR);
  });
  it('a clean closed show is effectively one-time (~yearly)', () => {
    assert.strictEqual(freshnessMsFor({ status: 'closed' }, { gaps: 0 }), 365 * DAY);
  });
  it('a closed show that still had gaps is retried sooner', () => {
    const ms = freshnessMsFor({ status: 'closed' }, { gaps: 2 });
    assert.ok(ms < 365 * DAY && ms >= 7 * DAY, `expected a short retry window, got ${ms / DAY}d`);
  });
  it('never-audited handled by caller (no lastEntry) — returns a finite window', () => {
    assert.ok(Number.isFinite(freshnessMsFor({ status: 'closed' }, null)));
  });
});

describe('titleTokens', () => {
  it('drops stopwords and short tokens', () => {
    assert.deepStrictEqual(titleTokens('Girl, Interrupted'), ['girl', 'interrupted']);
    assert.deepStrictEqual(titleTokens('A Woman Among Women'), ['woman', 'among', 'women']);
  });
});

describe('urlMatchesShow — short title requires ALL tokens', () => {
  const gi = titleTokens('Girl, Interrupted'); // [girl, interrupted]

  it('accepts a real Girl, Interrupted review URL (both tokens present)', () => {
    assert.ok(urlMatchesShow('https://www.nytimes.com/2026/06/04/theater/girl-interrupted-review-mann.html', gi));
    assert.ok(urlMatchesShow('https://culturesauce.com/girl-interrupted-musical-aimee-mann/', gi));
  });

  it('REJECTS a Weather Girl review (only the shared "girl" token)', () => {
    assert.strictEqual(
      urlMatchesShow('https://lavocedinewyork.com/en/new-york/2025/09/22/weather-girl-a-dark-comedy/', gi),
      false
    );
    assert.strictEqual(
      urlMatchesShow('https://playbill.com/article/what-do-the-critics-think-of-weather-girl-off-broadway', gi),
      false
    );
  });
});

describe('urlMatchesShow — longer title tolerates one missing token', () => {
  const awaw = titleTokens('A Woman Among Women'); // [woman, among, women]

  it('accepts the real A Woman Among Women slug (all tokens)', () => {
    assert.ok(urlMatchesShow('https://www.broadwayworld.com/article/Review-Roundup-A-WOMAN-AMONG-WOMEN-at-Lincoln-Center-Theater-20260605', awaw));
  });

  it('accepts a slug missing exactly one token', () => {
    // "woman" + "women" present, "among" dropped → 2 of 3 → still matches
    assert.ok(urlMatchesShow('https://example.com/a-woman-and-the-women-review/', awaw));
  });

  it('rejects a slug sharing only one token', () => {
    assert.strictEqual(urlMatchesShow('https://example.com/the-woman-in-black-review/', awaw), false);
  });
});

describe('urlMatchesShow — guards', () => {
  it('accepts everything when there are no tokens', () => {
    assert.ok(urlMatchesShow('https://example.com/anything', []));
  });
  it('rejects malformed URLs', () => {
    assert.strictEqual(urlMatchesShow('not a url', ['girl', 'interrupted']), false);
  });
});

// BRO-6640: "Other" (Greenwich House 2025) took in Playbill's Verdict for
// "The Other Americans" and every review it linked.
it('namesLongerShowTitle: a short title rejects slugs naming a longer tracked title', () => {
  const shows = [
    { id: 'other-off-broadway-2025', title: 'Other' },
    { id: 'the-other-americans-off-broadway-2025', title: 'The Other Americans' },
    { id: 'other-desert-cities-2011', title: 'Other Desert Cities' },
  ];
  const other = shows[0];
  assert.equal(namesLongerShowTitle('https://www.vulture.com/article/the-other-americans-leguizamo-review.html', other, shows), true);
  assert.equal(namesLongerShowTitle('https://playbill.com/article/reviews-what-do-the-critics-think-of-other-desert-cities-on-broadway', other, shows), true);
  assert.equal(namesLongerShowTitle('https://www.nytimes.com/2025/10/20/theater/other-review-greenwich-house.html', other, shows), false);
  const juliet = [{ id: 'and-juliet-tour-2024', title: '& Juliet' }, { id: 'romeo-and-juliet-2024', title: 'Romeo and Juliet' }];
  assert.equal(namesLongerShowTitle('https://www.pilotonline.com/2025/12/04/review-and-juliet-romeo/', juliet[0], juliet), false);
  assert.equal(namesLongerShowTitle('https://nypost.com/2024/10/24/entertainment/romeo-juliet-review-kit-connor/', juliet[0], juliet), true);
  // the longer show keeps its own reviews
  assert.equal(namesLongerShowTitle('https://www.vulture.com/article/the-other-americans-leguizamo-review.html', shows[1], shows), false);
});
