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
  return `<img src="${url}" width="${size}" height="${size}" alt="${alt}" style="display:block;width:${size}px;height:${size}px;border-radius:${radius}px;border:0;${shadowStyle}">`;
}
