/**
 * Venue -> metro resolver (BRO-6515). Pure; reads data/venue-metros.json, the
 * ONE table behind shows.city on regional/tour shows (UK + US city hubs).
 * market stays 'regional'/'tour' (it drives fail-closed gates); `city` is a
 * metro slug: the /tours/[city] slug for US ("chicago-il"), "<city>-uk" for UK.
 */
const TABLE = require('../../data/venue-metros.json');

const norm = (s) => String(s || '')
  .normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Longest alias first so "royal exchange theatre" beats a shorter overlap.
const ALIASES = TABLE.venues
  .flatMap((v) => v.aliases.map((a) => ({ a: norm(a), metro: v.metro })))
  .filter((x) => x.a)
  .sort((x, y) => y.a.length - x.a.length)
  .map((x) => ({ re: new RegExp(`(?:^| )${esc(x.a)}(?: |$)`), metro: x.metro }));

// Trailing "City" / "City ST" fallback for a venue no alias names.
const CITY_RE = Object.entries(TABLE.metros).flatMap(([metro, m]) =>
  [m.name, ...(m.cities || [])].map((c) => ({ re: new RegExp(`(?:^| )${esc(norm(c))}(?: [a-z]{2})?$`), metro })));

/** Metro slug for a venue string ("Goodman Theatre, Chicago, IL"), or null. */
function resolveMetro(venue) {
  const n = norm(venue);
  if (!n) return null;
  // Multi-city runs name several cities; no single metro (tour stops: tour-schedules.json).
  if (/\b(?:tour|tryouts)\b/.test(n)) return null;
  const hit = ALIASES.find((x) => x.re.test(n)) || CITY_RE.find((x) => x.re.test(n));
  return hit ? hit.metro : null;
}

/** Country ('UK' | 'US' | 'CA') of a metro slug, or null. */
function metroCountry(metro) {
  return (TABLE.metros[metro] || {}).country || null;
}

module.exports = { resolveMetro, metroCountry, norm };
