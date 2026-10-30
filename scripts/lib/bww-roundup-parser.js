/**
 * bww-roundup-parser.js — extract "Critic, Outlet:" pairs from BWW Review Roundup articleBody.
 *
 * Inline regex previously lived in gather-reviews.js (Method 2 path) and a tighter
 * variant in extract-bww-reviews.js. The first-word slot did not allow a leading
 * single-letter initial, so "J. Kelly Nestruck, The Globe and Mail: ..." was
 * captured as "Kelly Nestruck" — silently dropping the "J." byline. The same
 * pattern affected at least one Globe and Mail roundup entry in production data
 * (the-prom-2018, paradise-square-2022, beautiful-the-carole-king-musical-2014,
 * proof-2026). See feedback_critic_name_initial_truncation.md.
 *
 * The leading-initial slot is `(?:[A-Z]\.\s+)?` — it captures one initial+dot
 * followed by whitespace. Names like "K.T. Sullivan" (no space between initials)
 * remain unhandled by design — adding multi-initial support invites broader
 * false positives and they don't appear in the current corpus.
 */

const { normalizeBylineCapture } = require('./byline-normalization');
const { foldDiacritics } = require('./url-slug');

// Latin-1 accented letters are allowed so "José Solís" / "Zoë Wanamaker" parse;
// an ASCII-only class dropped the whole entry and merged its quote into the
// previous critic's excerpt (BRO-733).
// The lookahead refuses a capital glued onto the next capitalized word: BWW
// ran EW's "Grade: B" into "Caitlin Hornik, The Independent:", and "BCaitlin
// Hornik" became a second Independent critic that double-counted (BRO-6585).
// "McDonald"/"LaChanze" are unaffected (their 2nd letter is lowercase); a 2nd
// letter "I" is allowed because BWW often mistypes l as I ("MIchael Dale").
const NAME_WORD = "[A-ZÀ-ÖØ-Þ](?![A-HJ-ZÀ-ÖØ-Þ][a-zà-öø-ÿ])[a-zA-ZÀ-ÖØ-öø-ÿ'’\\-]+";
// Single space between leading initial and first name. The lookbehind sits
// INSIDE the optional group so it only constrains the leading-initial branch:
// when no leading initial is present (the common case), the rest of the
// pattern is allowed to start right after a sentence-ending period (e.g.
// "...House.David Finkle, NYSR:"). When a leading initial IS present, the
// lookbehind blocks fragments like "World War II.", "U.K.", "AIDS.", "D.C."
// from being absorbed as the next critic's first initial.
const LEADING_INITIAL = "(?:(?<![A-Z.])[A-Z]\\. )?";
const WORD_SEP = "\\s+";
const MIDDLE_INITIAL = `(?:${WORD_SEP}[A-Z]\\.?)?`;
const NAME_CAPTURE = `${LEADING_INITIAL}${NAME_WORD}${MIDDLE_INITIAL}${WORD_SEP}${NAME_WORD}(?:${WORD_SEP}${NAME_WORD})?`;
// Same shape as NAME_CAPTURE but anchored — "is this string, entire, a byline?"
const WHOLE_NAME_RE = new RegExp(`^${NAME_CAPTURE}$`);

// A byline always begins at an ENTRY boundary. BWW's articleBody separates
// entries with a RUN of 2+ whitespace, so that run — not the regex's own match
// start — is the authoritative anchor for where a critic's name begins.
const BLOCK_SEPARATOR = /\s{2,}/g;

