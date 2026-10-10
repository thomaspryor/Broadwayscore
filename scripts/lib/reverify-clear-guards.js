/**
 * Deterministic refusal guards for the CV-promoted re-verification sweeps
 * (reverify-stale-cv-promoted.js, reverify-nulled-cv-promoted.js).
 *
 * Background — the 2026-08-15 04:03-04:36 UTC incident. reverify-stale-cv-promoted.js
 * cleared exclusion flags on live reviews from fresh Gemini verdicts and produced
 * six CI errors, including a manufactured same-URL duplicate. Two distinct failure
 * modes, both reproduced from the written-out verdicts:
 *
 *   1. The script trusted the LLM's booleans against evidence sitting in the
 *      verdict's OWN reasoning. Two overturned verdicts stated the title mismatch
 *      in their reasoning and still returned wrongArticle:false — one wrote that
 *      the content's show title is "Juniper Blood", not "Blood of my Blood", then
 *      reasoned from the venue string and cleared anyway. memory/
 *      feedback_llm_verifier_hallucinates.md already documents Gemini as the
 *      unreliable ensemble member. The only quality gate was
 *      result.confidence === 'high', and it covered the wrongProduction clear
 *      path ONLY — the wrongShow-only path was ungated.
 *
 *   2. No same-URL collision check. Clearing an exclusion on a file that shares a
 *      URL with an already-includable sibling in the same show dir deterministically
 *      manufactures a same-URL duplicate, which is a hard CI error. A cheap
 *      deterministic pre-check blocks it with no LLM involved at all.
 *
 * DESIGN RULE: prefer a check that cannot be talked out of its answer. Everything
 * here is deterministic — no model call, no confidence heuristic that a persuasive
 * verdict can route around. The LLM's boolean is treated as a NECESSARY condition
 * for a clear, never a sufficient one.
 *
 * Both URL normalisation and includability delegate to the canonical helpers in
 * review-guards.js (canonicalizeUrlForDedup / isIncludableForRebuild) rather than
 * hand-rolling either — a private normaliser here would drift from what rebuild
 * itself treats as "same URL", which is the exact class of bug that produces a
 * duplicate CI error the guard was supposed to prevent.
 */

const fs = require('fs');
const path = require('path');
const { canonicalizeUrlForDedup, isIncludableForRebuild } = require('./review-guards');
const { normalizeTitle } = require('./title-match');

/**
 * Contrast cues that mark a quoted title in LLM reasoning as being held up
 * AGAINST the show under review rather than merely mentioned. Deliberately
 * narrow: a bare quoted string near no cue is not treated as a mismatch, so
 * reasoning that quotes a venue, a critic pull-quote, or the show's own title
 * does not trip the guard.
 */
const CONTRAST_CUES = [
  'not ',
  'rather than',
  'instead of',
  'different show',
  'different production',
  'different musical',
  'different play',
  'different title',
  'does not match',
  "doesn't match",
  'mismatch',
  'whereas',
  'actually',
  'is for',
  'is about',
  'refers to',
];

/**
 * High-signal explicit assertions of the content's title. When the reasoning
 * SAYS what the title is and it isn't the show's, that is a mismatch on its own
 * — no contrast cue required. This is the shape the Juniper Blood verdict took.
 */
