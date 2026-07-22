/**
 * Reverse discovery — pure decision functions.
 *
 * Forward discovery asks "what does each listing source say is on?" and can
 * miss shows whose venue/listing is outside every configured path (Midnight
 * at the Never Get, Menier, 2026-07: venue sold via its own ticketing system,
 * absent from TodayTix/OLT/LT.co.uk AND from VENUE_LISTING_PAGES — invisible
 * to every forward path while 14 outlets reviewed it).
 *
 * Reverse discovery inverts the signal: aggregators publish a roundup/show
 * page for every production important enough to be reviewed. Any recent
 * aggregator item whose title matches NO show in shows.json is a
 * missing-show candidate, regardless of where it sells tickets.
 *
 * Sources are fetched by scripts/audit-reverse-discovery.js; this lib owns
 * the parsing + matching so it can be tested against real fixtures without
 * network (CLAUDE.md §15).
 */

const { normalizeTitle } = require('./title-match');

// Minimal HTML-entity decode for WP-API title.rendered values.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&hellip;/g, '…')
    .replace(/&nbsp;/g, ' ');
}

/**
 * WET roundup post titles: "<Show Title> Reviews: <editorial blurb>" (case
 * varies on "Reviews"). Returns the show title, or null when the post title
 * doesn't follow the per-show roundup shape (season previews, features).
 */
function extractShowTitleFromWetRoundup(postTitle) {
  const decoded = decodeEntities(postTitle).trim();
  const m = decoded.match(/^(.{2,120}?)\s+reviews?\s*:/i);
  if (!m) return null;
  const title = m[1].trim();
  // "Review Roundup: X" inversions and bare "Reviews" headers have no title.
  if (!title || /^review/i.test(title)) return null;
  return title;
}

/**
 * DTLI show-page slugs → display-ish title, or null for slugs that can't be
 * a title. Slugs carry SEO noise tails ("-broadway-theater-review(s)") and
 * WordPress collision suffixes ("giant-2", "death-of-a-salesman-3") that
 * aren't part of the show title. Some DTLI pages use a review HEADLINE as
 * the slug ("kelli-ohara-and-rose-byrne-are-a-great-slapstick-duo-in-…") —
 * those can't be matched by title, so they're rejected (null) rather than
 * surfaced as noise candidates (observed FP classes, real sitemap 2026-07-21).
 */
const DTLI_HEADLINE_MAX_WORDS = 6;

function titleFromDtliSlug(slug) {
  const NOISE_TAIL = new Set(['review', 'reviews', 'broadway', 'theater', 'theatre', 'off']);
  const words = String(slug || '').toLowerCase().split('-').filter(Boolean);
  while (words.length > 1 && NOISE_TAIL.has(words[words.length - 1])) words.pop();
  // WordPress slug-collision suffix: a trailing single digit 2-9 that isn't
  // part of a real title ("giant-2", "death-of-a-salesman-3"). Multi-digit
  // trailing numbers are real title words ("The Fear of 13" — live FP 2026-07).
  if (words.length > 1 && /^[2-9]$/.test(words[words.length - 1])) words.pop();
  if (words.length === 0 || words.length > DTLI_HEADLINE_MAX_WORDS) return null;
  return words.join(' ');
}

/**
 * Expand a normalized title into match variants. Applied to BOTH sides
 * (catalogue index and source-derived candidate) so the noise each side
 * carries cancels out. Live FP classes each rule covers (2026-07-21 run):
 *   - trailing "the musical"  ("Beetlejuice the Musical" ≡ "Beetlejuice")
 *   - trailing market qualifier ("Inter Alia West End" — WET post titles
 *     sometimes append the market; slugs append it near-always)
 *   - trailing 4-digit year   (slug variants like "inter-alia-west-end-2026")
 * Rules apply iteratively so stacked tails ("x west end 2026") fully strip.
 */
function titleVariants(normalized) {
  const out = new Set();
  let cur = normalized;
  for (let i = 0; i < 4 && cur; i++) {
    out.add(cur);
    const next = cur
      .replace(/\s+(the\s+)?musical$/, '')
      .replace(/\s+\d{4}$/, '')
      .replace(/\s+(west end|broadway|off broadway|off west end)$/, '')
      .trim();
    if (next === cur) break;
    cur = next;
  }
  return out;
}

/**
 * Index every show title under its normalized variants. Titles also index
 * their pre-" - " head ("Mother Courage and Her Children - Globe" carries a
 * venue tail after " - " — live FP class).
 */
function buildShowTitleIndex(shows) {
  const index = new Set();
  for (const s of shows) {
    const raws = [s.title, s.slug ? s.slug.replace(/-/g, ' ') : null];
    if (s.title && s.title.includes(' - ')) raws.push(s.title.split(' - ')[0]);
    for (const raw of raws) {
      if (!raw) continue;
      const n = normalizeTitle(raw);
      if (!n) continue;
      for (const v of titleVariants(n)) index.add(v);
    }
  }
  return index;
}

function titleMatchesIndex(title, index) {
  const n = normalizeTitle(title);
  if (!n) return true; // unparseable → never a candidate
  for (const v of titleVariants(n)) if (index.has(v)) return true;
  return false;
}

/**
 * items: [{ title, source, url, date }] → subset whose title matches no show.
 */
function findUnmatchedCandidates(items, index) {
  return items.filter((it) => it && it.title && !titleMatchesIndex(it.title, index));
}

function candidateKey(c) {
  return `${c.source}:${normalizeTitle(c.title)}`;
}

module.exports = {
  decodeEntities,
  extractShowTitleFromWetRoundup,
  titleFromDtliSlug,
  buildShowTitleIndex,
  titleMatchesIndex,
  findUnmatchedCandidates,
  candidateKey,
};
