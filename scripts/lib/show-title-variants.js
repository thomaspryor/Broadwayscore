'use strict';

/**
 * Punctuation-insensitive show-title matching, shared by every "does this text
 * mention the show?" check.
 *
 * Why this exists: the show-mention checks used to match the shows.json title
 * literally. shows.json says "Dog Man - The Musical" while every review writes
 * "Dog Man: The Musical" (or just "Dog Man"); "Oh, Mary!" is written "Oh Mary!";
 * outlets use curly apostrophes and en/em dashes. A literal match counted 0
 * mentions, so real reviews were nulled to stubs as url_content_mismatch
 * (validateContentMentionsShow), flagged showNotMentioned by the weekly
 * backfill (validateShowMentioned), and never auto-cleared by the rebuild.
 *
 * The fix: normalize the title and the text the SAME way (fold curly quotes,
 * dashes, diacritics; turn separator punctuation into spaces), then match
 * variants at word boundaries. Three callers use it:
 *   - scripts/lib/content-quality.js validateShowMentioned (Check 1)
 *   - scripts/lib/content-quality.js validateContentMentionsShow
 *   - scripts/rebuild-all-reviews.js showNotMentioned auto-clear
 */

const { foldDiacritics } = require('./title-match');

// Words that never make a pre-separator prefix distinctive on their own.
// Mirrors content-quality.js GENERIC_ID_WORDS (kept here to avoid a circular
// require) plus articles/stopwords.
const GENERIC_PREFIX_WORDS = new Set([
  'the', 'a', 'an', 'and', 'of', 'or', 'to', 'in', 'on', 'for', 'with', 'from',
  'broadway', 'west', 'end', 'off', 'tour', 'touring', 'national', 'regional',
  'revival', 'transfer', 'return', 'returns', 'encore', 'encores', 'musical',
  'woman', 'women', 'man', 'men', 'girl', 'girls', 'boy', 'boys', 'love',
  'life', 'lives', 'living', 'time', 'times', 'world', 'house', 'home',
  'among', 'family', 'friend', 'friends', 'mother', 'father', 'brother',
  'sister', 'people', 'night', 'nights', 'day', 'days', 'years', 'year',
  'moment', 'moments', 'thing', 'things', 'place', 'places', 'name', 'names',
  'part', 'parts', 'live', 'show', 'play', 'concert', 'new',
  // Determiners/numerals/common adjectives: "One Day – The Musical" must not
  // yield "one day" (matches "Just For One Day", "one day he…").
  'one', 'two', 'three', 'four', 'five', 'first', 'last', 'just', 'all', 'this',
  'that', 'my', 'your', 'our', 'his', 'her', 'their', 'its', 'we', 'you', 'i',
  'it', 'is', 'be', 'no', 'not', 'good', 'great', 'little', 'big', 'old', 'best',
  'more', 'most', 'other', 'another', 'some', 'every', 'what', 'who', 'how',
  // Dates appear in every article byline ("Published August 5") — a month or
  // weekday prefix ("August: Osage County" → "august") would count bylines as
  // show mentions.
  'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
  'september', 'october', 'november', 'december', 'monday', 'tuesday',
  'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
]);

/**
 * Normalize text (or a title) for mention matching. Apply to BOTH sides.
 *  - diacritics folded ("Misérables" → "miserables")
 *  - curly/modifier apostrophes → "'", curly double quotes dropped
 *  - en/em dashes and spaced hyphens are separators; intra-word hyphens kept
 *    ("Spider-Man" stays one token)
 *  - separator punctuation (: , ! ? . ; " / ( ) [ ] …) → space
 *  - "&" → " and "
 *  - lowercased, whitespace collapsed (incl. NBSP)
 * @param {string} s
 * @returns {string}
 */
