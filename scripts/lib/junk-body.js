'use strict';

/**
 * junk-body.js (BRO-6747) — is a STORED review body a page dump rather than
 * an article, and is a fresh fetch of the same url clearly better?
 *
 * The writer's field merge never overwrites a non-blank fullText, and the
 * explicit-url body upgrade (stale-merge-check isSameArticleBodyUpgrade) wants
 * a LONGER copy of the same article. Two stored shapes slip through both:
 *
 *   - a cookie/consent banner glued to the front of the article (WhatsOnStage
 *     Manic Street Creature: 9,622 chars, 7,100 of them GDPR vendor text, and
 *     the clean fetch is 2,122 chars, so "longer" never holds), and
 *   - a raw HTML document stored as the body (1 Minute Critic, 413k chars).
 *
 * content-quality's isGarbageContent calls both "valid" (they carry enough
 * theatre keywords and the banner check only judges the first 500 chars), so
 * they classify `complete`, the ensemble rejects them, and nothing ever
 * refetches them over the top. The decision here is RELATIVE: the stored body
 * must be mostly page chrome AND the incoming body must be a clean article, so
 * a real review is never swapped for a different real review.
 *
 * Pure: no fs, no process.
 */

// Consent / ad-tech vocabulary. Counted per SENTENCE, not per hit, so one
// "cookies" mention in a review's footer cannot tip a body over the line.
const CONSENT_SENTENCE_RE = /\b(?:cookies?|consent|legitimate interest|vendors?|advertising profiles|personali[sz]ed (?:ads|advertising|content)|device characteristics|ip address|data (?:processing|protection)|privacy (?:policy|notice|settings|preferences)|your choices|tracking technolog\w+|third[- ]part(?:y|ies)|opt[- ]out|gdpr)\b/i;

const BANNER_MIN_SHARE = 0.25;
const BANNER_MIN_SENTENCES = 8;
const CLEAN_MAX_SHARE = 0.1;
const CLEAN_MIN_CHARS = 300;
const BANNER_CLEAN_MIN_CHARS = 1000;

function consentShare(text) {
  const t = typeof text === 'string' ? text : '';
  const sentences = t.split(/(?<=[.!?])\s+|\n+/).filter((s) => s.trim());
  let total = 0;
  let hit = 0;
  let count = 0;
  for (const s of sentences) {
    total += s.length;
    if (CONSENT_SENTENCE_RE.test(s)) { hit += s.length; count++; }
  }
  return { share: total ? hit / total : 0, sentences: count };
}

/** A stored body that is an HTML document (doctype/html root, or tag soup). */
function isRawHtmlBody(text) {
  if (typeof text !== 'string' || !text) return false;
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(text)) return true;
  const tags = (text.match(/<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?>/gi) || []).length;
  return tags >= 50 && tags * 12 > text.length * 0.2;
}

/**
 * Why a body is a page dump, or null when it reads as an article.
 * @param {string} text
 * @returns {'raw-html'|'consent-banner'|null}
 */
function junkBodyReason(text) {
  if (isRawHtmlBody(text)) return 'raw-html';
  const c = consentShare(text);
  if (c.share >= BANNER_MIN_SHARE && c.sentences >= BANNER_MIN_SENTENCES) return 'consent-banner';
  return null;
}

/**
 * True when `incomingText` is a clean article and `storedText` is a page dump.
 * Both halves are required: a junk fetch never replaces a junk body, and a
 * clean body never replaces another clean body through this path.
 * @param {string} storedText
 * @param {string} incomingText
 * @returns {boolean}
 */
function isCleanReplacementForJunk(storedText, incomingText) {
  const why = junkBodyReason(storedText);
  if (!why) return false;
  const next = typeof incomingText === 'string' ? incomingText.trim() : '';
  if (next.length < CLEAN_MIN_CHARS) return false;
  if (junkBodyReason(next)) return false;
  if (consentShare(next).share > CLEAN_MAX_SHARE) return false;
  // A banner glued to the article must not lose it to a paywall teaser or a
  // lede: a stored banner body can hold the whole review, so a banner-type
  // replacement needs review-sized text (raw HTML holds no article, so it
  // keeps the 300-char floor).
  if (why === 'consent-banner' && next.length < BANNER_CLEAN_MIN_CHARS) return false;
  const { isGarbageContent } = require('./content-quality');
  return !isGarbageContent(next).isGarbage;
}

// BRO-6716: verdicts that say the stored body is the wrong article, and the
// human markers that make such a verdict final.
const WRONG_BODY_REJECTIONS = new Set(['wrong_show', 'wrong_production', 'not_a_review', 'garbage_text']);
const WRONG_BODY_TITLE_WINDOW = 1500;
const WRONG_BODY_MIN_CHARS = 1000;

/**
 * BRO-6716: true when a fresh fetch of the SAME url should replace a stored
 * body that is a different real article (an Evening Standard travel piece, an
 * NT Live news story, TheWrap's review of another show) rather than a page dump.
 * Requires all of:
 *   - an automated verdict on the file already says the content is wrong
 *     (wrongShow, wrongProduction, isNonReview or a matching rejection), and no
 *     person has ruled on it;
 *   - the stored body never names the show by its full title, and the
 *     incoming body names it in its first 1,500 chars (a "related reads" link
 *     further down does not count);
 *   - the incoming body is review-sized and clean.
 * The verdict flags stay: the stored content check goes stale with the new
 * text, and the existing heals or a person decide them.
 * @param {string} storedText
 * @param {string} incomingText
 * @param {string} showTitle
 * @param {object} existing - the stored review record
 * @returns {boolean}
 */
function isRightArticleReplacementForWrongBody(storedText, incomingText, showTitle, existing) {
  const d = existing || {};
  if (d._locked === true || d.manualContentTier || d.wrongShowNote || d.humanReviewedWrongShow === true
    || d.manualNonReviewSet === true || d.manualReviewedBy || d.wrongProductionManualClear === true) return false;
  const verdict = d.wrongShow === true || d.wrongProduction === true || d.isNonReview === true
    || WRONG_BODY_REJECTIONS.has(d.rejectionReason);
  if (!verdict) return false;
  const next = typeof incomingText === 'string' ? incomingText.trim() : '';
  if (next.length < WRONG_BODY_MIN_CHARS || junkBodyReason(next)) return false;
  const { containsTitlePhrase } = require('./title-phrase');
  if (!containsTitlePhrase(next, showTitle, { within: WRONG_BODY_TITLE_WINDOW })) return false;
  if (containsTitlePhrase(storedText, showTitle)) return false;
  const { isGarbageContent } = require('./content-quality');
  return !isGarbageContent(next).isGarbage;
}

module.exports = {
  isRightArticleReplacementForWrongBody,
  consentShare,
  isRawHtmlBody,
  junkBodyReason,
  isCleanReplacementForJunk,
  BANNER_MIN_SHARE,
  BANNER_MIN_SENTENCES,
};
