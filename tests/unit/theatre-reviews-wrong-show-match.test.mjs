/**
 * BRO-4828: theatre.reviews roundup discovery must require every show-title
 * word. The Hungry Ghost matched The Hunger Games On Stage through (a) the
 * WP-API fallback taking the first /reviews-roundup/ hit and (b) the homepage
 * scan comparing the first 8 characters of the title ("the hung").
 * Real functions only; no network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { pickTheatreReviewsRoundupFromAnchors } = require('../../scripts/lib/theatre-reviews-discovery.js');
const { discoverTrRoundupHtml } = require('../../scripts/lib/tr-roundup-discover.js');

const HG = '/reviews-roundup/the-hunger-games-on-stage-reviews/';
const show = { id: 'the-hungry-ghost-off-west-end-2026', title: 'The Hungry Ghost', venue: 'Somewhere', openingDate: '2026-10-01' };

describe('homepage anchor pick', () => {
  test('wrong show sharing an 8-char prefix is rejected', () => {
    assert.strictEqual(pickTheatreReviewsRoundupFromAnchors([{ href: HG, text: 'The Hunger Games On Stage' }], 'The Hungry Ghost'), null);
  });
  test('right show is found, relative href made absolute', () => {
    const got = pickTheatreReviewsRoundupFromAnchors(
      [{ href: HG, text: 'The Hunger Games On Stage' }, { href: '/reviews-roundup/the-hungry-ghost-reviews/', text: 'The Hungry Ghost' }],
      'The Hungry Ghost');
    assert.strictEqual(got, 'https://theatre.reviews/reviews-roundup/the-hungry-ghost-reviews/');
  });
});

describe('discoverTrRoundupHtml WP-API fallback', () => {
  const run = async (posts) => {
    const fetched = [];
    const res = await discoverTrRoundupHtml(show, {
      log: () => {},
      fetchPage: async (u) => { fetched.push(u); throw new Error('404'); },
      fetchJSON: async () => posts,
    });
    return { res, fetched };
  };
  test('a stemmed-search hit for another show is never fetched or returned', async () => {
    const { res, fetched } = await run([{ link: `https://theatre.reviews${HG}`, title: { rendered: 'The Hunger Games On Stage' }, slug: 'the-hunger-games-on-stage-reviews' }]);
    assert.strictEqual(res, null);
    assert.ok(!fetched.some(u => u.includes('hunger-games')), fetched.join(','));
  });
});

// BRO-6968: verifyAggregatorUrl is token-based, so a page that names the show passed even when
// its round-up is already matched to another show ("The Bridge" → the Bridge Theatre's Into the
// Woods). The coverage claim ledger must veto it on every caller (gap audit, poller, lane).
describe('discoverTrRoundupHtml claim check', () => {
  const URL_ = 'https://theatre.reviews/reviews-roundup/the-hungry-ghost-reviews/';
  const html = `<html><head><title>The Hungry Ghost reviews</title><link rel="canonical" href="${URL_}"></head><body>`
    + '<h1>The Hungry Ghost - Reviews Roundup</h1>'
    + Array.from({ length: 30 }, (_, i) => `<p>Critic ${i} on The Hungry Ghost at Somewhere: ⭑⭑⭑⭑ a fine evening.</p>`).join('')
    + '</body></html>';
  const run = (trClaims) => discoverTrRoundupHtml(show, {
    log: () => {},
    trClaims,
    fetchPage: async (u) => (u === URL_ ? { content: html } : Promise.reject(new Error('404'))),
    fetchJSON: async () => [{ link: URL_, title: { rendered: 'The Hungry Ghost' }, slug: 'the-hungry-ghost-reviews' }],
  });
  test('a round-up claimed by another show is rejected', async () => {
    assert.strictEqual(await run([{ showId: 'other-show-2026', url: URL_ }]), null);
  });
  test('a round-up claimed by this show (or nobody) is returned', async () => {
    assert.strictEqual((await run([{ showId: show.id, url: URL_ }]))?.url, URL_);
    assert.strictEqual((await run([]))?.url, URL_);
  });
});