function normalizeForMention(s) {
  if (!s) return '';
  return foldDiacritics(String(s))
    .replace(/[‘’‚‛ʼ＇`´]/g, "'")
    .replace(/[“”„‟"]/g, ' ')
    .replace(/[‐‑]/g, '-')
    .replace(/[‒–—―−]/g, ' ')
    .replace(/ /g, ' ')
    .replace(/&/g, ' and ')
    .toLowerCase()
    // Hyphen that is not joining two word characters is a separator.
    .replace(/(^|[^a-z0-9])-+|-+(?=[^a-z0-9]|$)/g, '$1 ')
    // Quote marks used as quotes (not in-word apostrophes) are separators.
    .replace(/(^|[^a-z0-9])'+|'+(?=[^a-z0-9]|$)/g, (m, p1) => (p1 !== undefined ? `${p1} ` : ' '))
    .replace(/[:;,!?.\/\\()\[\]{}…*|<>~^_+=#@$%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Separators that split a title from its subtitle. A comma also counts when
// the prefix is multi-word ("Kiss Me, Kate" does NOT produce "kiss me" as a
// standalone variant — see prefix rules below).
const SUBTITLE_SPLIT_RE = /\s*:\s*|\s+[-–—]\s+|\s*[–—]\s*/;

function isGenericPhrase(normPhrase) {
  const words = normPhrase.split(' ').filter(Boolean);
  return words.length === 0 || words.every((w) => GENERIC_PREFIX_WORDS.has(w));
}

/**
 * Build the normalized title variants a text may use to mention the show.
 * Returns de-duplicated, mention-normalized strings (longest first):
 *   - the full title
 *   - the full title without a leading "the"
 *   - the pre-subtitle part ("Dog Man - The Musical" → "dog man",
 *     "Dolly: A True Original Musical" → "dolly") when ≥5 chars and not made
 *     only of generic words
 *   - the pre-comma part, same rule ("Beaches, A New Musical" → "beaches").
 *     Comma prefixes are only added when the text after the comma starts a
 *     subtitle-like phrase ("a …", "the …", "or …", "an …") — "Hello, Dolly!"
 *     and "Kiss Me, Kate" keep only their full title so "hello"/"kiss me" never
 *     count as a mention on their own.
 * @param {string} title
 * @param {{ includePrefix?: boolean }} [opts]
 * @returns {string[]}
 */
function buildShowTitleVariants(title, opts = {}) {
  const includePrefix = opts.includePrefix !== false;
  const out = new Set();
  if (!title || typeof title !== 'string') return [];
  const full = normalizeForMention(title);
  if (full) out.add(full);
  const noThe = full.replace(/^the /, '');
  if (noThe && noThe !== full) out.add(noThe);

  if (includePrefix) {
    const addPrefix = (raw) => {
      const p = normalizeForMention(raw);
      const pNoThe = p.replace(/^the /, '');
      if (pNoThe.length >= 5 && !isGenericPhrase(pNoThe) && pNoThe !== noThe) {
        out.add(p);
        if (pNoThe !== p) out.add(pNoThe);
      }
    };
    const folded = foldDiacritics(title).replace(/ /g, ' ');
    const parts = folded.split(SUBTITLE_SPLIT_RE);
    if (parts.length > 1 && parts[0].trim()) addPrefix(parts[0]);
    const commaIdx = folded.indexOf(',');
    if (commaIdx > 0) {
      const after = folded.slice(commaIdx + 1).trim().toLowerCase();
      if (/^(a|an|the|or)\s/.test(after)) addPrefix(folded.slice(0, commaIdx));
    }
  }
  return [...out].filter(Boolean).sort((a, b) => b.length - a.length);
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function variantRegex(variant, flags = 'g') {
  return new RegExp(`(?<![a-z0-9])${escapeRegExp(variant)}(?![a-z0-9])`, flags);
}

/**
 * Count occurrences of a normalized variant in normalized text, at word
 * boundaries ("dog man" does not match "hotdog manager"; "joe turner" does
 * match "joe turner's").
 * @param {string} normText - output of normalizeForMention
 * @param {string} variant - output of buildShowTitleVariants
 */
function countVariant(normText, variant) {
  if (!normText || !variant) return 0;
  const m = normText.match(variantRegex(variant, 'g'));
  return m ? m.length : 0;
}

/**
 * Match spans ([start, end) offsets into normText) of a normalized variant.
 * @param {string} normText
 * @param {string} variant
 * @returns {Array<[number, number]>}
 */
function findVariantSpans(normText, variant) {
  const spans = [];
  if (!normText || !variant) return spans;
  const re = variantRegex(variant, 'g');
  let m;
  while ((m = re.exec(normText)) !== null) {
    spans.push([m.index, m.index + m[0].length]);
    if (m[0].length === 0) re.lastIndex++;
  }
  return spans;
}

/**
 * Does `text` mention `title` under any variant?
 * @param {string} text - raw text
 * @param {string} title - raw shows.json title
 * @param {{ minVariantLength?: number, includePrefix?: boolean }} [opts]
 * @returns {string|null} the first matched variant, or null
 */
function textMentionsTitle(text, title, opts = {}) {
  const minLen = opts.minVariantLength != null ? opts.minVariantLength : 4;
  const normText = normalizeForMention(text);
  if (!normText) return null;
  for (const v of buildShowTitleVariants(title, opts)) {
    if (v.length < minLen) continue;
    if (variantRegex(v, '').test(normText)) return v;
  }
  return null;
}

module.exports = {
  normalizeForMention,
  buildShowTitleVariants,
  countVariant,
  findVariantSpans,
  textMentionsTitle,
  GENERIC_PREFIX_WORDS,
};
