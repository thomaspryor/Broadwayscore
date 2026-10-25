// Regression guard for BRO-1392 (Gmail iOS dark mode inverting score badge
// text against a background it can't invert). Badges now render as PNGs from
// /api/newsletter-badge instead of styled <div>s — these tests lock down the
// URL/HTML the newsletter embeds, not the route's rendering itself (that's
// image output, not something node:test can assert on).
//
// Per CLAUDE.md §15 these import the real functions; no logic is copied here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBadgeUrl, badgeImg, buildRankBadgeUrl, rankBadgeImg, buildAwardBadgeUrl, awardBadgeImg, BADGE_VERSION } from './badge-render.mjs';

const goldTier = { id: 'gold', label: 'Critical Gold', bg: 'linear-gradient(...)', text: '#1a1a1a', border: '#C8960E', glow: '0 0 24px rgba(218,165,32,0.55)' };
const recTier = { id: 'rec', label: 'Recommended', bg: '#22c55e', text: '#fff', glow: '0 2px 8px rgba(34,197,94,0.3)' };

test('buildBadgeUrl encodes tier id + score, not raw colors', () => {
  const url = buildBadgeUrl({ tier: recTier, score: 84, size: 64, fontSize: 30, radius: 12 });
  const params = new URL(url).searchParams;
  assert.equal(params.get('tier'), 'rec');
  assert.equal(params.get('score'), '84');
  assert.equal(params.get('size'), '64');
  assert.equal(params.get('fontSize'), '30');
  assert.equal(params.get('radius'), '12');
  // The whole point of BRO-1392: no bg/text hex ever crosses the wire — the
  // route resolves colors itself from a fixed table, so a caller (or an
  // attacker hitting the public endpoint) can't inject arbitrary CSS colors.
  assert.equal(params.get('bg'), null);
  assert.equal(params.get('text'), null);
});

test('buildBadgeUrl omits tier/score for an unscored (TBD) badge', () => {
  const url = buildBadgeUrl({ tier: null, score: null, size: 36, fontSize: 11, radius: 8 });
  const params = new URL(url).searchParams;
  assert.equal(params.get('tier'), null);
  assert.equal(params.get('score'), null);
  assert.equal(params.get('size'), '36');
});

test('badgeImg renders an <img> pinned to the exact nominal size', () => {
  const html = badgeImg({ tier: goldTier, score: 94, size: 64, fontSize: 30, radius: 12, shadow: goldTier.glow });
  assert.match(html, /<img /);
  assert.match(html, /width="64"/);
  assert.match(html, /height="64"/);
  assert.match(html, /border-radius:12px/);
  assert.match(html, /box-shadow:0 0 24px rgba\(218,165,32,0.55\)/);
  assert.match(html, /src="https:\/\/broadwayscorecard\.com\/api\/newsletter-badge\?/);
});

test('badgeImg stays inline-block so parent text-align:center still centers it', () => {
  // Regression: an earlier draft used display:block, which ignores the
  // parent <td> text-align:center (the newsletter generator's scoreCol) and
  // left-aligns the badge instead of centering it (ship-check/Codex catch).
  const html = badgeImg({ tier: goldTier, score: 94, size: 64, fontSize: 30, radius: 12 });
  assert.match(html, /display:inline-block/);
  assert.doesNotMatch(html, /display:block/);
});

test('badgeImg alt text carries score + tier label for blocked-image / screen-reader fallback', () => {
  const html = badgeImg({ tier: goldTier, score: 94, size: 64, fontSize: 30, radius: 12 });
  assert.match(html, /alt="94 — Critical Gold"/);
});

test('badgeImg falls back to a plain "TBD" alt for an unscored show', () => {
  const html = badgeImg({ tier: null, score: null, size: 36, fontSize: 11, radius: 8 });
  assert.match(html, /alt="TBD"/);
  assert.doesNotMatch(html, /box-shadow:/);
});

// BRO-3555 — Social Buzz rank box + Awards Score Movers ring, same fix as
// BRO-1392: render as an <img> keyed off a fixed tier id, never raw colors.

test('buildRankBadgeUrl encodes kind + tier id + position, not raw colors', () => {
  const url = buildRankBadgeUrl({ tierId: 'top10', position: 1, size: 40, fontSize: 15, radius: 8 });
  const params = new URL(url).searchParams;
  assert.equal(params.get('kind'), 'rank');
  assert.equal(params.get('tier'), 'top10');
  assert.equal(params.get('pos'), '1');
  assert.equal(params.get('size'), '40');
  assert.equal(params.get('bg'), null);
  assert.equal(params.get('text'), null);
});

test('rankBadgeImg renders an <img> pinned to the exact nominal size with decorative shadow', () => {
  const html = rankBadgeImg({ tierId: 'top10', position: 1, size: 40, fontSize: 15, radius: 8, shadow: '0 2px 6px #f59e0b55' });
  assert.match(html, /<img /);
  assert.match(html, /width="40"/);
  assert.match(html, /height="40"/);
  assert.match(html, /border-radius:8px/);
  assert.match(html, /box-shadow:0 2px 6px #f59e0b55/);
  assert.match(html, /alt="#1"/);
  assert.match(html, /src="https:\/\/broadwayscorecard\.com\/api\/newsletter-badge\?kind=rank/);
});

test('buildAwardBadgeUrl encodes kind + tier id + score, not a raw ring color', () => {
  const url = buildAwardBadgeUrl({ tierId: 'sweeper', score: 12, size: 40, fontSize: 14 });
  const params = new URL(url).searchParams;
  assert.equal(params.get('kind'), 'award');
  assert.equal(params.get('tier'), 'sweeper');
  assert.equal(params.get('score'), '12');
  assert.equal(params.get('bg'), null);
});

test('awardBadgeImg renders a circular <img> and falls back to an em dash for a zero/negative score', () => {
  const html = awardBadgeImg({ tierId: 'nominated', score: 0, size: 40, fontSize: 14 });
  assert.match(html, /<img /);
  assert.match(html, /border-radius:50%/);
  assert.match(html, /alt="Award score —"/);
});

// The route serves `cache-control: public, immutable, max-age=31536000` and
// the same parameter combos recur every week, so without a version param a
// render change (font, weight, colour) is invisible to the CDN and to Gmail's
// image proxy for up to a year. The Inter typeface fix shipped behind exactly
// this and would have reached no reader (QA review, 2026-09-20).
test('every badge URL carries the cache-busting version param', () => {
  const urls = [
    buildBadgeUrl({ tier: recTier, score: 84, size: 64, fontSize: 30, radius: 12 }),
    buildBadgeUrl({ tier: null, score: null, size: 64, fontSize: 14, radius: 12 }),
    buildRankBadgeUrl({ tierId: 'top10', position: 3, size: 36, fontSize: 14, radius: 8 }),
    buildAwardBadgeUrl({ tierId: 'sweeper', score: 88, size: 40, fontSize: 14 }),
  ];
  for (const u of urls) {
    assert.equal(new URL(u).searchParams.get('v'), BADGE_VERSION, `missing v= in ${u}`);
  }
  assert.match(BADGE_VERSION, /^\d+$/);
});