/**
 * Re-anchor a captured byline to its entry boundary.
 *
 * Two independent failures both come from trusting the regex's match start:
 *
 *  1. OVER-CAPTURE — `\s+` between name words spans the entry separator, so the
 *     last word of the PRECEDING sentence is absorbed as the critic's first
 *     name. Confirmed live 2026-08-01 on Review-Roundup-THE-COMEDY-ABOUT-SPIES-2026:
 *     "...Photo credit: Mark Senior     Franco Milazzo, BroadwayWorld: ..." made
 *     the PHOTOGRAPHER's surname the byline's first word, minting a phantom
 *     second BroadwayWorld critic ("Senior     Franco Milazzo") with no URL —
 *     so same-URL dedup could not collapse it and the review double-counted.
 *     An archive sweep found 18 more ("Zimmerman  Jesse Green", "Glikas  Jesse
 *     Green", "Murray  Alexander Cohen"), all photo-credit surnames.
 *
 *  2. UNDER-CAPTURE — NAME_LOOKAHEAD is deliberately 2 words (see its comment),
 *     so for a THREE-word byline the preceding quote stops one word late and the
 *     next match starts mid-name. "Melissa Rose Bernardo, New York Stage Review"
 *     parsed as "Rose Bernardo" on chess-2025, chess-1988 and
 *     real-women-have-curves-2025 — a wrong critic name, and a wrong filename
 *     slug on any file written from it.
 *
 * Anchoring on the separator fixes both: take the text from the end of the last
 * 2+ whitespace run before the comma, and use it when it is itself a complete
 * name. A merely cosmetic double space INSIDE a real byline ("Peter  Marks",
 * "Elisabeth  Vincentelli" in the-addams-family-2010) leaves a 1-word remainder,
 * which fails the whole-name test, so the original capture is kept and
 * normalizeBylineCapture collapses its whitespace.
 *
 * @param {string} text - the body being scanned
 * @param {number} nameStart - index where the regex began its name capture
 * @param {string} captured - the raw capture group
 * @returns {string} the entry-anchored name, or `captured` when no boundary applies
 */
function anchorNameToEntryBoundary(text, nameStart, captured) {
  if (!captured) return captured;
  const nameEnd = nameStart + captured.length;
  // Look BACK past the capture start, not just inside it. The separator sits
  // before the capture in the under-capture case (the 2-word lookahead started
  // the match mid-name) and inside it in the over-capture case. LOOKBACK_CHARS
  // bounds the scan: a byline is at most 3 words, so a separator farther back
  // than this could only yield a candidate that WHOLE_NAME_RE rejects anyway.
  const LOOKBACK_CHARS = 100;
  const windowStart = Math.max(0, nameStart - LOOKBACK_CHARS);
  const segment = text.slice(windowStart, nameEnd);
  BLOCK_SEPARATOR.lastIndex = 0;
  let lastSepEnd = -1;
  let m;
  while ((m = BLOCK_SEPARATOR.exec(segment)) !== null) {
    lastSepEnd = m.index + m[0].length;
  }
  if (lastSepEnd === -1) return captured;
  const candidate = segment.slice(lastSepEnd).trim();
  // Only re-anchor when what follows the separator is a complete name on its
  // own. Otherwise the run was intra-name whitespace, not an entry boundary.
  return WHOLE_NAME_RE.test(candidate) ? candidate : captured;
}
// Lookahead is intentionally less greedy than the capture: it requires only
// the minimum 2-word name shape so the [^]+? quote ends at the EARLIEST plausible
// boundary. If the lookahead also allowed an optional 3rd word, "...Leap of
// Faith Joe Dziemianowicz, New York Daily News:" would let the previous quote
// end before "Faith" and the next match would absorb "Faith Joe Dziemianowicz"
// as one critic name. Mirrors the original two-word boundary pre-fix.
const NAME_LOOKAHEAD = `${LEADING_INITIAL}${NAME_WORD}${MIDDLE_INITIAL}${WORD_SEP}${NAME_WORD}`;
// Optional leading digit-group so digit-prefixed outlet names like
// "1 Minute Critic" or "20 Something Theatre" parse. Requires a whitespace
// separator after the digits, so "5th Estate" (no space) is deliberately NOT
// handled — no such outlet exists in the corpus today, and expanding the
// class would raise false-positive risk. Without this optional prefix, the
// whole entry silently dropped AND its quote was absorbed into the previous
// outlet's quote (the "Matthew Wexler, 1 Minute Critic:" miss). Body still
// requires letters-only, so a stray number ending the prior quote can't be
// misread — but see the digit-outlet regression tests for the boundary
// case of "10 Downing Street:" appearing WITHIN a critic quote.
// Digits are allowed only glued to the end of a letter ("NY1", BRO-733); before,
// "Helen Shaw, NY1:" never matched. A space-separated number ("age 35") must
// stay out, or "Star Daniel Radcliffe, age 35:" inside a quote becomes a fake
// critic entry and truncates the quote.
const OUTLET = "(?:[0-9]+\\s+)?[A-Za-z][A-Za-z\\s&'.]+(?:(?<=[A-Za-z])[0-9]{1,2})?";
// BWW's CMS emits a stray space before the comma on some entries — the live
// SPIES-2026 body carries "Ryan Gilbey , The Guardian:" and
// "Holly O'Mahony , The Stage:" alongside comma-tight siblings. The old
// name-then-literal-comma pattern silently dropped BOTH of those critics (6 of
// 8 parsed). `\s*` before the comma is safe: NAME_CAPTURE cannot end mid-word,
// so nothing new can be absorbed.
const PRE_COMMA = "\\s*";
// Terminator for the LAST critic's quote. BWW writes "Photo credit:" (lower-case
// c); the old literal "Photo Credit:" never matched, so a trailing photo credit
// was swallowed into the final quote. Match either casing, singular or plural.
const TAIL_TERMINATOR = "[Pp]hoto [Cc]redits?:";