const TITLE_ASSERTION_RES = [
  /(?:show title|title of the (?:show|content|article|review|piece|production)|content'?s show(?: title)?|reviewed show|article is (?:a review )?(?:of|for))\s*(?:is|was|appears to be|seems to be|:)?\s*["“”]([^"“”]{2,80})["“”]/gi,
];

// Candidate titles are mined from BOTH quote styles. The real incident verdict
// used single quotes — "it's for a play called 'Juniper Blood' … not 'Blood of
// my Blood'" — so a double-quote-only miner reads as safe on the unit fixtures
// and then misses the production case that actually shipped.
//
// Double quotes are unambiguous. Single quotes are not: an apostrophe inside
// ordinary prose ("it's", "critics'") would open bogus spans. The boundary
// conditions below reject those — an opening quote must not follow a word
// character, and a closing quote must not precede one — which drops the
// apostrophe in "it's" while keeping " 'Juniper Blood' ".
const DOUBLE_QUOTED_RE = /["“”]([^"“”\n]{2,80})["“”]/g;
const SINGLE_QUOTED_RE = /(?:^|[^\w'’])['‘]([^'’\n]{2,80})['’](?![\w])/g;

const CUE_WINDOW = 90;

function _norm(s) {
  if (!s || typeof s !== 'string') return '';
  try {
    return normalizeTitle(s) || '';
  } catch {
    return s.trim().toLowerCase();
  }
}

/**
 * Two normalized titles are "the same show" when either contains the other.
 * Containment (not strict equality) so subtitle/article variants — "Death Note
 * the Musical" vs "Death Note" — are not read as a mismatch.
 */
function _titlesAgree(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  // A 1-2 character fragment contains-matches almost anything; require real
  // substance before treating containment as agreement.
  if (shorter.length < 3) return false;
  return a.includes(b) || b.includes(a);
}

function _hasCueNear(text, index, length) {
  const lower = text.toLowerCase();
  const start = Math.max(0, index - CUE_WINDOW);
  const end = Math.min(lower.length, index + length + CUE_WINDOW);
  const window = lower.slice(start, end);
  for (const cue of CONTRAST_CUES) {
    if (window.includes(cue)) return cue;
  }
  return null;
}

/**
 * Detect that the verdict's OWN reasoning names a show title different from the
 * one the folder claims.
 *
 * @param {object} opts
 * @param {string} opts.reasoning - result.reasoning (and/or issues) from the verdict
 * @param {string} opts.showTitle - canonical title of the show the folder belongs to
 * @returns {{quotedTitle: string, cue: string|null, snippet: string}|null} null when no mismatch
 */
function detectTitleMismatch({ reasoning, showTitle }) {
  if (!reasoning || typeof reasoning !== 'string') return null;
  if (!showTitle || typeof showTitle !== 'string') return null;
  const normShow = _norm(showTitle);
  if (!normShow || normShow.length < 3) return null;

  // Pass 1 — explicit "the title is X" assertions. Mismatch on their own.
  for (const re of TITLE_ASSERTION_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(reasoning)) !== null) {
      const quoted = m[1];
      if (!_titlesAgree(_norm(quoted), normShow)) {
        return {
          quotedTitle: quoted,
          cue: 'explicit-title-assertion',
          snippet: reasoning.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim(),
        };
      }
    }
  }

  // Pass 2 — any quoted title (either quote style) that disagrees with the show
  // AND sits next to a contrast cue.
  for (const re of [DOUBLE_QUOTED_RE, SINGLE_QUOTED_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(reasoning)) !== null) {
      const quoted = m[1];
      const normQ = _norm(quoted);
      if (!normQ || normQ.length < 3) continue;
      if (_titlesAgree(normQ, normShow)) continue;
      const cue = _hasCueNear(reasoning, m.index, m[0].length);
      if (cue) {
        return {
          quotedTitle: quoted,
          cue,
          snippet: reasoning.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40).trim(),
        };
      }
    }
  }
  return null;
}

/**
 * The verdict's reasoning ADMITS the content is not a review (a preview, a
 * roundup of other critics, a feature) while its booleans still say clean.
 *
 * This is the death-note-the-musical-west-end-2026/timeout-london--unknown.json
 * shape: the reason string reads "The content is a preview for 'Death Note: The
 * Musical' … It describes the plot and production details rather than offering a
 * critical assessment of a performance" — and the script used it to set
 * nonReviewOverride and flip isNonReview to false. Clearing ANY exclusion on the
 * strength of that reasoning re-admits a non-review as a scoreable review, so
 * this refuses every clear path, not just the isNonReview one.
 *
 * Phrases are asserted in the POSITIVE form ("is a preview", "reads as
 * promotional") and a match is discarded when negated ("not a preview"), so
 * "This is a review, not a preview" does not trip it.
 *
 * @returns {{phrase: string, snippet: string}|null}
 */
const NON_REVIEW_ADMISSIONS = [
  'is a preview',
  'is a feature',
  'is a roundup',
  'is a news roundup',
  'is a preview/news roundup',
  'news roundup',
  'rather than a review',
  'rather than offering a critical assessment',
  'rather than offering a critical',
  'does not offer a critical assessment',
  'does not contain any review',
  'no original critical assessment',
  'not a review with critical assessment',
  'collection of review snippets',
  'collection of critical excerpts',
  'pull quotes from other critics',
  'synthesizing other critics',
  'excerpts from various outlets',
  'reads as promotional material',
  'promotional material or a preview',
  'is not a review',
];

function detectNonReviewAdmission({ reasoning }) {
  if (!reasoning || typeof reasoning !== 'string') return null;
  const lower = reasoning.toLowerCase();
  for (const phrase of NON_REVIEW_ADMISSIONS) {
    let from = 0;
    for (;;) {
      const i = lower.indexOf(phrase, from);
      if (i === -1) break;
      from = i + phrase.length;
      // Discard a negated occurrence: "not a preview", "isn't a roundup".
      const before = lower.slice(Math.max(0, i - 14), i);
      if (/\b(?:not|isn'?t|n'?t|never)\s+$/.test(before)) continue;
      // Discard a phrase that is only a PREFIX of a longer word: "is a feature"
      // must not fire on "is a feature-length review", and "is a preview" must
      // not fire on "is a previewing". A refusal here strands a legitimately
      // clearable review, so the miss is cheaper than the false positive.
      const after = lower.charAt(i + phrase.length);
      if (after && /[a-z-]/.test(after)) continue;
      return {
        phrase,
        snippet: reasoning.slice(Math.max(0, i - 50), i + phrase.length + 60).trim(),
      };
    }
  }
  return null;
}

