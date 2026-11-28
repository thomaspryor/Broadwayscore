/**
 * Show Score profile parser — pure-function tests over synthesized fixtures.
 * The parser feeds the show-score-proxy edge function (user-facing import),
 * so a silent regression here means users import wrong ratings or 0 reviews.
 *
 * Fixtures are synthesized (not dumps of a real member's page) to keep user
 * content out of the repo. Attribute casing matches the live raw HTML
 * (camelCase), which the browser DOM lowercases — the parser must accept both.
 *
 * Run: node --test tests/unit/show-score-profile-parser.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseProfileHtml,
  parsePageCount,
  scoreToRating,
  venueHintIsMarket,
  cleanVenueHint,
  decodeEntities,
} from '../../supabase/functions/show-score-proxy/parser.mjs';

const tile = (attrs) => {
  const s = Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ');
  return `<review-show-summary class="review-show-summary" ${s}></review-show-summary>`;
};

describe('parseProfileHtml', () => {
  it('parses camelCase raw-HTML attributes (live-site casing)', () => {
    const html = `<title>Show Score | Tom 300271</title>
      <div class="member-detail-section-title">98 Reviews</div>` +
      tile({ reviewId: '896525', comment: 'Loopy silly original fun. Worth seeing', showtimeDate: '2026-04-03', score: '80.0', showtitle: 'Burnout Paradise (Astor Place Theatre)' });
    const p = parseProfileHtml(html);
    assert.strictEqual(p.displayName, 'Tom 300271');
    assert.strictEqual(p.totalOnProfile, 98);
    assert.strictEqual(p.reviews.length, 1);
    const r = p.reviews[0];
    assert.strictEqual(r.title, 'Burnout Paradise');
    assert.strictEqual(r.venueHint, 'Astor Place Theatre');
    assert.strictEqual(r.rating, 4);
    assert.strictEqual(r.sourceScore, 80);
    assert.strictEqual(r.dateSeen, '2026-04-03');
    assert.strictEqual(r.reviewText, 'Loopy silly original fun. Worth seeing');
  });

  it('parses lowercased attributes (browser-DOM casing) identically', () => {
    const p = parseProfileHtml(tile({ reviewid: '1', score: '90', showtitle: 'Hamilton (Broadway)', showtimedate: '2025-01-15' }));
    assert.strictEqual(p.reviews[0].rating, 4.5);
    assert.strictEqual(p.reviews[0].venueHint, 'Broadway');
    assert.strictEqual(p.reviews[0].dateSeen, '2025-01-15');
  });

  it('decodes entity-encoded values (quotes, emoji JSON, ampersands)', () => {
    const p = parseProfileHtml(tile({
      score: '100',
      showtitle: 'Rodgers &amp; Hammerstein&#39;s Cinderella',
      comment: 'She said &quot;wow&quot; &amp; cried',
    }));
    assert.strictEqual(p.reviews[0].title, "Rodgers & Hammerstein's Cinderella");
    assert.strictEqual(p.reviews[0].reviewText, 'She said "wow" & cried');
  });

  it('handles missing venue parens, missing date, missing comment', () => {
    const p = parseProfileHtml(tile({ score: '70', showtitle: 'Are the Bennet Girls Ok?' }));
    const r = p.reviews[0];
    assert.strictEqual(r.title, 'Are the Bennet Girls Ok?');
    assert.strictEqual(r.venueHint, null);
    assert.strictEqual(r.dateSeen, null);
    assert.strictEqual(r.reviewText, null);
    assert.strictEqual(r.rating, 3.5);
  });

  it('returns rating null (never a clamped guess) for unparseable scores', () => {
    const p = parseProfileHtml(
      tile({ score: '', showtitle: 'A' }) +
      tile({ score: 'garbage', showtitle: 'B' }) +
      tile({ score: '250', showtitle: 'C' })
    );
    assert.strictEqual(p.reviews.length, 3);
    for (const r of p.reviews) assert.strictEqual(r.rating, null);
  });

  it('skips tiles without a showtitle and tolerates empty/garbage input', () => {
    assert.strictEqual(parseProfileHtml(tile({ score: '80' })).reviews.length, 0);
    assert.deepStrictEqual(parseProfileHtml('').reviews, []);
    assert.deepStrictEqual(parseProfileHtml(null).reviews, []);
  });
});

describe('scoreToRating — Show Score stars are score/20, snapped to half-stars', () => {
  it('maps display-verified anchors', () => {
    assert.strictEqual(scoreToRating(80), 4);    // ★4 on live site
    assert.strictEqual(scoreToRating(100), 5);
    assert.strictEqual(scoreToRating(90), 4.5);
    assert.strictEqual(scoreToRating(50), 2.5);
  });
  it('snaps granular user-entered scores to nearest half-star', () => {
    assert.strictEqual(scoreToRating(61), 3);    // 3.05 → 3.0
    assert.strictEqual(scoreToRating(69), 3.5);  // 3.45 → 3.5
    assert.strictEqual(scoreToRating(96), 5);    // 4.8 → 5.0
  });
  it('floors at 0.5 (DB CHECK is 0.5–5) and rejects out-of-range/NaN as null', () => {
    assert.strictEqual(scoreToRating(0), 0.5);
    assert.strictEqual(scoreToRating(4), 0.5);
    assert.strictEqual(scoreToRating(NaN), null);
    assert.strictEqual(scoreToRating(101), null);
    assert.strictEqual(scoreToRating(-1), null);
    assert.strictEqual(scoreToRating(undefined), null);
  });
});

describe('venue hints', () => {
  it('flags market labels so they are not used as venues in matching', () => {
    for (const h of ['Broadway', 'West End', 'Off-Broadway', 'off broadway', 'National Tour']) {
      assert.strictEqual(venueHintIsMarket(h), true, h);
    }
    for (const h of ['Astor Place Theatre', 'The Public Theater', null]) {
      assert.strictEqual(venueHintIsMarket(h), false, String(h));
    }
  });
  it('cleans production-year decorations', () => {
    assert.strictEqual(cleanVenueHint('Minetta Lane Theatre | 2024 Production'), 'Minetta Lane Theatre');
    assert.strictEqual(cleanVenueHint('Public Theater 2023'), 'Public Theater');
    assert.strictEqual(cleanVenueHint('Westside Theatre'), 'Westside Theatre');
    assert.strictEqual(cleanVenueHint(''), null);
  });
});

describe('parsePageCount', () => {
  it('reads the highest page from pagination links', () => {
    const html = '<a href="/member/x?page=2#reviews-section">2</a><a href="/member/x?page=2#reviews-section">Next ›</a>';
    assert.strictEqual(parsePageCount(html), 2);
    assert.strictEqual(parsePageCount('<a href="/member/x?page=7">Last »</a>'), 7);
    assert.strictEqual(parsePageCount('<div>no pagination</div>'), 1);
  });
});

describe('decodeEntities', () => {
  it('decodes the entity set Show Score emits in attribute values', () => {
    assert.strictEqual(decodeEntities('&quot;a&quot; &amp; &#39;b&#39; &lt;c&gt;'), `"a" & 'b' <c>`);
  });
});
