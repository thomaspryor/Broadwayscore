import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { evaluateSerpAcceptance: ev, longerQuotedWork } = require('./serp-review-acceptance.js');
const NY = 'https://www.newyorker.com/';

// The 6 URLs from run 36656521609 (BRO-4409): 3 bad adoptions, 3 correct.
test('rejects Wonder Woman 1984 film piece for show "1984" (title present)', () => {
  const r = ev({ url: NY + 'culture/culture-desk/does-wonder-woman-1984-hide-its-heros-true-superpowers', title: 'Does “Wonder Woman 1984” Hide Its Hero’s True Superpowers?', showTitle: '1984' });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^different-work/);
});

test('rejects Wonder Woman 1984 film piece even with no SERP title (numeric title needs stage signal)', () => {
  const r = ev({ url: NY + 'culture/culture-desk/does-wonder-woman-1984-hide-its-heros-true-superpowers', showTitle: '1984' });
  assert.equal(r.reason, 'numeric-title-without-stage-signal');
});

test("rejects New Yorker Radio Hour podcast page for Hell's Kitchen", () => {
  const r = ev({ url: NY + 'podcast/the-new-yorker-radio-hour/alicia-keys-returns-to-her-roots-with-her-new-musical-hells-kitchen', showTitle: "Hell's Kitchen" });
  assert.equal(r.ok, false);
  assert.match(r.reason, /^non-review-path/);
});

test('rejects New Yorker goings-on listings blurb for A Christmas Carol', () => {
  const r = ev({ url: NY + 'culture/goings-on/god-bless-a-christmas-carol-every-one', showTitle: 'A Christmas Carol' });
  assert.equal(r.reason, 'non-review-path:listings-blurb');
});

test('accepts Mean Girls New Yorker magazine review', () => {
  assert.equal(ev({ url: NY + 'magazine/2018/03/26/will-the-mean-girls-musical-make-fetch-happen', title: 'Will the “Mean Girls” Musical Make Fetch Happen?', showTitle: 'Mean Girls' }).ok, true);
});

test('accepts Washington Post Peter Marks Sunset Boulevard review', () => {
  assert.equal(ev({ url: 'https://www.washingtonpost.com/entertainment/theater/2017/11/16/sunset-boulevard-review/', showTitle: 'Sunset Boulevard' }).ok, true);
});

test('accepts combined Romeo + Juliet / Left on Tenth WaPo review for Left on Tenth', () => {
  assert.equal(ev({ url: 'https://www.washingtonpost.com/entertainment/theater/2024/10/24/romeo-juliet-left-tenth/', title: 'Review: Romeo + Juliet, Left on Tenth', showTitle: 'Left on Tenth' }).ok, true);
});

test('accepts a numeric-title stage review that carries a theatre signal', () => {
  assert.equal(ev({ url: NY + 'magazine/2017/07/03/1984-on-broadway', title: '“1984” on Broadway', showTitle: '1984' }).ok, true);
});

test('accepts WSJ "1984 review" slug where the number leads (numeric title, no theatre word)', () => {
  assert.equal(ev({ url: 'https://www.wsj.com/articles/1984-review-a-stunning-dystopia-on-our-telescreens-11585859139', showTitle: '1984' }).ok, true);
});

test('podcast outlets we ingest on purpose are exempt from the podcast path rule', () => {
  assert.equal(ev({ url: 'https://broadwaypodcastnetwork.com/podcasts/good-show/hungry-women-with-julia-lester/46', showTitle: 'Hungry Women' }).ok, true);
});

test('longerQuotedWork ignores an exact-title quote and stage words', () => {
  assert.equal(longerQuotedWork('Review: “Hamilton”', 'Hamilton'), null);
  assert.equal(longerQuotedWork('“Hamilton” the Musical', 'Hamilton'), null);
  assert.ok(longerQuotedWork('“Hamilton Mixtape” is out', 'Hamilton'));
});

test('classifyReviewUrl layer still applies (ticket seller)', () => {
  assert.equal(ev({ url: 'https://www.telecharge.com/Broadway/Hamilton', showTitle: 'Hamilton' }).ok, false);
});

test('BroadwayWorld own /article/BWW-Review-* pages are not treated as aggregator nav', () => {
  assert.equal(ev({ url: 'https://www.broadwayworld.com/article/BWW-Review-Lucy-Kirkwoods-Thoughtful-THE-CHILDREN-Comes-to-Broadway-20171213', showTitle: 'The Children' }).ok, true);
  assert.equal(ev({ url: 'https://forum.broadwayworld.com/thread/THE-INHERITANCE-Reviews', showTitle: 'The Inheritance' }).ok, false);
});

test('a long quoted editorial headline is not mistaken for a different work', () => {
  assert.equal(longerQuotedWork('Critic says “a truly dazzling and unforgettable night at Hamilton” tonight', 'Hamilton'), null);
});
