/**
 * Pull Quote Guards — pure decision helpers for extract-pull-quotes.js.
 *
 * Extracted per CLAUDE.md §15 (Test Extraction Pattern): never copy logic
 * into test files; require the real function.
 */

// Sentences that start with a hedging connector — "But", "Yet", "Still",
// "Though", "Although", "However", "Despite", "While" — usually introduce
// a reservation or caveat. When the surrounding review is positive overall,
// picking one of these as the pull quote makes the critic look ambivalent
// even when they weren't. NYT critics especially structure reviews with a
// middle-paragraph caveat before a positive closer — the LLM reliably picks
// the caveat as "most quotable".
const HEDGE_OPENER_RE = /^\s*(but|yet|still|though|although|however|despite|while)\b/i;

// Mid-sentence pivots like ", but", ", yet", ", though" on a positive review
// almost always swing the reader from praise to reservation. E.g. Helen Shaw
// on Giant: "I found Lithgow's performance a fascinating study in monstrosity,
// but I found myself more engaged by the conversations I've had since seeing
// 'Giant'" — reads as a withdrawal of endorsement on a 77-scoring review.
const MID_SENTENCE_PIVOT_RE = /,\s+(but|yet|though|although|however|despite)\b/i;

// A candidate outside this range is rejected: too short to stand alone out of
// context ("Yes, they're spectacular!" — real, on-topic, but only 25 chars),
// or too long to read as a pull quote.
const MIN_QUOTE_LENGTH = 30;
const MAX_QUOTE_LENGTH = 300;

/**
 * Is this candidate too short or too long to ship as a pull quote?
 * extract-pull-quotes.js retries once with a hint before giving up on a
 * length rejection — see processReview()'s length-check branch — instead of
 * falling through to the raw-fullText heuristic scrape (Les Mis Arena
 * Concert / Cititour, card em-20260801-000455).
 */
function isBadCandidateLength(quote) {
  if (!quote || typeof quote !== 'string') return false;
  return quote.length < MIN_QUOTE_LENGTH || quote.length > MAX_QUOTE_LENGTH;
}

/**
 * Does this sentence open with a hedge word? Case-insensitive, tolerates
 * leading quote marks (some LLM responses are wrapped in quotes the caller
 * didn't strip).
 */