const CRITIC_OUTLET_PATTERN = new RegExp(
  `(${NAME_CAPTURE})${PRE_COMMA},\\s+(${OUTLET}):\\s*([^]+?)(?=(?:${NAME_LOOKAHEAD}${PRE_COMMA},\\s+${OUTLET}:)|${TAIL_TERMINATOR}|$)`,
  'g'
);

/**
 * Extract critic/outlet/excerpt triples from a BWW Review Roundup articleBody.
 * Caller is responsible for outlet normalization and dedup.
 *
 * @param {string} articleBody - raw articleBody string from BWW JSON-LD
 * @returns {Array<{criticName: string, outletRaw: string, quote: string}>}
 */
function parseArticleBodyReviews(articleBody) {
  if (!articleBody) return [];

  const reviewStart = articleBody.indexOf("Let's see what the critics had to say");
  const text = reviewStart > 0 ? articleBody.substring(reviewStart) : articleBody;

  const out = [];
  const seen = new Set();
  CRITIC_OUTLET_PATTERN.lastIndex = 0;
  let match;
  while ((match = CRITIC_OUTLET_PATTERN.exec(text)) !== null) {
    // Route through the shared byline normalizer (collapses internal whitespace,
    // strips page-chrome tokens, title-cases ALL-CAPS bylines) so this parser
    // can never be the origin of a raw-capture criticName. Previously the
    // roundup path was the ONE byline writer that bypassed it.
    const criticName = normalizeBylineCapture(
      anchorNameToEntryBoundary(text, match.index, match[1])
    );
    const outletRaw = match[2].trim();
    const quote = match[3].trim();

    if (outletRaw.length < 2 || outletRaw.length > 60) continue;
    if (/^(In|The|A|An|On|At|For|With|And|But|Or|If|So|As|By)$/i.test(outletRaw)) continue;

    const key = `${criticName.toLowerCase()}|${outletRaw.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({ criticName, outletRaw, quote });
  }
  return out;
}

// ---------------------------------------------------------------------------
// BRO-3504: anchor -> critic matching for the roundup page's outlet links.
//
// extractBWWRoundupReviews used to hand out each outlet's anchor hrefs in
// plain document order. For a multi-critic outlet (NYSR, NYT, TimeOut) whose
// anchors appear in a different order from the order the critics were
// discovered (JSON-LD first, then articleBody), critic A silently received
// critic B's link. BWW writes each entry as `<p>Critic Name, <a href>Outlet:</a>
// quote</p>`, so the name sitting immediately before the anchor tells us whose
// link it is. The functions below capture that name and pick candidates by it,
// falling back to document order only when there is no name signal.
// ---------------------------------------------------------------------------

// Tags that start a new roundup entry; text before the last one in the window
// belongs to a different entry. A closing </a> is NOT a boundary: BWW often
// links the critic's name itself ("<p><a href=/people/Jesse-Oxfeld/>Jesse
// Oxfeld</a>, <a href=...>New York Stage Review:</a>"), and that name counts.
const ENTRY_BOUNDARY_TAG = /<(?:\/?p|br|\/?li|\/?div|\/?h[1-6]|\/?td|\/?tr)\b[^>]*>/gi;
// Leading "Critic Name," with nothing else in the entry before the anchor.
const NAME_BEFORE_ANCHOR = new RegExp(`^(${NAME_CAPTURE})\\s*,\\s*$`);

function decodeBasicEntities(s) {
  return s
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#39;|&#x27;|&apos;|&rsquo;|&#8217;/gi, "'");
}

/**
 * The critic name written immediately before an anchor in the roundup HTML
 * ("<p>Frank Scheck, <a ...>"), or null when the entry text before the anchor
 * is not exactly a "Name," lead-in.
 *
 * @param {string} html
 * @param {number} anchorIndex - offset of the anchor's `<a` in html
 * @returns {string|null}
 */
function criticNameBeforeAnchor(html, anchorIndex) {
  if (!html || !(anchorIndex > 0)) return null;
  let windowText = html.slice(Math.max(0, anchorIndex - 400), anchorIndex);
  let cut = 0;
  ENTRY_BOUNDARY_TAG.lastIndex = 0;
  let m;
  while ((m = ENTRY_BOUNDARY_TAG.exec(windowText)) !== null) cut = m.index + m[0].length;
  windowText = windowText.slice(cut);
  const text = decodeBasicEntities(windowText.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  const nm = text.match(NAME_BEFORE_ANCHOR);
  if (!nm) return null;
  const name = normalizeBylineCapture(nm[1]);
  return name || null;
}

/**
 * Scan the roundup HTML for outlet anchors, in document order, deduped per
 * outlet by href. Same filters the inline scan in gather-reviews.js used
 * (external links only, anchor text 3-60 chars that resolves to an outlet).
 *
 * @param {string} html
 * @param {(text: string) => (string|null)} outletIdFor - outlet normalizer
 * @returns {Record<string, Array<{href: string, criticName: string|null}>>}
 */
function scanRoundupOutletAnchors(html, outletIdFor) {
  const byOutlet = {};
  if (!html) return byOutlet;
  const anchorRe = /<a\s[^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)<\/a>/gi;
  let aMatch;
  while ((aMatch = anchorRe.exec(html)) !== null) {
    const href = aMatch[1];
    const text = aMatch[2].replace(/:$/, '').trim();
    if (href.includes('broadwayworld.com') || text.length < 3 || text.length > 60) continue;
    const oid = outletIdFor(text);
    if (!oid) continue;
    if (!byOutlet[oid]) byOutlet[oid] = [];
    const existing = byOutlet[oid].find((e) => e.href === href);
    const criticName = criticNameBeforeAnchor(html, aMatch.index);
    if (existing) {
      if (!existing.criticName && criticName) existing.criticName = criticName;
      continue;
    }
    byOutlet[oid].push({ href, criticName });
  }
  return byOutlet;
}

function nameTokens(name) {
  if (!name || typeof name !== 'string') return [];
  return foldDiacritics(normalizeBylineCapture(name) || '')
    .toLowerCase()
    .replace(/[^a-z]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
}

/**
 * Loose same-person check for two critic names: identical after folding,
 * same surname with the same first initial, or one name's tokens all present
 * in the other with the same surname ("Rose Bernardo" / "Melissa Rose
 * Bernardo", "Kelly Nestruck" / "J. Kelly Nestruck"). "Bob Verini" /
 * "Robert Verini" does NOT match and falls back to positional order.
 */
function criticNamesMatch(a, b) {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.length < 2 || tb.length < 2) return false;
  if (ta.join(' ') === tb.join(' ')) return true;
  if (ta[ta.length - 1] !== tb[tb.length - 1]) return false;
  if (ta[0][0] === tb[0][0]) return true;
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  return shorter.length < longer.length && shorter.every((t) => longer.includes(t));
}

/**
 * Whether Method 1 should leave this review's URL for the Method 2 pass.
 * True for a slot with no usable critic name (null / "Unknown") at an outlet
 * whose articleBody names critics: Method 2 renames such a slot to one of
 * those critics, so a URL picked now (by position, before the slot has a
 * name) would be paired with whichever critic it is later renamed to.
 *
 * @param {string|null} criticName - the review's critic so far
 * @param {string[]} rosterNames - prescanned articleBody critics at the outlet
 * @returns {boolean}
 */
function shouldDeferRoundupUrl(criticName, rosterNames) {
  return nameTokens(criticName).length < 2 && Array.isArray(rosterNames) && rosterNames.length > 0;
}

/**
 * Per-outlet roster of every critic the roundup names, gathered BEFORE any URL
 * is handed out (BRO-3504 follow-up). Method 1 (JSON-LD) assigns URLs before
 * Method 2 (articleBody) has added its critics, so a roster built only from
 * the reviews found so far let a nameless / unmatched JSON-LD slot take the
 * named anchor of a critic Method 2 finds later.
 *
 * @param {Array<{outletId: string|null, criticName: string|null}>} critics
 * @returns {Record<string, string[]>} outletId -> distinct critic names
 */
function buildOutletRoster(critics) {
  const roster = {};
  for (const c of critics || []) {
    if (!c || !c.outletId || !c.criticName || nameTokens(c.criticName).length < 2) continue;
    const list = roster[c.outletId] || (roster[c.outletId] = []);
    if (!list.some((n) => n === c.criticName)) list.push(c.criticName);
  }
  return roster;
}

/**
 * Decide which of an outlet's roundup anchors a review may take, in try order.
 * Pure: the caller validates each candidate and marks consumed indices.
 *
 *  1. Anchors whose lead-in name matches this critic. When any exist, ONLY
 *     these are returned: the critic's own link is known, so a rejected one
 *     must leave the critic url-less rather than take someone else's link.
 *  2. Otherwise, anchors with no name signal, in document order.
 *  3. Then anchors named for someone not in `rosterNames` (the outlet's other
 *     known critics), in document order -- the pre-BRO-3504 positional
 *     fallback, kept for name-spelling variants. Anchors named for another
 *     roster critic are never offered.
 *
 * @param {Array<{href: string, criticName: string|null}>} entries - outlet anchors, doc order
 * @param {Set<number>} consumed - indices already handed out or rejected
 * @param {string|null} criticName - the review's critic, if known
 * @param {Array<string|null>} [rosterNames] - other critics at this outlet
 * @returns {number[]} indices into entries
 */
function orderAnchorCandidates(entries, consumed, criticName, rosterNames = []) {
  const open = [];
  (entries || []).forEach((e, i) => { if (!consumed || !consumed.has(i)) open.push(i); });
  if (criticName) {
    const own = open.filter((i) => entries[i].criticName && criticNamesMatch(entries[i].criticName, criticName));
    if (own.length > 0) return own;
  }
  const others = (rosterNames || []).filter((n) => n && !(criticName && criticNamesMatch(n, criticName)));
  const unnamed = open.filter((i) => !entries[i].criticName);
  const strangers = open.filter((i) => entries[i].criticName
    && !others.some((n) => criticNamesMatch(entries[i].criticName, n)));
  return unnamed.concat(strangers);
}

module.exports = {
  parseArticleBodyReviews,
  criticNameBeforeAnchor,
  scanRoundupOutletAnchors,
  criticNamesMatch,
  orderAnchorCandidates,
  buildOutletRoster,
  shouldDeferRoundupUrl,
  CRITIC_OUTLET_PATTERN,
};
