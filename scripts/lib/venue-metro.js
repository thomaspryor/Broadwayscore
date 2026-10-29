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

const ALIASES = TABLE.venues
  .flatMap((v) => v.aliases.map((a) => ({ a: norm(a), metro: v.metro })))
  .filter((x) => x.a)
  .sort((x, y) => y.a.length - x.a.length)
  .map((x) => ({ re: new RegExp(`(?:^| )${esc(x.a)}(?: |$)`), metro: x.metro }));

// Trailing-city fallback for a venue no alias names. The city must carry its
// jurisdiction: UK metros match "Leeds" or "Leeds, UK"; US/CA metros (and the
// "City, ST" entries in `cities`) only match with their own state code, so
// "Birmingham, AL", "Arlington, TX" and bare "Cambridge" never map to a hub.
const CITY_RE = Object.entries(TABLE.metros).flatMap(([metro, m]) => {
  const tail = (c, q) => ({ re: new RegExp(`(?:^| )${esc(norm(c))}${q}$`), metro });
  const own = m.country === 'UK' ? tail(m.name, '(?: uk)?') : tail(m.name, ` ${esc(m.state)}`);
  return [own, ...(m.cities || []).map((c) => tail(c, ''))];
});

/** Metro slug for a venue string ("Goodman Theatre, Chicago, IL"), or null. */
function resolveMetro(venue) {
  const n = norm(venue);
  if (!n) return null;
  // Multi-city runs name several cities; no single metro (tour stops: tour-schedules.json).
  if (/\b(?:tour|tryouts)\b/.test(n)) return null;
  // Every alias that matches counts: a string naming venues in two metros is ambiguous, not "longest wins".
  const hits = new Set(ALIASES.filter((x) => x.re.test(n)).map((x) => x.metro));
  if (hits.size > 1) return null;
  if (hits.size === 1) return [...hits][0];
  const city = CITY_RE.find((x) => x.re.test(n));
  return city ? city.metro : null;
}

/** Country ('UK' | 'US' | 'CA') of a metro slug, or null. */
function metroCountry(metro) {
  return (TABLE.metros[metro] || {}).country || null;
}

module.exports = { resolveMetro, metroCountry, norm };