function isHedgeOpener(quote) {
  if (!quote || typeof quote !== 'string') return false;
  // Strip leading straight/curly quotes so '"But..."' still trips the guard.
  const cleaned = quote.replace(/^[\s"\u201C\u2018'`]+/, '');
  return HEDGE_OPENER_RE.test(cleaned);
}

/**
 * Does this sentence contain a mid-sentence reservation pivot?
 */
function hasMidSentencePivot(quote) {
  if (!quote || typeof quote !== 'string') return false;
  return MID_SENTENCE_PIVOT_RE.test(quote);
}

/**
 * Should we reject this quote as misaligned with the review's verdict?
 *
 * Rule: if the review's overall score is positive (>= 70) and the quote
 * opens with a hedging connector, it's almost always a middle-paragraph
 * reservation rather than the critic's endorsement. Reject so the caller
 * can retry with a stronger hint.
 *
 * For mixed (40-69) and negative (< 40) reviews, hedge openers are often
 * legitimate ("Still, the show never finds its footing") so we don't block.
 *
 * `score` can be null/undefined — in that case we don't have a verdict
 * signal and we let the quote through (old behavior).
 */
function shouldRejectAsReservation(quote, score) {
  if (score == null) return false;
  if (typeof score !== 'number' || Number.isNaN(score)) return false;
  if (score < 70) return false;
  if (isHedgeOpener(quote)) return true;
  if (hasMidSentencePivot(quote)) return true;
  return false;
}

// Bug #11: Internal-note excerpts (e.g. "[INTERNAL: score needs review]", "Note: ...")
// These are editorial notes that accidentally end up in the pullQuote field.
function isInternalNote(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  const trimmed = excerpt.trimStart();
  if (trimmed.startsWith('[')) return true;
  if (/\[INTERNAL\b/i.test(excerpt)) return true;
  if (/\[NOTE\b/i.test(excerpt)) return true;
  return false;
}

// Bug #14: Copyright/subscribe chrome patterns that leak from web scraping.
const COPYRIGHT_CHROME_PATTERNS = [
  /all rights reserved/i,
  /subscribe to/i,
  /\u00A9 20\d\d/,    // © 20xx (unicode © sign)
  /\(c\) 20\d\d/i,    // (c) 20xx fallback
  /read more at/i,
  /click here to/i,
  /\bsign up\b/i,
  /\bnewsletter\b/i,
  // Affiliate / reader-funding disclaimers that lead many outlet pages
  // (Evening Standard: "When you purchase through links on our site, we may
  //  earn an affiliate commission." / "The Standard's journalism is supported
  //  by our readers."). War Horse 2026-06-07.
  /affiliate commission/i,
  /purchase through links/i,
  /through links on our site/i,
  /journalism is supported by/i,
  /supported by our readers/i,
  /we may earn a/i,
];

function hasCopyrightChrome(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  return COPYRIGHT_CHROME_PATTERNS.some(re => re.test(excerpt));
}

// Promo-teaser guard (2026-07-14, Whoopi Monologues audit): New York Theatre
// Guide / London Theatre articles OPEN with an SEO standfirst ("Read our
// review of <show>, now in performances at <venue>...") that gets scraped
// into fullText as its first narrative-shaped sentence. It sailed past every
// excerpt guard (5+ words, ends with a period, uppercase start, theater
// vocabulary) and shipped as the displayed pull quote on 6 shows. These
// patterns are START-anchored (after optional wrapping quotes/whitespace) —
// a critic writing "...you should read our review" mid-sentence is untouched.
// Parity-tested against all 18,763 live pull quotes: exactly the 6 known-bad
// teasers match, zero false positives.
const PROMO_TEASER_PATTERNS = [
  /^[\s"'“”‘’«»`(\[]*read\s+(?:our|the|my)\s+(?:full\s+)?review\b/i,
  /^[\s"'“”‘’«»`(\[]*(?:book|buy|get|find|grab)\s+(?:your\s+)?tickets?\b/i,
  /^[\s"'“”‘’«»`(\[]*tickets?\s+(?:from|start|are\s+on\s+sale|on\s+sale)\b/i,
  /^[\s"'“”‘’«»`(\[]*(?:follow\s+us|click\s+here|learn\s+more\s+about)\b/i,
];

function isPromoTeaser(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  return PROMO_TEASER_PATTERNS.some(re => re.test(excerpt));
}

// ---------------------------------------------------------------------------
// Listing / credits chrome (2026-08-01, owner report on Tao of Glass).
//
// British Theatre Guide (and several other UK outlets) lead every review page
// with a one-line production-credits + venue + run-dates block terminated by
// "Listing details and ticket info". Because it carries NO newline, the
// line-based stripLeadingChrome below cannot see it, and the block is
// sentence-shaped enough to survive extractExcerptFromFullText's filters. It
// shipped as the displayed quote:
//   "Philip Glass and Phelim McDermott Factory International, Improbable and
//    Nica Burns @sohoplace theatre 24 July–12 September 2026. Listing details
//    and ticket info... Tao of Glass finally makes it to London after..."
//
// Two mechanisms, both needed:
//   stripListingPrelude() — removes the block from raw text before extraction
//   hasListingChrome()    — rejects any candidate that still carries it
// ---------------------------------------------------------------------------

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December';

// The BTG-style boilerplate terminator. Deliberately literal: this exact
// phrase is site furniture, never critic prose.
const LISTING_TERMINATOR_RE = /\blisting details and ticket info\b\.{0,3}/i;

// A venue-and-run-dates block: "@sohoplace theatre 24 July–12 September 2026",
// "at the Duke of York's Theatre, 3 March – 12 June 2026". Requires BOTH a
// day-number + month AND a second month + year, so a critic writing "opened in
// March" or "runs to September" is untouched.
const RUN_DATES_RE = new RegExp(
  `\\b\\d{1,2}\\s+(?:${MONTHS})\\s*[–—-]\\s*\\d{1,2}\\s+(?:${MONTHS})\\s+20\\d\\d`,
  'i'
);

const LISTING_CHROME_PATTERNS = [
  LISTING_TERMINATOR_RE,
  RUN_DATES_RE,
  // "Tickets from £45. Booking until 12 September 2026."
  /\bbooking (?:until|to|through)\s+\d{1,2}\s+\w+\s+20\d\d/i,
  // Runtime furniture: "Running time: 1 hour 40 minutes, no interval"
  /\brunning time:?\s*\d+\s*(?:hour|hr|minute|min)/i,
];

function hasListingChrome(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  return LISTING_CHROME_PATTERNS.some(re => re.test(excerpt));
}

/**
 * Remove a leading listing/credits prelude from raw review text.
 *
 * Only strips when the boilerplate terminator appears near the START of the
 * text (within `maxPreludeChars`) — a critic quoting listing language 3,000
 * chars in is left alone. Returns the input unchanged when no prelude is found,
 * so it is safe to call unconditionally.
 *
 * @param {string} text
 * @param {object} [opts]
 * @param {number} [opts.maxPreludeChars=500] How far in the terminator may sit
 * @returns {string}
 */
function stripListingPrelude(text, opts = {}) {
  if (!text || typeof text !== 'string') return text;
  const maxPreludeChars = opts.maxPreludeChars != null ? opts.maxPreludeChars : 500;

  const m = LISTING_TERMINATOR_RE.exec(text);
  if (!m) return text;
  const end = m.index + m[0].length;
  if (m.index > maxPreludeChars) return text;

  // The terminator alone is not enough. A critic could write "The programme's
  // listing details and ticket info are more lucid than the production" — and
  // stripping there would delete their opening verdict (Codex adversarial
  // review, 2026-08-01). Require the text BEFORE the terminator to actually
  // look like a listing block: run dates, a venue @handle, or credits-style
  // prose with no sentence punctuation at all. Real criticism has periods.
  // The no-punctuation branch additionally requires the prelude to be
  // SUBSTANTIAL. A short lead-in like "The programme's " has no period either,
  // but it is the start of a sentence, not a credits block. Real listing
  // preludes carry a full credits + venue run (BTG's is ~110 chars).
  const prelude = text.slice(0, m.index);
  const preludeIsListing =
    RUN_DATES_RE.test(prelude) ||
    /@\w+\s*(theatre|theater)/i.test(prelude) ||
    (prelude.length >= 60 && !/[.!?]/.test(prelude));
  if (!preludeIsListing) return text;

  const remainder = text.slice(end).replace(/^[\s.…]+/, '');
  // Never strip everything — if the prelude is (almost) the whole text, the
  // caller is better off with the original than with a two-word husk.
  if (remainder.length < 100) return text;
  return remainder;
}

// ---------------------------------------------------------------------------
// Tag-cloud excerpts (2026-08-01). The Reviews Hub renders its per-review tag
// list adjacent to the headline, and the LLM pull-quote extractor swallowed the
// whole run on A Midsummer Night's Dream (WE 2026):
//   "Funny but unmagical A Midsummer Night's Dream Atri Banerjee Issam Al
//    Ghussain Jenny Rainford London Mary Malone Nadeem Islam Naomi Dawson
//    Olivier Huband Regent's Park Open Air Theatre Review Terique Jarrett
//    Theatre Tomás Palmer William Shakespeare"
//
// Signature: no sentence punctuation anywhere, and a long unbroken run of
// capitalised tokens. Both conditions are required — headline-style pull quotes
// ("Full-blooded production of an undernourished play") have no sentence
// punctuation either, but no capitalised run.
// ---------------------------------------------------------------------------

// Thresholds calibrated against the full 19,309-quote corpus. The first pass
// (10 words / run 5 / ratio 0.5) produced two false positives on legitimate
// short quotes that happen to be title- and name-heavy:
//   ew / Betrayal 2019:      'B+ "Tom Hiddleston, Charlie Cox, and Zawe Ashton command a smart, stripped down 'Betrayal'"'
//   musical-theatre-review:  "The Royal Shakespeare Company's My Neighbour Totoro is actual magic"
// A real tag list is far longer and its capitalised run is unbroken: the
// Reviews Hub case is 36 words with a 33-token run. At 20 words / run 10 the
// two false positives clear and the real tag list still fires — verified by
// `node scripts/audit-pull-quotes.js` over the whole corpus.
const TAG_CLOUD_MIN_WORDS = 20;
const TAG_CLOUD_MIN_CAP_RUN = 10;
const TAG_CLOUD_MIN_CAP_RATIO = 0.6;

function isTagCloudExcerpt(excerpt) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  const trimmed = excerpt.trim();
  // Any sentence punctuation means it is prose, not a tag list.
  if (/[.!?;:]/.test(trimmed)) return false;

  const words = trimmed.split(/\s+/).filter(Boolean);
  if (words.length < TAG_CLOUD_MIN_WORDS) return false;

  let capped = 0;
  let run = 0;
  let longestRun = 0;
  for (const w of words) {
    // Strip wrapping punctuation/quotes before testing the first letter.
    const core = w.replace(/^[^\p{L}]+/u, '');
    if (/^\p{Lu}/u.test(core)) {
      capped++;
      run++;
      if (run > longestRun) longestRun = run;
    } else {
      run = 0;
    }
  }
  if (longestRun < TAG_CLOUD_MIN_CAP_RUN) return false;
  return capped / words.length >= TAG_CLOUD_MIN_CAP_RATIO;
}

// ---------------------------------------------------------------------------
// Mid-word truncation (2026-08-01). The LLM pull-quote extractor sometimes
// emits a quote cut mid-word — Evening Standard on Teeth 'n' Smiles shipped
// "...with Phil Daniels one of the few sa" while the sibling keyPhrase held the
// complete sentence ("...one of the few saving graces as the casually
// exploitative manager Saraffian.").
//
// Detected by evidence, not by dictionary: the candidate is a prefix of some
// source text (fullText, a keyPhrase quote, an aggregator excerpt) and the very
// next character in that source is a letter. A legitimately short headline
// standfirst is never a mid-word prefix of its own source, so this has no
// false-positive surface by construction.
// ---------------------------------------------------------------------------

// Symbol key for the per-call normalized-sources cache (see isMidWordTruncation).
const NORMALIZED_SOURCES = Symbol('normalizedSources');

// Fold the punctuation that differs between an LLM's re-typing of a quote and
// the scraped source (curly vs straight quotes, en/em dashes, NBSP runs).
function normalizeForSourceMatch(s) {
  return String(s)
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is `excerpt` a mid-word truncation of any of `sourceTexts`?
 *
 * @param {string} excerpt
 * @param {string[]} sourceTexts  fullText / keyPhrase quotes / aggregator excerpts
 * @returns {boolean}
 */
function isMidWordTruncation(excerpt, sourceTexts) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  if (!Array.isArray(sourceTexts) || sourceTexts.length === 0) return false;

  // Strip wrapping quotes the LLM may have added, then drop a trailing ellipsis
  // (an explicit ellipsis is a deliberate elision, not an accidental cut).
  const cleaned = normalizeForSourceMatch(excerpt).replace(/^["']+|["']+$/g, '');
  if (/(\.\.\.|…)$/.test(cleaned)) return false;
  if (cleaned.length < 40) return false;
  // Ends in sentence punctuation → complete by construction.
  if (/[.!?]["']?$/.test(cleaned)) return false;

  // Normalizing a 5,000-char fullText once per CANDIDATE (and there are up to
  // ~9 candidates per review, across 19,309 reviews) was ~750MB of avoidable
  // string churn per rebuild — flagged in the 2026-08-01 Codex review. Cache
  // the normalized form on the caller's array so it is computed once per
  // review. Non-enumerable so the array still serializes/iterates normally.
  let normalized = sourceTexts[NORMALIZED_SOURCES];
  if (!normalized) {
    normalized = sourceTexts
      .filter(s => s && typeof s === 'string')
      .map(normalizeForSourceMatch);
    try {
      Object.defineProperty(sourceTexts, NORMALIZED_SOURCES, {
        value: normalized, enumerable: false, writable: true, configurable: true,
      });
    } catch (_) { /* frozen array — fall through, just uncached */ }
  }

  for (const hay of normalized) {
    const at = hay.indexOf(cleaned);
    if (at === -1) continue;
    const next = hay[at + cleaned.length];
    if (next && /\p{L}/u.test(next)) return true;
  }
  return false;
}

// Bug #13: Off-topic excerpt detection. Very loose — only fires when there are
// NO theater-domain words AND NO show-title keywords. False positives (blocking
// a real review) are worse than letting a bad excerpt through.
//
// No trailing \b on inflected base forms (act, perform, direct, danc, sing, stor)
// so that plurals/inflections match without listing every variant:
//   act → actor, actors, actress, acting, acts
//   perform → performance, performed, performing, performer
//   direct → director, directing, directed, direction
//   danc → dance, dances, dancing, dancer
//   sing → singer, singers, singing, sung, song
//   stor → story, stories
//   adapt → adaptation, adapted, adapting
const THEATER_DOMAIN_RE = /\b(?:perform|musical|stages?|act(?:or|ress|ing|s\b)?|direct(?:or|ion|ing|ed)?|cast|scene|theater|theatre|show(?:s\b)?|production|choreograph|danc|sing(?:er)?|song|script|lyric|revival|broadway|west[\s-]end|opening[\s-]night|curtain|audience|playwright|narrative|dramatic|stagecraft|ensemble|understudy|character|ticket|adaptation|adapt|stor[yi])/i;

function isOffTopicExcerpt(excerpt, showId) {
  if (!excerpt || typeof excerpt !== 'string') return false;
  // Any theater domain word → passes
  if (THEATER_DOMAIN_RE.test(excerpt)) return false;
  // Any show title keyword (from showId) → passes
  if (showId && typeof showId === 'string') {
    const titleWords = showId.split('-').filter(w => !/^\d{4}$/.test(w) && w.length >= 3);
    for (const word of titleWords) {
      try {
        if (new RegExp(`\\b${word}\\b`, 'i').test(excerpt)) return false;
      } catch (_) { /* ignore bad regex */ }
    }
  }
  return true;
}

// Bug #15: Page-chrome lines that leak into the assignedExcerpt fallback.
// Lost Boys 2026-04-26 Exeunt: "Review: The Lost Boys: The Musical at the
// Palace Theatre\nPalace Theatre ⋄ March 27, 2026-open-ended\nThis vampire
// musical succeeds...". Without a chrome-skip pass on the line-split text,
// "Review: ..." landed in the first "substantive" sentence and into the
// assignedExcerpt. These patterns identify lines that are header chrome,
// not review content.
const CHROME_LINE_PATTERNS = [
  // "Review: ...", "By Author", "Photo: Photographer", "Credit: ...",
  // "Venue: ...", "Production: ..."
  /^(Review|By|Photo|Credit|Venue|Production)\b/i,
  // NYTG/LondonTheatre SEO standfirst — "Read our review of <show>, now in
  // performances at <venue>..." leads the article body (Whoopi 2026-07-14).
  /^read\s+(?:our|the)\s+(?:full\s+)?review\b/i,
  // Cititour-style ticket CTA lines ("Tickets from $122", "Buy Tickets")
  /^(?:buy\s+tickets|tickets\s+from\s+\$)/i,
  // Just-a-name lines (byline or credit on its own line). Two-token Anglo
  // names; intentionally narrow — three-word/initial/hyphenated bylines
  // fall through to the ambiguous-line stop in stripLeadingChrome (we
  // don't risk over-stripping). Audit catches residual leakage.
  /^[A-Z][a-z]+\s+[A-Z][a-z]+\s*$/,
  // Venue line — 1-3 capitalized words (or "St", "The") followed by
  // Theatre/Theater/Hall/Auditorium/Playhouse. Catches "Palace Theatre",
  // "New Amsterdam Theatre", "Lincoln Center Theater", "St James Theatre".
  /^(?:(?:[A-Z][\w'.-]*|St\.?|The)\s+){1,3}(?:Theatre|Theater|Hall|Auditorium|Playhouse)\b/,
  // Date line MM/DD/YYYY or MM-DD-YYYY
  /^\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}/,
];

// A line that looks like the start of the actual review body. We stop the
// chrome skip here. Ambiguous starters that ALSO commonly start chrome
// lines were intentionally excluded:
//   "From the producers of..."     → marketing/preamble
//   "As performed by..."           → cast credit
//   "Now playing at the Booth..."  → venue announcement
//   "But"                          → mid-sentence pivot, almost never the
//                                    real opening of a review
// Including these would let chrome lines win the narrative classification
// and bypass the chrome-skip — see Codex review (Session C, P1).
const NARRATIVE_STARTER_RE = /^(In|The|This|It|A|An|At|On|With|When|Watching|There|We|If|Although|Despite|After|While|My|His|Her|Its|Their|Director|Writer|For)\s+/;

function isChromeLine(line) {
  if (line == null) return true;
  if (!line.trim()) return true; // blank
  return CHROME_LINE_PATTERNS.some(re => re.test(line));
}

function isNarrativeLine(line) {
  if (!line) return false;
  const trimmed = line.trim();
  const wordCount = trimmed.split(/\s+/).length;
  const endsSentence = /[.!?][""'""]?\s*$/.test(trimmed);
  if (wordCount >= 5 && endsSentence) return true;
  if (NARRATIVE_STARTER_RE.test(trimmed)) return true;
  return false;
}

/**
 * Skip leading page-chrome lines from fullText (header, byline, photo credit,
 * venue line, date line, blank lines) and return text starting from the first
 * narrative line, sliced to `maxLen`.
 *
 * Defense-in-depth fallback for selectBestExcerpt when upstream excerpt
 * sources (LLM keyPhrases, llmPullQuote, aggregator excerpts) are absent.
 *
 * Returns null when the heuristic would skip more than `maxSkipPct` of the
 * text — that signals the caller should use the raw fullText slice rather
 * than risk slicing in the wrong place.
 *
 * @param {string} fullText
 * @param {object} [opts]
 * @param {number} [opts.maxLen=600]     Max output length (chars)
 * @param {number} [opts.maxSkipPct=0.7] Max fraction of fullText the heuristic may skip
 * @returns {string|null}                Stripped text, or null on bail
 */
function stripLeadingChrome(fullText, opts = {}) {
  if (!fullText || typeof fullText !== 'string') return null;
  const maxLen = opts.maxLen != null ? opts.maxLen : 600;
  const maxSkipPct = opts.maxSkipPct != null ? opts.maxSkipPct : 0.7;

  const lines = fullText.split(/\r?\n/).map(l => l.trim());

  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Chrome FIRST — so a header line that happens to satisfy narrative
    // shape (e.g. "By Jesse Green for The New York Times." has 8 words +
    // ends with period and would otherwise be classified as narrative)
    // still gets stripped. Reordered per Codex review (Session C, P1).
    if (isChromeLine(line)) continue;
    if (isNarrativeLine(line)) { startIdx = i; break; }
    // Ambiguous line — neither chrome nor narrative. Stop here so we
    // don't over-skip and accidentally consume a real opening sentence.
    startIdx = i;
    break;
  }

  // No narrative line found anywhere — the heuristic can't help. Bail.
  if (startIdx === -1) return null;

  // No chrome detected — return the original slice (no-op).
  if (startIdx === 0) return fullText.slice(0, maxLen);

  const skippedChars = lines.slice(0, startIdx).join('\n').length;
  if (skippedChars / fullText.length > maxSkipPct) return null;

  const stripped = lines.slice(startIdx).join('\n').trim();
  return stripped.slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Candidate ranking (2026-08-01).
//
// The hedge-opener / mid-sentence-pivot guard and the lowercase-fragment guard
// were HARD rejects, which produced two bad outcomes on score>=70 reviews whose
// only good quote happens to be hedged:
//
//   - Body Count / Theater Scene: the (good) llmPullQuote "Body Count may not
//     function as a comprehensive treatise..., but it is undeniably electric as
//     a performance vehicle." was killed by the ", but" pivot, so selection fell
//     all the way through to a raw fullText slice that ended mid-word.
//   - Les Misérables Arena / Cititour: every candidate was soft-rejected, so the
//     review shipped with NO pull quote at all (owner report).
//
// Both guards are now SOFT: the candidate is deferred rather than dropped. A
// deferred candidate is used when the only alternative is a raw-fullText slice
// (rank >= rawSourceRank) or nothing at all. Hard rejects (internal notes,
// copyright/listing chrome, promo teasers, tag clouds, mid-word truncation,
// cross-show mentions) still drop the candidate outright.
//
// Source ranks — lower is better; must match the try-order in
// rebuild-all-reviews.js selectBestExcerpt().
const EXCERPT_SOURCE_RANK = {
  llmPullQuote: 0,
  keyPhrase: 1,
  keyQuote: 2,
  showScoreExcerpt: 3,
  bwwExcerpt: 4,
  nycTheatreExcerpt: 5,
  stagedoorExcerpt: 6,
  dtliExcerpt: 7,
  fullText: 8,
  'fullText-chrome-skip': 9,
};

// The first rank that is a raw scrape of the article body rather than a curated
// or LLM-selected quote. At or beyond this, a deferred higher-priority
// candidate is the better display choice.
const RAW_SOURCE_RANK = EXCERPT_SOURCE_RANK.fullText;

/**
 * Choose the excerpt to display from the accepted and deferred candidates.
 *
 * @param {object} args
 * @param {{rank:number, excerpt:string}|null} [args.accepted] First candidate that passed every guard
 * @param {Array<{rank:number, excerpt:string}>} [args.deferred] Soft-rejected candidates, any order
 * @param {number} [args.rawSourceRank=RAW_SOURCE_RANK]
 * @returns {string|null}
 */
function pickExcerptCandidate({ accepted = null, deferred = [], rawSourceRank = RAW_SOURCE_RANK } = {}) {
  const soft = (deferred || [])
    .filter(d => d && typeof d.excerpt === 'string' && d.excerpt)
    .slice()
    .sort((a, b) => a.rank - b.rank);

  // Only a HEDGE deferral may outrank an accepted raw-body slice. A hedge
  // deferral is a complete critic sentence that merely opens with "But"/"Yet"
  // or contains a ", but" pivot — still better prose than a page scrape.
  //
  // A LOWERCASE-FRAGMENT deferral is not: "and the score is sublime." reads as
  // broken mid-sentence text on the card, which is worse than a clean body
  // sentence that passed every guard (Codex adversarial review, 2026-08-01).
  // Fragments therefore only win when nothing at all was accepted.
  const bestHedgeAboveRaw = soft.find(d => d.rank < rawSourceRank && d.reason !== 'lowercase-fragment') || null;

  if (accepted && accepted.excerpt) {
    if (accepted.rank < rawSourceRank) return accepted.excerpt;
    return bestHedgeAboveRaw ? bestHedgeAboveRaw.excerpt : accepted.excerpt;
  }
  return soft.length ? soft[0].excerpt : null;
}

module.exports = {
  HEDGE_OPENER_RE,
  MID_SENTENCE_PIVOT_RE,
  MIN_QUOTE_LENGTH,
  MAX_QUOTE_LENGTH,
  isBadCandidateLength,
  isHedgeOpener,
  hasMidSentencePivot,
  shouldRejectAsReservation,
  isInternalNote,
  hasCopyrightChrome,
  isPromoTeaser,
  PROMO_TEASER_PATTERNS,
  isOffTopicExcerpt,
  COPYRIGHT_CHROME_PATTERNS,
  THEATER_DOMAIN_RE,
  CHROME_LINE_PATTERNS,
  NARRATIVE_STARTER_RE,
  isChromeLine,
  isNarrativeLine,
  stripLeadingChrome,
  // Listing / credits chrome
  LISTING_CHROME_PATTERNS,
  LISTING_TERMINATOR_RE,
  RUN_DATES_RE,
  hasListingChrome,
  stripListingPrelude,
  // Tag clouds
  isTagCloudExcerpt,
  // Mid-word truncation
  isMidWordTruncation,
  normalizeForSourceMatch,
  // Candidate ranking
  EXCERPT_SOURCE_RANK,
  RAW_SOURCE_RANK,
  pickExcerptCandidate,
};
