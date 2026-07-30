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
//
// "West End" is deliberately NOT matched when immediately followed by
// Theatre/Theater: The West End Theatre is a real Off-Broadway house at
// 263 W 86th St, and dropping it would silently lose a genuine NYC miss.
// "London" is only a signal after a preposition ("at/in/to London") — a bare
// \blondon\b would swallow real titles such as LONDON ROAD.
const BWW_NON_NYC_RE = /\b(?:west end(?!\s+theat(?:re|er))|(?:in|at|to|from)\s+london|national tour|on tour|touring production|the muny|us tour)\b/i;
function isBwwNonNycRoundup(rawTitle) {
  return BWW_NON_NYC_RE.test(rawTitle);
}

// Headline shapes that put the show title AFTER a lead-in phrase rather than
// first ("What Did the Critics Think of X?"). Stripped before separator
// splitting so the title isn't buried in the lead-in.
const BWW_LEADIN_RE = /^What\s+Did\s+(?:the\s+)?Critics\s+Think\s+O(?:f|n)\s+/i;

function extractShowTitleFromBwwRoundup(rawTitle) {
  const decoded = decodeEntities(rawTitle).trim();
  const m = decoded.match(/^Review\s+Roundup:\s*(.+)$/i);
  if (!m) return null;
  let rest = m[1].trim();
  if (!rest) return null;
  if (isBwwNonStageTieIn(rest) || isBwwNonNycRoundup(rest)) return null;
  rest = rest.replace(BWW_LEADIN_RE, '').trim();
  if (!rest) return null;
  // Keyword separators are tried before a bare comma — a bare comma is only
  // treated as a title boundary when it's immediately followed by one of the
  // "who's in it" words, matching the real "TITLE, Starring ..." shape.
  // Otherwise titles with internal commas (OH, MARY!, GOOD NIGHT, AND GOOD
  // LUCK) would get truncated at the first comma.
  //
  // Venue tails split ONLY via an opening verb ("Opens at the Majestic").
  //
  // A standalone " at the " branch was tried and REVERTED (2026-07-26): real
  // catalogued titles contain it, and truncating them is worse than leaving a
  // venue tail on. Two verified harms, both from data/shows.json:
  //   "MIDNIGHT AT THE NEVER GET" -> "MIDNIGHT", which then exact-matches the
  //     unrelated show "Midnight" and SILENTLY SUPPRESSES a real missing show
  //     — and Midnight at the Never Get is the originating miss this whole
  //     detector was built for (task #281).
  //   "HUGO MARCHAND | ARTISTS AT THE CENTER" (open, off-broadway) ->
  //     "HUGO MARCHAND | ARTISTS", a false "missing show" alert.
  // A venue-word tail check doesn't save it either — "Center" IS a venue word.
  // Leaving a tail on costs at most one noisy candidate; truncating loses real
  // shows silently, so the asymmetry favors under-splitting.
  const sep = rest.match(
    /^(.{2,80}?)(?:,\s*(?:Starring|Featuring|With)\b|\s+-\s+All\s+the\s+Reviews|\s+(?:Opens?\b|Comes?\s+to|Starring|Begins|Returns?\s+to|Transfers?\s+to)\b)/i
  );
  const title = (sep ? sep[1] : rest).trim();
  return title || null;
}

/**
 * Playbill review-roundup headlines: "Reviews: What Do (the) Critics Think of
 * <Show> (Off-Broadway|on Broadway|…)?" (RSS <title> / article <h1> shape —
 * live example 2026-07-28: "Reviews: What Do Critics Think of Cat Cohen's
 * Broad Strokes Off-Broadway?"). Returns the show phrase with the market tail
 * stripped, or null for non-roundup headlines. The phrase may carry a
 * possessive lead-in ("Cat Cohen's Broad Strokes" for the show "Cat Cohen:
 * Broad Strokes") — callers should match via titleCandidates(), which adds a
 * possessive-stripped variant.
 */
const PLAYBILL_ROUNDUP_RE = /^Reviews?:\s*What\s+D(?:o|oes|id)\s+(?:the\s+)?Critics?\s+Think\s+of\s+(.+?)\s*\??$/i;
const PLAYBILL_MARKET_TAIL_RE = /\s+(?:off[- ]broadway|on\s+broadway|off[- ]west\s+end|(?:in|on)\s+the\s+west\s+end|in\s+london)$/i;

// Non-NYC Playbill roundups must be DROPPED before matching, not just have
// their tail stripped — "Evita in the West End" would otherwise strip to
// "Evita" and attach evidence to the catalogued BROADWAY Evita (QA ship-check
// finding, verified live: resolved to evita-2026/upcoming). Playbill's WE
// coverage is redundant with the WET roundup source anyway.
const PLAYBILL_NON_NYC_RE = /\b(?:west\s+end(?!\s+theat(?:re|er))|in\s+london|(?:national|us|uk)\s+tour|on\s+tour)\b/i;
function isPlaybillNonNycRoundup(rawTitle) {
  const decoded = decodeEntities(rawTitle);
  const m = decoded.match(PLAYBILL_ROUNDUP_RE);
  return !!(m && PLAYBILL_NON_NYC_RE.test(m[1]));
}

