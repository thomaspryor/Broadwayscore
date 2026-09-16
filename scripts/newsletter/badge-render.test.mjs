// Regression guard for BRO-1392 (Gmail iOS dark mode inverting score badge
// text against a background it can't invert). Badges now render as PNGs from
// /api/newsletter-badge instead of styled <div>s — these tests lock down the
// URL/HTML the newsletter embeds, not the route's rendering itself (that's
// image output, not something node:test can assert on).
//
// Per CLAUDE.md §15 these import the real functions; no logic is copied here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildBadgeUrl, badgeImg } from './badge-render.mjs';

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

test('badgeImg alt text carries score + tier label for blocked-image / screen-reader fallback', () => {
  const html = badgeImg({ tier: goldTier, score: 94, size: 64, fontSize: 30, radius: 12 });
  assert.match(html, /alt="94 — Critical Gold"/);
});

test('badgeImg falls back to a plain "TBD" alt for an unscored show', () => {
  const html = badgeImg({ tier: null, score: null, size: 36, fontSize: 11, radius: 8 });
  assert.match(html, /alt="TBD"/);
  assert.doesNotMatch(html, /box-shadow:/);
});
