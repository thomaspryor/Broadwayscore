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
 * Known limit: a PARTIAL format change (some posts in a new shape) passes the
 * CLI's parsed>0 drift guard — only a full format change alarms.
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
 * BWW Google-News sitemap <n:title> values are "Review Roundup: TITLE, ..."
 * for opening-night roundups (the format audit-reverse-discovery.js needs),
 * mixed with syndication-shaped titles for non-stage content (a movie/TV
 * tie-in "comes to" theaters, not a new production). Returns the show title,
 * or null when the title isn't a per-show roundup, or names non-stage media.
 */
// Non-stage-production mentions (film/streaming tie-ins) aren't a missing
// show even though they're formatted as a roundup headline. Exported so the
// caller can distinguish "deliberately filtered" from "format drift" when a
// window's only roundup-shaped titles happen to be tie-ins.
const BWW_NON_STAGE_TIE_IN_RE = /\b(movie theaters?|film adaptation|now streaming|on netflix|the big screen|in theaters)\b/i;
function isBwwNonStageTieIn(rawTitle) {
  return BWW_NON_STAGE_TIE_IN_RE.test(rawTitle);
}

// This source is scoped to NYC (see audit-reverse-discovery.js's hardcoded
// market: 'nyc') but the feed itself is not NYC-exclusive — West End/tour/
// regional roundups share the same "Review Roundup: TITLE, ..." shape.
const BWW_NON_NYC_RE = /\b(west end|in london|national tour|on tour|touring production|the muny|us tour)\b/i;

function extractShowTitleFromBwwRoundup(rawTitle) {
  const decoded = decodeEntities(rawTitle).trim();
  const m = decoded.match(/^Review\s+Roundup:\s*(.+)$/i);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest) return null;
  if (isBwwNonStageTieIn(rest) || BWW_NON_NYC_RE.test(rest)) return null;
  // Keyword separators are tried before a bare comma — a bare comma is only
  // treated as a title boundary when it's immediately followed by one of the
  // "who's in it" words, matching the real "TITLE, Starring ..." shape.
  // Otherwise titles with internal commas (OH, MARY!, GOOD NIGHT, AND GOOD
  // LUCK) would get truncated at the first comma.
  const sep = rest.match(
    /^(.{2,80}?)(?:,\s*(?:Starring|Featuring|With)\b|\s+(?:Opens?\s+(?:on|in)|Comes?\s+to|Starring|Begins|Returns?\s+to|Transfers?\s+to)\b)/i
  );
  const title = (sep ? sep[1] : rest).trim();
  return title || null;
}

/**
 * DTLI show-page slugs → display-ish title. Slugs carry SEO noise tails
 * ("-broadway-theater-review(s)") and WordPress collision suffixes
 * ("giant-2", "death-of-a-salesman-3") that aren't part of the show title.
 * Headline-style slugs ("kelli-ohara-and-rose-byrne-are-a-great-…") pass
 * through untrimmed — titleMatchesIndex handles them via containment, so a
 * headline naming a missing show still surfaces (long real titles like The
 * Curious Incident… must not be dropped here).
 */
