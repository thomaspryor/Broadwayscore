'use strict';
/**
 * Tour runtime from the tour's own Tours To You page (BRO-4750).
 *
 * Each tourstoyou.org show page carries a "Details" list for the touring
 * production:
 *   <li><strong>Runtime</strong>: 2 hours 35 minutes</li>
 *   <li><strong>Intermissions</strong>: 1</li>
 * Pages differ in where the colon sits (inside or outside the <strong>), and
 * most pages repeat the list once per layout (desktop and mobile), so a page
 * has one or two identical blocks.
 *
 * Fails closed, like todaytix-runtime.js: a page with no parseable block, or
 * with blocks that disagree on the number of minutes, yields null and the
 * caller leaves the tour alone. A wrong runtime shown to readers is worse than
 * a blank one.
 *
 * The runtime text goes through parseRunTimeDisplay (the shared TodayTix
 * parser), which handles "2 hours 35 minutes", "1hr 30min" and ranges, and
 * returns null for multi-part listings.
 *
 * Usage:
 *   const { extractTourRuntime } = require('./lib/tour-runtime');
 *   extractTourRuntime(html); // { minutes: 155, runtime: '2h 35m', intermissions: 1 } | null
 */
const { parseRunTimeDisplay } = require('./todaytix-runtime');
const { foldDiacritics } = require('./title-match');
const { scheduleSlugs } = require('./tour-schedule');

// <strong>Runtime</strong>: text   |   <strong>Runtime:</strong> text
const RUNTIME_RE = /<strong>\s*Runtime\s*:?\s*<\/strong>\s*:?\s*([^<]*)<\/li>/gi;
// "2 hours 35 minutes", "1 hour 40 minutes", "2 hours", "90 minutes" (case and spacing free).
const RUNTIME_TEXT = /^\s*(?:\d+\s*hours?(?:\s*(?:and\s+)?\d+\s*minutes?)?|\d+\s*minutes?)\s*$/i;
// The Intermissions item that follows a Runtime item in the same list.
const INTERMISSIONS_RE = /<strong>\s*Intermissions?\s*:?\s*<\/strong>\s*:?\s*([^<]*)<\/li>/i;

/** "1"/"One" -> 1, "None"/"No intermission"/"0" -> 0, anything else -> null. */
function parseIntermissions(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (/^(none|no\b|0$)/.test(t)) return 0;
  const words = { one: 1, two: 2, three: 3, four: 4 };
  const w = t.match(/^(one|two|three|four)\b/);
  if (w) return words[w[1]];
  const m = t.match(/^(\d+)\b/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * @param {string} html a Tours To You show page
 * @returns {{minutes: number, runtime: string, intermissions: number|null}|null}
 */
function extractTourRuntime(html) {
  if (typeof html !== 'string' || !html) return null;
  const found = [];
  for (const m of html.matchAll(RUNTIME_RE)) {
    // Only the plain shapes the site uses. The shared parser also accepts looser
    // text, and misreads some of it ("2.5 hours" as 5h, "2 hrs. 35 mins." as 2h),
    // so anything else fails closed here.
    if (!RUNTIME_TEXT.test(m[1])) continue;
    const parsed = parseRunTimeDisplay(m[1]);
    if (!parsed) continue;
    // Only the list item right after this Runtime item can be its Intermissions.
    const tail = html.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const im = tail.match(new RegExp('^\\s*<li>' + INTERMISSIONS_RE.source, 'i'));
    found.push({ minutes: parsed.minutes, runtime: parsed.runtime, intermissions: im ? parseIntermissions(im[1]) : null });
  }
  if (!found.length) return null;
  // Blocks that disagree on the length mean the page lists more than one
  // production or version: no single number is honest.
  if (new Set(found.map(f => f.minutes)).size > 1) return null;
  const counts = new Set(found.map(f => f.intermissions));
  return { minutes: found[0].minutes, runtime: found[0].runtime, intermissions: counts.size === 1 ? found[0].intermissions : null };
}

/** Letters and digits only, lowercased, "the musical"/"the" noise dropped. Pure. */
function titleKey(s) {
  return foldDiacritics(String(s || '')).toLowerCase()
    .replace(/&amp;|&/g, 'and').replace(/\bthe musical\b/g, ' ')
    .replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').replace(/\bthe\b/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * True when the page's <title> ("<Show> – Tours To You") names this tour, so a
 * redirect or a look-alike slug never lends another show's runtime. A page
 * title that adds a subtitle after a separator ("A Beautiful Noise, The Neil
 * Diamond Musical") counts; one that just starts with the tour's title, or a
 * title longer on the tour's side, does not. Pure.
 */
function pageIsTour(html, tour) {
  const m = String(html || '').match(/<title>([^<]*)<\/title>/i);
  if (!m) return false;
  const decoded = m[1]
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&ndash;|&mdash;/g, '-').replace(/&rsquo;/g, "'").replace(/&amp;/g, '&')
    .replace(/[\u2013\u2014]/g, '-').replace(/\u2019/g, "'");
  const title = decoded.replace(/\s*-\s*Tours To You.*$/i, '');
  const want = titleKey(tour.title);
  if (!want || !titleKey(title)) return false;
  if (titleKey(title) === want) return true;
  // A subtitle after a comma, colon, dash or bracket still names the show ("A
  // Beautiful Noise, The Neil Diamond Musical"). A page that merely STARTS with the
  // title does not: "Annie Get Your Gun" is not "Annie", and a redirect to a news post
  // ("'SIX' Casting Announced ...", the live six slug) is not the show's page.
  const head = title.split(/\s*(?:[,:(]|\s-\s)/)[0];
  return titleKey(head) === want;
}

/** Candidate pages for a tour: its saved schedule source first, then the slug guesses. Pure. */
function candidateUrls(tour, schedules) {
  const urls = [];
  const saved = schedules && schedules.tours && schedules.tours[tour.id] && schedules.tours[tour.id].source;
  if (saved) urls.push(saved);
  for (const slug of scheduleSlugs(tour).slice(0, 2)) {
    const u = `https://tourstoyou.org/shows/${slug}/`;
    if (!urls.includes(u)) urls.push(u);
  }
  return urls;
}

module.exports = { extractTourRuntime, parseIntermissions, titleKey, pageIsTour, candidateUrls };
