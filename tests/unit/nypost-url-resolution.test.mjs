// BRO-2482 acceptance suite for the legacy redirect trust rule shipped in BRO-3501.
// Exercises the real verifier offline, including pairs from the mismatch audit.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { verifyFetchedUrl } = require('../../scripts/lib/scraper');

const metadata = {
  canonical: (url) => `<link rel="canonical" href="${url}">`,
  'og:url': (url) => `<meta property="og:url" content="${url}">`,
};

describe('NYPost legacy shortener URL resolution', () => {
  const accepted = [
    ['https://www.nypost.com/p/entertainment/theater/joy_ride_amid_fast_cash_and_cooked_NQ2MT1kCQRngnL5nqTTTyO', 'https://nypost.com/2010/04/28/joy-ride-amid-fast-cash-and-cooked-books/'],
    ['http://www.nypost.com/p/entertainment/theater/gotta_hand_it_to_him_cJlBeSaMypuz5p4VnveXuM', 'https://nypost.com/2010/03/05/christopher-walken-the-best-part-of-a-behanding-in/'],
    ['http://www.nypost.com/p/entertainment/theater/green_with_frenzy_OYSVpKug8AOrKr86TGVZaL#ixzz0lkcuhoGS', 'https://nypost.com/2010/04/21/green-with-frenzy/'],
    ['http://www.nypost.com/p/entertainment/theater/plenty_of_afro_heat_kQGx3P1vFBYrLx0bbPQ1VK?utm=x', 'https://nypost.com/2009/11/24/plenty-of-afro-heat/'],
    ['http://www.nypost.com/p/entertainment/theater/reviews/no_winner_in_race_D8xYC0dU0DypH9J4BmvJ3L', 'https://nypost.com/2010/12/07/no-winner-in-race/'],
    ['https://nypost.com/p/entertainment/trwrewqqw_AbCdEfGhIjKlMnOpQrStUv', 'https://nypost.com/2013/04/05/youll-get-a-kick-out-of-kinky-boots/'],
  ];
  const legacy = accepted[1][0];
  const dated = accepted[1][1];
  const rejected = [
    ['legacy -> homepage', legacy, 'https://nypost.com/'],
    ['legacy -> section', legacy, 'https://nypost.com/entertainment/'],
    ['legacy -> contributor content', legacy, 'https://nypost.com/contributor-content/some-ad/'],
    ['legacy -> lowercased /p/ 404 path', legacy, 'https://nypost.com/p/entertainment/theater/gotta_hand_it_to_him_cjlbesamypuz5p4vnvexum'],
    ['modern -> different dated article', 'https://nypost.com/2024/04/25/entertainment/the-great-gatsby-review/', 'https://nypost.com/2024/04/26/entertainment/other-show-review/'],
    ['modern -> contributor content', 'https://nypost.com/2024/04/25/entertainment/the-great-gatsby-review/', 'https://nypost.com/contributor-content/x/'],
    ['other host with /p/ path', legacy.replace('nypost.com', 'example.com'), dated.replace('nypost.com', 'example.com')],
    ['legacy -> unrelated host', legacy, dated.replace('nypost.com', 'example.com')],
    ['lookalike host with /p/ path', legacy.replace('nypost.com', 'nypost.com.example.org'), dated.replace('nypost.com', 'nypost.com.example.org')],
    ['unrelated /p/ category', legacy.replace('/entertainment/', '/news/'), dated],
    ['missing /p/ prefix', legacy.replace('/p/', '/'), dated],
    ['id too short', 'http://www.nypost.com/p/entertainment/theater/foo_cJlBeSaMypuz5p4Vnve', dated],
    ['id too long', `${legacy}X`, dated],
    ['extra path segment', `${legacy}/other`, dated],
    ['non-dated article', legacy, 'https://nypost.com/christopher-walken-the-best-part-of-a-behanding-in/'],
  ];

  for (const [tag, html] of Object.entries(metadata)) {
    describe(tag, () => {
      for (const [requested, actual] of accepted) {
        test(`verifies ${requested}`, () => {
          assert.deepEqual(verifyFetchedUrl(html(actual), requested), {
            verified: true, reason: 'legacy_id_redirect',
          });
        });
      }
      for (const [name, requested, actual] of rejected) {
        test(`rejects ${name}`, () => {
          assert.deepEqual(verifyFetchedUrl(html(actual), requested), {
            verified: false, reason: 'url_mismatch', actual,
          });
        });
      }
    });
  }
});