function titleFromDtliSlug(slug) {
  const NOISE_TAIL = new Set(['review', 'reviews', 'broadway', 'theater', 'theatre', 'off']);
  const words = String(slug || '').toLowerCase().split('-').filter(Boolean);
  while (words.length > 1 && NOISE_TAIL.has(words[words.length - 1])) words.pop();
  // WordPress slug-collision suffix: a trailing single digit 2-9 that isn't
  // part of a real title ("giant-2", "death-of-a-salesman-3"). Multi-digit
  // trailing numbers are real title words ("The Fear of 13" — live FP 2026-07).
  if (words.length > 1 && /^[2-9]$/.test(words[words.length - 1])) words.pop();
  return words.length ? words.join(' ') : null;
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

const NYC_CATEGORIES = new Set(['broadway', 'off-broadway']);
const WE_CATEGORIES = new Set(['west-end', 'off-west-end']);

/**
 * Index show titles under their normalized variants, optionally scoped to a
 * market ('we' | 'nyc'). Scoping matters: shows.json keeps SEPARATE entries
 * per market, so a WET roundup for a title catalogued only on Broadway means
 * the West End production IS missing — a global index would swallow it
 * (reviewer finding, 2026-07-21). Shows with no category land in every
 * market's index (conservative: unknown-market entries suppress candidates).
 * Titles also index their pre-" - " head ("Mother Courage and Her Children -
 * Globe" carries a venue tail after " - " — live FP class).
 *
 * Returns { exact: Set<variant>, containment: string[], statusByVariant:
 * Map<variant, Array<{status, closingDate}>> } — containment holds
 * multi-word (≥2 words, ≥8 chars) base titles for substring matching of
 * headline-style items; statusByVariant carries per-show status/closingDate
 * so callers can distinguish "title matches a LIVE show" (real match) from
 * "title matches only CLOSED productions" (a same-title revival, still a
 * missing-show candidate — see titleMatchesIndex's allowClosedRevival).
 */
function buildShowTitleIndex(shows, market = null) {
  const exact = new Set();
  const containment = new Set();
  const statusByVariant = new Map();
  for (const s of shows) {
    if (market) {
      const cat = s.category || null;
      if (cat && market === 'we' && !WE_CATEGORIES.has(cat)) continue;
      if (cat && market === 'nyc' && !NYC_CATEGORIES.has(cat)) continue;
    }
    const raws = [s.title, s.slug ? s.slug.replace(/-/g, ' ') : null];
    if (s.title && s.title.includes(' - ')) raws.push(s.title.split(' - ')[0]);
    for (const raw of raws) {
      if (!raw) continue;
      const n = normalizeTitle(raw);
      if (!n) continue;
      for (const v of titleVariants(n)) {
        exact.add(v);
        if (!statusByVariant.has(v)) statusByVariant.set(v, []);
        statusByVariant.get(v).push({ status: s.status || null, closingDate: s.closingDate || null });
      }
      if (n.includes(' ') && n.length >= 8) containment.add(n);
    }
  }
  return { exact, containment: [...containment], statusByVariant };
}

const HEADLINE_WORD_THRESHOLD = 6;

/**
 * opts.allowClosedRevival: when true, a title that matches ONLY closed
 * productions under every matching variant does NOT count as a match — it
 * surfaces as a missing-show candidate (a same-title revival, e.g. a 2026
 * Gin Game roundup when the catalogue's only Gin Game entries are 1977/1997/
 * 2015, all closed). A title matching at least one open/upcoming show under
 * any variant is always a genuine match. Off by default: WET/DTLI page
 * lastmod timestamps can touch old show pages for reasons unrelated to a new
 * production, so only sources confirmed roundup-shaped (BWW) opt in.
 */
function titleMatchesIndex(title, index, opts = {}) {
  const { allowClosedRevival = false } = opts;
  const n = normalizeTitle(title);
  if (!n) return true; // unparseable → never a candidate
  for (const v of titleVariants(n)) {
    if (!index.exact.has(v)) continue;
    if (!allowClosedRevival) return true;
    const entries = (index.statusByVariant && index.statusByVariant.get(v)) || [];
    const allClosed = entries.length > 0 && entries.every((e) => e.status === 'closed');
    if (!allClosed) return true; // a live/upcoming show under this title — genuine match
    // Every catalogued production under this variant has closed — keep
    // checking other variants before concluding it's a revival candidate.
  }
  // Headline-style items (DTLI slugs that are review headlines, not titles)
  // can't match exactly — but a headline NAMING a catalogued show should not
  // surface ("kelli ohara and rose byrne … in fallen angels" when Fallen
  // Angels is catalogued). Containment only for long items so short real
  // titles can't be swallowed by a longer catalogued title.
  if (n.split(' ').length > HEADLINE_WORD_THRESHOLD) {
    const padded = ` ${n} `;
    for (const t of index.containment) {
      if (padded.includes(` ${t} `)) return true;
    }
  }
  return false;
}

/**
 * items: [{ title, source, url, date }] → subset whose title matches no show.
 * opts forwards to titleMatchesIndex (see allowClosedRevival there).
 */
function findUnmatchedCandidates(items, index, opts = {}) {
  return items.filter((it) => it && it.title && !titleMatchesIndex(it.title, index, opts));
}

function candidateKey(c) {
  return `${c.source}:${normalizeTitle(c.title)}`;
}

module.exports = {
  decodeEntities,
  extractShowTitleFromWetRoundup,
  extractShowTitleFromBwwRoundup,
  isBwwNonStageTieIn,
  titleFromDtliSlug,
  titleVariants,
  buildShowTitleIndex,
  titleMatchesIndex,
  findUnmatchedCandidates,
  candidateKey,
};
