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

module.exports = {
  HEDGE_OPENER_RE,
  MID_SENTENCE_PIVOT_RE,
  isHedgeOpener,
  hasMidSentencePivot,
  shouldRejectAsReservation,
  isInternalNote,
  hasCopyrightChrome,
  isOffTopicExcerpt,
  COPYRIGHT_CHROME_PATTERNS,
  THEATER_DOMAIN_RE,
  CHROME_LINE_PATTERNS,
  NARRATIVE_STARTER_RE,
  isChromeLine,
  isNarrativeLine,
  stripLeadingChrome,
};
