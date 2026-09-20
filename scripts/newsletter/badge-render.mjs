// Score badge image-URL builder for the newsletter (BRO-1392).
//
// Gmail iOS dark mode force-inverts the newsletter's dark design to a light
// background. Badge background colors (gold/teal/brown) resist inversion but
// badge TEXT color still flips, breaking contrast per badge — Birthright's
// "84" rendered white-on-gold, Black Mirror's "67" dark-on-green, etc. (owner
// screenshot 2026-07-05). generate.mjs already has heavy CSS hardening
// (color-scheme, [data-ogsc]/[data-ogsb] selectors, prefers-color-scheme
// pins) but Gmail repaints AFTER those rules apply, so no CSS fix holds.
//
// A flat PNG is immune: Gmail cannot recolor pixels baked into a raster
// image. Badges render server-side via /api/newsletter-badge (edge route,
// @vercel/og) and are embedded as <img> tags instead of styled <div>s.
//
// Pure/testable per CLAUDE.md §15 — badge-render.test.mjs imports this
// directly rather than re-copying the URL-building logic.

const BADGE_ENDPOINT = 'https://broadwayscorecard.com/api/newsletter-badge';

// Cache-buster. The route responds `cache-control: public, immutable,
// max-age=31536000`, so Vercel's CDN and Gmail's image proxy keep serving the
// PNG they already have for a given parameter combination — and the same
// combos recur every week (?tier=rec&score=84&size=64&...). Without this,
// changing how a badge RENDERS has no visible effect for up to a year:
// the Inter typeface fix shipped and readers would still have received
// Noto Sans badges (QA review, 2026-09-20).
//
// Bump this on ANY change to src/app/api/newsletter-badge/route.tsx that
// alters pixels — font, weight, color, radius, padding, scale.
//   v2 — 2026-09-20: render in Inter, score badge weight 800 -> 700.
export const BADGE_VERSION = '2';

// The route is a public, unauthenticated endpoint, so it takes a `tier` ID
// (gold/rec/worth/skip/miss) rather than raw color strings — colors live in
// a fixed table on the route itself (mirrors src/app/api/og/route.tsx's
// SCORE_COLORS precedent) so the endpoint can't be used to render arbitrary
// CSS/text. `tier` here is the object returned by generate.mjs's
// scoreTier(score, category), or null for an unscored (TBD) show.
export function buildBadgeUrl({ tier, score, size, fontSize, radius }) {
  const params = new URLSearchParams();
  if (tier) {
    params.set('tier', tier.id);
    params.set('score', String(score));
  }
  params.set('size', String(size));
  params.set('fontSize', String(fontSize));
  params.set('radius', String(radius));
  params.set('v', BADGE_VERSION);
  return `${BADGE_ENDPOINT}?${params.toString()}`;
}

// Renders the <img> tag. `alt` carries the score + tier label so the badge
// still communicates its meaning when images are blocked (a real cost of the
// image approach, accepted as part of BRO-1392's recommended fix) or read by
// a screen reader.
export function badgeImg({ tier, score, size, fontSize, radius, shadow }) {
  const url = buildBadgeUrl({ tier, score, size, fontSize, radius });
  const alt = tier ? `${score} — ${tier.label}` : 'TBD';
  const shadowStyle = shadow ? `box-shadow:${shadow};` : '';
  // display:inline-block (not block) — the old <div> this replaces was
  // inline-block, and several callers center it via the parent <td>'s
  // text-align:center (e.g. generate.mjs:677). A block-level image ignores
  // that and left-aligns instead (ship-check/Codex catch).
  return `<img src="${url}" width="${size}" height="${size}" alt="${alt}" style="display:inline-block;width:${size}px;height:${size}px;border-radius:${radius}px;border:0;${shadowStyle}">`;
}

// BRO-3555 — same bug class as BRO-1392 for the Social Buzz rank box
// (rankBadgeColor() in generate.mjs) and the Awards Score Movers ring
// (awardBadgeBox()/awardTierColor()): a colored box + separately-styled text
// color, both CSS, both flipped independently by Gmail iOS dark mode. Same
// fix — render as a flat PNG, keyed off a fixed `tier` id (see
// RANK_COLORS/AWARD_RING_COLORS on the route) rather than raw colors.

export function buildRankBadgeUrl({ tierId, position, size, fontSize, radius }) {
  const params = new URLSearchParams();
  params.set('kind', 'rank');
  params.set('tier', tierId);
  params.set('pos', String(position));
  params.set('size', String(size));
  params.set('fontSize', String(fontSize));
  params.set('radius', String(radius));
  params.set('v', BADGE_VERSION);
  return `${BADGE_ENDPOINT}?${params.toString()}`;
}

// `shadow` is decorative (box-shadow color), not text — it's composed from
// the same local color the caller used to pick `tierId` and never crosses
// the wire, so it isn't subject to the text/background inversion mismatch
// this bug class is about; safe to keep applying it client-side on the <img>.
export function rankBadgeImg({ tierId, position, size, fontSize, radius, shadow, label }) {
  const url = buildRankBadgeUrl({ tierId, position, size, fontSize, radius });
  const shadowStyle = shadow ? `box-shadow:${shadow};` : '';
  const alt = label || `#${position}`;
  return `<img src="${url}" width="${size}" height="${size}" alt="${alt}" style="display:inline-block;width:${size}px;height:${size}px;border-radius:${radius}px;border:0;${shadowStyle}">`;
}

export function buildAwardBadgeUrl({ tierId, score, size, fontSize }) {
  const params = new URLSearchParams();
  params.set('kind', 'award');
  params.set('tier', tierId);
  params.set('score', String(score));
  params.set('size', String(size));
  params.set('fontSize', String(fontSize));
  params.set('v', BADGE_VERSION);
  return `${BADGE_ENDPOINT}?${params.toString()}`;
}

export function awardBadgeImg({ tierId, score, size, fontSize }) {
  const url = buildAwardBadgeUrl({ tierId, score, size, fontSize });
  const display = score > 0 ? score : '—';
  return `<img src="${url}" width="${size}" height="${size}" alt="Award score ${display}" style="display:inline-block;width:${size}px;height:${size}px;border-radius:50%;border:0;">`;
}
