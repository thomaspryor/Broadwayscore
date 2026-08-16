/**
 * Theatre Record extractor wrong-show guards, extracted per CLAUDE.md rule 15
 * so they're require()-able from a test instead of only exercised live.
 *
 * Card #1227: the title-mention-count guard rejected 6 real T1/T2 reviews of
 * "Barcelona" (barcelona-west-end-2024) — a single-word, common-word title
 * whose prose mostly says "the play"/"the production" rather than repeating
 * the city name, so it never cleared the 2-mention floor the guard demands
 * for short titles. A Sunday Times column reviewing both Barcelona and the
 * film Dr Strangelove also tripped the film/TV regex on the OTHER show's
 * blurb. All 6 were independently confirmed as real Barcelona reviews by the
 * WET roundup (westendtheatre.com/261097) — corroboration these guards never
 * checked before rejecting.
 */

const { normalizeOutlet, normalizeCritic } = require('./review-normalization');
const { foldDiacritics } = require('./title-match');

const LONG_WORD_STOPWORDS = ['the', 'and', 'for', 'from', 'with'];
const CORE_WORD_STOPWORDS = ['the', 'and', 'for', 'from', 'with', 'a', 'an', 'at', 'in', 'on', 'of', 'to'];

// Same signals as the extractor's original inline film/TV guard.
const FILM_TV_PATTERNS = [/\b(?:in cinemas|on screen|film adaptation|movie version|streaming on)\b/i];

function computeMentionCounts(show, fullText) {
  const reviewLower = (fullText || '').toLowerCase();
  const showTitleLower = foldDiacritics(show.title || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const showWords = showTitleLower.split(/\s+/).filter(w => w.length > 3 && !LONG_WORD_STOPWORDS.includes(w));
  const coreWords = showTitleLower.split(/\s+/).filter(w => w.length >= 2 && !CORE_WORD_STOPWORDS.includes(w));

  const titleRegex = new RegExp(`\\b${showTitleLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
  const titleMentions = (reviewLower.match(titleRegex) || []).length;
  const wordMentions = showWords.length > 0
    ? Math.max(...showWords.map(w => (reviewLower.match(new RegExp(`\\b${w}\\b`, 'gi')) || []).length))
    : 0;
  const coreMentions = coreWords.length > 0
    ? Math.max(...coreWords.map(w => (reviewLower.match(new RegExp(`\\b${w}\\b`, 'gi')) || []).length))
    : 0;

  const mentions = Math.max(titleMentions, wordMentions, coreMentions);
  // Single-word or very short titles need 2+ mentions (common words cause false positives).
  // Multi-word titles with distinctive words need only 1.
  const minMentions = showWords.length >= 2 ? 1 : 2;
  return { mentions, minMentions, showWords, coreWords };
}

function checkWrongShowMentionGuard(show, fullText) {
  const { mentions, minMentions } = computeMentionCounts(show, fullText);
  if (mentions < minMentions) {
    return { fails: true, reason: `wrong-show (only ${mentions} title mention(s) in review)`, mentions, minMentions };
  }
  return { fails: false, reason: null, mentions, minMentions };
}

function checkFilmTvGuard(fullText) {
  for (const pat of FILM_TV_PATTERNS) {
    if (pat.test(fullText || '')) {
      return { fails: true, reason: `film/TV review (${pat.source.slice(0, 40)})`, pattern: pat };
    }
  }
  return { fails: false, reason: null, pattern: null };
}

// True when an independent aggregator roundup already lists this exact
// critic+outlet reviewing this show. Corroboration overrides the in-text
// heuristics above — they're prone to false positives on common-word titles
// and multi-show columns, but a roundup row is an independent confirmation.
//
// WET's table-format roundups (tried first in wet-roundup-discover.js) never
// resolve a critic name — every row comes back critic:'Unknown'. Requiring a
// critic match there would make corroboration a permanent no-op for any show
// whose roundup happens to be table-format, so an outlet match alone is
// accepted when the ROUNDUP row's critic is unresolvable (each row is already
// title-scoped to this show by discoverWetRoundupRows). The review's OWN
// critic must still resolve — relaxing that side too would let any
// unattributed/misfiled review from a reviewed outlet corroborate on outlet
// alone, which is a materially weaker claim.
function isCorroboratedByRoundup(outlet, critic, roundupRows) {
  if (!Array.isArray(roundupRows) || roundupRows.length === 0) return false;
  const criticId = normalizeCritic(critic);
  if (criticId === 'unknown') return false;
  const outletId = normalizeOutlet(outlet);
  return roundupRows.some(row => {
    if (normalizeOutlet(row.outlet) !== outletId) return false;
    const rowCriticId = normalizeCritic(row.critic);
    return rowCriticId === 'unknown' || rowCriticId === criticId;
  });
}

module.exports = {
  computeMentionCounts,
  checkWrongShowMentionGuard,
  checkFilmTvGuard,
  isCorroboratedByRoundup,
};