function extractShowTitleFromPlaybillRoundup(rawTitle) {
  const decoded = decodeEntities(rawTitle).trim();
  const m = decoded.match(PLAYBILL_ROUNDUP_RE);
  if (!m) return null;
  let rest = m[1].trim();
  // Strip stacked market tails ("X Off-Broadway", "X on Broadway").
  for (let i = 0; i < 2; i++) {
    const next = rest.replace(PLAYBILL_MARKET_TAIL_RE, '').trim();
    if (next === rest) break;
    rest = next;
  }
  // "the New Musical X" / "the New Play X" lead-ins occasionally prefix titles.
  rest = rest.replace(/^the\s+new\s+(?:musical|play|revival\s+of)\s+/i, '').trim();
  return rest || null;
}

/**
 * Match-candidate strings for a source-derived title. Adds a
 * possessive-stripped variant ("Cat Cohen's Broad Strokes" → "Cat Cohens…" is
 * handled by normalizeTitle, but "Cohen's" vs the catalogued "Cohen:" needs
 * the apostrophe-s REMOVED, not folded). Both variants are tried by callers.
 */
function titleCandidates(title) {
  const out = [title];
  const stripped = String(title || '').replace(/[’'‘]s\b/g, '');
  if (stripped !== title) out.push(stripped);
  return out;
}

/**
 * Resolve which catalogued show a source title refers to, for evidence
 * recording (the inverse of findUnmatchedCandidates: MATCHED items carry the
 * "this show has published reviews" signal that evidence-anchored selection
 * needs — the Broad Strokes class, where a roundup exists but openingDate is
 * null so date-driven selection never fires).
 *
 * Conservative by design: returns a single show id, or null when the title
 * matches nothing, matches only closed productions (evidence would misattach
 * to an old run), or matches MORE than one non-closed production (ambiguous —
 * same-title twins; wrong attachment is worse than no evidence).
 */
function resolveMatchedShowId(title, index) {
  const ids = new Set();
  for (const cand of titleCandidates(title)) {
    const n = normalizeTitle(cand);
    if (!n) continue;
    for (const v of titleVariants(n)) {
      const entries = (index.statusByVariant && index.statusByVariant.get(v)) || [];
      for (const e of entries) {
        if (e.id && e.status && e.status !== 'closed') ids.add(e.id);
      }
    }
  }
  return ids.size === 1 ? [...ids][0] : null;
}

/**
 * Parse opening-night facts from a Playbill roundup article's plain text.
 * The standard Playbill sentence (verified live, Broad Strokes 2026-07-28):
 *   "The production began previews July 14, officially opening July 27 at
 *    the Lucille Lortel Theatre. Performances will continue an additional
 *    three weeks through September 25."
 * Returns { previewsStartDate, openingDate, closingDate } as ISO dates or
 * null per field. Years are resolved against referenceDate (article publish
 * date): the resolved date must fall within [-9 months, +15 months] of it.
 */
const MONTHS = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5, july: 6,
  august: 7, september: 8, october: 9, november: 10, december: 11,
  'jan.': 0, 'feb.': 1, 'mar.': 2, 'apr.': 3, 'aug.': 7, 'sept.': 8, 'oct.': 9, 'nov.': 10, 'dec.': 11,
};
const MONTH_DAY = '((?:January|February|March|April|May|June|July|August|September|October|November|December|Jan\\.|Feb\\.|Mar\\.|Apr\\.|Aug\\.|Sept\\.|Oct\\.|Nov\\.|Dec\\.)\\s+\\d{1,2}(?:,?\\s+\\d{4})?)';

function resolveDate(monthDayStr, referenceDate, opts = {}) {
  // windowMonths [min, max] bounds the resolved date relative to the article
  // date. Per-field direction matters (QA ship-check finding): "began
  // previews" cannot resolve AFTER the article, "through <date>" cannot
  // resolve months BEFORE it — closest-year alone picks the wrong side at
  // year boundaries.
  const [minMonths, maxMonths] = opts.windowMonths || [-9, 15];
  const m = String(monthDayStr || '').match(/^([A-Za-z.]+)\s+(\d{1,2})(?:,?\s+(\d{4}))?$/);
  if (!m) return null;
  const month = MONTHS[m[1].toLowerCase()];
  if (month === undefined) return null;
  const day = parseInt(m[2], 10);
  const ref = referenceDate instanceof Date ? referenceDate : new Date(referenceDate);
  if (!Number.isFinite(ref.getTime())) return null;
  // Reject impossible calendar days ("February 30") instead of letting
  // Date.UTC normalize them into March (Codex ship-check finding).
  const validDay = (y) => {
    const d = new Date(Date.UTC(y, month, day));
    return d.getUTCMonth() === month && d.getUTCDate() === day;
  };
  if (m[3]) {
    const y = parseInt(m[3], 10);
    if (!validDay(y)) return null;
    const d = new Date(Date.UTC(y, month, day));
    const diffMonths = (d - ref) / (30 * 86400000);
    if (diffMonths < minMonths || diffMonths > maxMonths) return null;
    return d.toISOString().split('T')[0];
  }
  // No explicit year: pick the candidate year closest to the reference, then
  // require it inside [-9mo, +15mo] of the article date.
  // Window-filter FIRST, then take the closest survivor — closest-first
  // would resolve "January 5" from a December article forward even when the
  // field's window says the date must lie in the past.
  const candidates = [ref.getUTCFullYear() - 1, ref.getUTCFullYear(), ref.getUTCFullYear() + 1]
    .filter(validDay)
    .map((y) => new Date(Date.UTC(y, month, day)))
    .filter((d) => {
      const diffMonths = (d - ref) / (30 * 86400000);
      return diffMonths >= minMonths && diffMonths <= maxMonths;
    })
    .sort((a, b) => Math.abs(a - ref) - Math.abs(b - ref));
  if (candidates.length === 0) return null;
  return candidates[0].toISOString().split('T')[0];
}

function extractOpeningFactsFromArticle(text, referenceDate) {
  const t = String(text || '').replace(/\s+/g, ' ');
  const facts = { previewsStartDate: null, openingDate: null, closingDate: null };
  // Per-field direction windows (QA ship-check finding): previews began
  // BEFORE the roundup ran; the roundup runs AT opening; the run continues
  // THROUGH a future date. Closest-year alone picks the wrong side of a
  // year boundary for previews/closing.
  // Tense picks the direction: "began previews" is past, "begins previews"
  // is an announcement of a near-future date.
  const prevPast = t.match(new RegExp(`began\\s+previews\\s+(?:on\\s+)?${MONTH_DAY}`, 'i'));
  const prevFuture = !prevPast && t.match(new RegExp(`begins?\\s+previews\\s+(?:on\\s+)?${MONTH_DAY}`, 'i'));
  if (prevPast) facts.previewsStartDate = resolveDate(prevPast[1], referenceDate, { windowMonths: [-15, 0.2] });
  else if (prevFuture) facts.previewsStartDate = resolveDate(prevFuture[1], referenceDate, { windowMonths: [-0.2, 4] });
  const open = t.match(new RegExp(
    `(?:officially\\s+open(?:s|ed|ing)?|open(?:s|ed)\\s+officially|opening\\s+(?:is\\s+set\\s+for|night\\s+(?:is|was)))\\s+(?:on\\s+)?${MONTH_DAY}`, 'i'
  ));
  if (open) facts.openingDate = resolveDate(open[1], referenceDate, { windowMonths: [-2, 2] });
  const close = t.match(new RegExp(`(?:continue|run(?:s|ning)?|performances)[^.]{0,80}?through\\s+${MONTH_DAY}`, 'i'));
  if (close) facts.closingDate = resolveDate(close[1], referenceDate, { windowMonths: [-1, 15] });
  return facts;
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
        statusByVariant.get(v).push({ id: s.id || s.slug || null, status: s.status || null, closingDate: s.closingDate || null });
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
  // Possessive lead-ins ("Cat Cohen's Broad Strokes" for "Cat Cohen: Broad
  // Strokes") only differ by an 's — try the stripped variant too, so a
  // Playbill-style headline can't false-positive as a missing show.
  const cands = titleCandidates(title);
  if (cands.length > 1 && titleMatchesIndexSingle(cands[1], index, opts)) return true;
  return titleMatchesIndexSingle(cands[0], index, opts);
}

function titleMatchesIndexSingle(title, index, opts = {}) {
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
      if (!padded.includes(` ${t} `)) continue;
      if (!allowClosedRevival) return true;
      // Same all-closed rule as the exact path above — otherwise a long
      // headline ("What Did Critics Think Of THE GIN GAME Revival?") would
      // suppress the very revival this option exists to surface.
      const entries = (index.statusByVariant && index.statusByVariant.get(t)) || [];
      const allClosed = entries.length > 0 && entries.every((e) => e.status === 'closed');
      if (!allClosed) return true;
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
  extractShowTitleFromPlaybillRoundup,
  isPlaybillNonNycRoundup,
  titleCandidates,
  resolveMatchedShowId,
  extractOpeningFactsFromArticle,
  resolveDate,
  isBwwNonStageTieIn,
  isBwwNonNycRoundup,
  titleFromDtliSlug,
  titleVariants,
  buildShowTitleIndex,
  titleMatchesIndex,
  findUnmatchedCandidates,
  candidateKey,
};