/**
 * Find a sibling review in the SAME show directory that carries the same
 * canonical URL and is ALREADY includable. Clearing an exclusion on this file
 * would put two includable records on one URL — a hard CI error.
 *
 * Deliberately asks only about siblings that are includable RIGHT NOW: a sibling
 * that is itself excluded cannot form the duplicate pair, and refusing on it
 * would strand recoverable reviews.
 *
 * @param {object} opts
 * @param {string} opts.filePath - absolute path of the file about to be cleared
 * @param {object} opts.data - its parsed contents (for .url)
 * @param {object|null} opts.show - the show record, passed through to isIncludableForRebuild
 * @param {object} [opts.fsImpl] - injectable fs for tests
 * @returns {{sibling: string, url: string}|null}
 */
function findSameUrlIncludableSibling({ filePath, data, show, fsImpl }) {
  const F = fsImpl || fs;
  const url = canonicalizeUrlForDedup(data && data.url);
  // No usable URL means no URL collision is possible.
  if (!url) return null;

  const dir = path.dirname(filePath);
  const self = path.basename(filePath);
  let entries;
  try {
    entries = F.readdirSync(dir);
  } catch {
    return null;
  }

  for (const name of entries) {
    if (name === self) continue;
    if (!name.endsWith('.json')) continue;
    const sibPath = path.join(dir, name);
    let sib;
    try {
      sib = JSON.parse(F.readFileSync(sibPath, 'utf8'));
    } catch {
      continue;
    }
    if (canonicalizeUrlForDedup(sib && sib.url) !== url) continue;
    let includable = false;
    try {
      includable = isIncludableForRebuild(sib, show, sibPath) === true;
    } catch {
      // A guard that throws on this sibling tells us nothing; treat as
      // not-includable rather than blocking every clear in the directory.
      includable = false;
    }
    if (includable) return { sibling: name, url };
  }
  return null;
}

/**
 * Single decision point for "may this exclusion be cleared?".
 *
 * Returns { safe, refusals } where refusals is an array of
 * { code, detail } — empty exactly when safe === true. Callers log every
 * refusal so an audit of a stranded review can see which guard held it and why.
 *
 * @param {object} opts
 * @param {string} opts.filePath
 * @param {object} opts.data - parsed review record
 * @param {object|null} opts.show
 * @param {object} opts.result - the fresh verdict from verifyContent()
 * @param {string} [opts.showTitle] - defaults to show.title
 * @param {object} [opts.fsImpl]
 */
function assessClearSafety({ filePath, data, show, result, showTitle, fsImpl }) {
  const refusals = [];
  const title = showTitle || (show && show.title) || '';

  // GUARD 1 — deterministic same-URL collision. No LLM involved.
  const collision = findSameUrlIncludableSibling({ filePath, data, show, fsImpl });
  if (collision) {
    refusals.push({
      code: 'same-url-collision',
      detail: `sibling ${collision.sibling} is already includable on the same canonical URL (${collision.url}) — clearing would manufacture a same-URL duplicate`,
    });
  }

  // GUARD 2 — the verdict's own reasoning names a different show.
  const reasoningText = [
    result && result.reasoning,
    Array.isArray(result && result.issues) ? result.issues.join(' ') : (result && result.issues),
  ].filter(t => typeof t === 'string' && t).join(' ');
  const mismatch = detectTitleMismatch({ reasoning: reasoningText, showTitle: title });
  if (mismatch) {
    refusals.push({
      code: 'title-mismatch-in-reasoning',
      detail: `verdict reasoning names "${mismatch.quotedTitle}" against show "${title}" (cue: ${mismatch.cue}) — "${mismatch.snippet}"`,
    });
  }

  // GUARD 4 — the verdict's reasoning admits the content is not a review.
  const admission = detectNonReviewAdmission({ reasoning: reasoningText });
  if (admission) {
    refusals.push({
      code: 'non-review-admitted-in-reasoning',
      detail: `verdict reasoning admits non-review content ("${admission.phrase}") while returning clean — "${admission.snippet}"`,
    });
  }

  // GUARD 3 — confidence gate, now covering EVERY clear path (was
  // wrongProduction-only; wrongShow-only clears were ungated entirely).
  const confidence = result && result.confidence;
  if (confidence !== 'high') {
    refusals.push({
      code: 'low-confidence',
      detail: `verdict confidence=${confidence == null ? 'missing' : confidence} (need 'high' to clear any exclusion)`,
    });
  }

  return { safe: refusals.length === 0, refusals };
}

module.exports = {
  assessClearSafety,
  detectTitleMismatch,
  detectNonReviewAdmission,
  findSameUrlIncludableSibling,
  CONTRAST_CUES,
  NON_REVIEW_ADMISSIONS,
};
