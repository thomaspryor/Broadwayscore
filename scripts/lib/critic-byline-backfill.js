/**
 * BRO-7165: read the critic from the first ~300 chars (or closing credit) of a
 * review's stored fullText when criticName is Unknown / null / junk.
 *
 * Counted reviews showed "<Outlet> Staff" although the text names the critic
 * ("Speculations at Marylebone Theatre Jeremy Malies in central London ...").
 * Phase B of backfill-unknown-critics.js only knew ten outlets' credit lines
 * and Plays International's three London place names, so the rest fell through
 * to a page fetch that found no author and stamped "no-author" for 14 days.
 *
 * Pure functions, no I/O. A name is only ever returned when the text prints
 * it; nothing is guessed from the outlet, the url or the show.
 */

const { extractBylineFromText, printedPerson, PRINTED_NAME } = require('./byline-from-text');
const { isJunkCriticName } = require('./byline-recovery');

// Values that are labels, not people. isJunkCriticName covers CMS handles and
// "Written by" style labels; these are the plain-word placeholders.
const JUNK_BYLINE_WORDS = new Set([
  'unknown', 'unnamed', 'anonymous', 'staff', 'staff writer', 'staff reporter', 'staff critic',
  'written by', 'review by', 'reviewed by', 'posted by', 'by', 'admin', 'administrator', 'editor',
  'editorial', 'contributor', 'guest', 'guest author', 'news desk', 'n/a', 'none', 'null',
]);

/** True when `value` is empty or not a usable critic name (Unknown, "Written by", "Staff Writer", "X Staff"...). */
function isJunkBylineValue(value) {
  if (value == null) return true;
  const s = String(value).replace(/\s+/g, ' ').trim();
  if (!s) return true;
  if (JUNK_BYLINE_WORDS.has(s.toLowerCase())) return true;
  if (/\bstaff(?: writer| reporter)?$/i.test(s)) return true; // "Plays International Staff"
  return isJunkCriticName(s);
}

/** True when a stored criticName should be re-derived (missing or junk). */
function needsCriticBackfill(criticName) {
  return isJunkBylineValue(criticName);
}

// A surname must be a real word: "Lucy C" (first name and initial) is not a
// credit we can safely file, it may be an existing critic under another spelling.
function hasFullSurname(name) {
  const toks = String(name || '').trim().split(/\s+/);
  if (toks.length < 2) return false;
  return toks[toks.length - 1].replace(/[^\p{L}]/gu, '').length >= 2;
}

const MONTH = '(?:January|February|March|April|May|June|July|August|September|October|November|December)';
const SENTENCE_WORDS = new Set(['this', 'the', 'a', 'an', 'in', 'it', 'its', 'of', 'on', 'at', 'for', 'with', 'as', 'when', 'what', 'how', 'why', 'is', 'are', 'was', 'and', 'but', 'that', 'there', 'these', 'those', 'from', 'to', 'by']);
const NAME_WORD = String.raw`\p{Lu}[\p{L}'’-]+`;

// markaspen (WordPress): "Tosca Posted by markaspen Warmth With Steel ... Review by Claire Alexander Puccini's ..."
// The name runs straight into the first sentence, so take two words, or three when the
// three-word form repeats later in the text (the closing credit "Claire Alexander, October 2026").
function extractMarkAspenByline(text) {
  const head = String(text || '').slice(0, 600).replace(/\s+/g, ' ');
  const m = new RegExp(String.raw`\bReview by\s+(${NAME_WORD})\s+(${NAME_WORD})(?:\s+(${NAME_WORD}))?`, 'u').exec(head);
  if (!m) return null;
  if (SENTENCE_WORDS.has(m[2].toLowerCase())) return null; // "Review by Claire This production ..."
  const two = `${m[1]} ${m[2]}`;
  if (m[3] && !/['’]s$/.test(m[3])) {
    const three = `${two} ${m[3]}`;
    if (String(text).replace(/\s+/g, ' ').split(three).length > 2) return printedPerson(three);
  }
  return /['’]s$/.test(m[2]) ? null : printedPerson(two);
}

// First Night Magazine: the credit closes the article, "... following link . By Guillermo Nazara Share this: ..."
function extractFirstNightByline(text) {
  const tail = String(text || '').replace(/\s+/g, ' ').slice(-900);
  const m = new RegExp(String.raw`\bBy\s+(${PRINTED_NAME}?)\s+Share this\b`, 'u').exec(tail);
  if (!m) return null;
  // "Photos By Marc Brenner Share this:" is a photo credit, not the critic.
  if (/\b(?:photos?|photography|photographs?|images?|pictures?|credits?|illustrations?|design|designed)\s*(?:\w+\s+)?$/i.test(tail.slice(Math.max(0, m.index - 30), m.index))) return null;
  return printedPerson(m[1]);
}

// A Youngish Perspective (WordPress): "<standfirst> Lucy Holz April 12, 2025 <stars> , Review , Theatre".
// The author sits directly before the post date; a username ("jessicafrancis08") is lowercase
// and never matches, and a first name plus initial ("Lucy C") is refused (see hasFullSurname).
function extractAYoungishByline(text) {
  const head = String(text || '').slice(0, 500).replace(/\s+/g, ' ');
  // Two name words (optionally a middle initial) immediately before the month: a capitalised
  // headline word before them ("Fences Antonia Constantin") must not be swallowed.
  const re = new RegExp(String.raw`(?<![\p{L}'’-])(${NAME_WORD}\s+(?:\p{Lu}\.?\s+)?${NAME_WORD})\s+${MONTH}\s+\d{1,2},\s+\d{4}\b`, 'u');
  const m = re.exec(head);
  return m ? printedPerson(m[1]) : null;
}

const OUTLET_HEAD_EXTRACTORS = {
  markaspen: extractMarkAspenByline,
  firstnightmagazine: extractFirstNightByline,
  'a-youngish-perspective': extractAYoungishByline,
};

/**
 * @param {string} outletId canonical outlet id
 * @param {string} fullText stored review text
 * @param {{showTitle?: string}} [opts]
 * @returns {{name: string, method: string} | null} the critic the text prints, or null
 */
function extractCriticFromFullText(outletId, fullText, opts = {}) {
  if (!fullText || typeof fullText !== 'string') return null;
  const accept = (name, method) => (name && !isJunkBylineValue(name) && hasFullSurname(name) ? { name, method } : null);

  const own = OUTLET_HEAD_EXTRACTORS[outletId];
  if (own) {
    const hit = accept(own(fullText), `text:${outletId}`);
    if (hit) return hit;
  }
  const printed = extractBylineFromText(outletId, fullText, opts);
  if (printed && printed.known) return accept(printed.name, 'text:outlet-pattern');
  return null;
}

module.exports = {
  isJunkBylineValue,
  needsCriticBackfill,
  extractCriticFromFullText,
  extractMarkAspenByline,
  extractFirstNightByline,
  extractAYoungishByline,
  hasFullSurname,
};
