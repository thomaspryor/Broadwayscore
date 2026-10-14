'use strict';
/**
 * multishow-section-copy (BRO-5325): file one show's section of a multi-review
 * column, stored under ANOTHER show, into the target show's own row.
 *
 * WSJ (Teachout) columns review two or three shows under one URL. The column
 * is stored whole under the show it was discovered for, and the scorer reads
 * only that show's section (BRO-5294). The other shows in the column never got
 * the review: venus-in-fur-2011 kept a 220-char wrong-production stub and
 * of-mice-and-men-2014 had no Teachout row at all.
 *
 * Pure planning. The section comes from llm-scoring/venue-box-sections.ts
 * (production-box segmentation, refuses anything ambiguous); the plan author
 * must also name the section's first and last words, so a box-boundary shift
 * can never file the wrong text. The copy uses the BRO-4431 split-sibling
 * markers (multi-show-review-fanout.js buildChild + multiShowSplitParent /
 * multiShowSplitChildShowIds on the column row), which every cross-show URL
 * judge already treats as one article filed per show. The column row keeps
 * its whole text: the scorer trims it at score time.
 */
const { buildChild } = require('./multi-show-review-fanout');
const { EXCERPT_FIELDS } = require('./excerpt-fields');
const { foldDiacritics } = require('./title-match');

// Flags that mean the source is not this critic's review of these shows.
const SOURCE_BLOCKING = ['wrongAttribution', 'isNonReview', 'duplicateOf', 'wrongShow', 'wrongProduction',
  'isSyndicatedDuplicate', 'isRoundupArticle', 'multiShowSplitChild'];
// Verdicts on the target row a copy must never overwrite.
const TARGET_BLOCKING = ['_locked', 'manualContentTier', 'wrongAttribution', 'duplicateOf', 'isRoundupArticle', 'wrongShow', 'wrongProduction'];
const MIN_MARKER_WORDS = 4;
// A target body at least this long is a real text that a person must compare.
const MAX_REPLACEABLE_TARGET_CHARS = 400;

function normWords(s) {
  return foldDiacritics(String(s || '')).toLowerCase().replace(/[’'‘]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Plan markers arrive with `_` for spaces (run-script args split on spaces). */
function parseMarker(raw) {
  return normWords(String(raw || '').replace(/_/g, ' '));
}

function markersMatch(section, expectStart, expectEnd) {
  const start = parseMarker(expectStart);
  const end = parseMarker(expectEnd);
  if (start.split(' ').filter(Boolean).length < MIN_MARKER_WORDS || end.split(' ').filter(Boolean).length < MIN_MARKER_WORDS) {
    return { ok: false, reason: `start and end markers need ${MIN_MARKER_WORDS}+ words each` };
  }
  const body = normWords(section);
  if (!body.startsWith(start)) return { ok: false, reason: `section does not start with the expected words (starts "${body.slice(0, 80)}")` };
  if (!body.endsWith(end)) return { ok: false, reason: `section does not end with the expected words (ends "${body.slice(-80)}")` };
  return { ok: true };
}

/**
 * @param {object} p
 * @param {object} p.source        column row (whole text), on disk under sourceShowId
 * @param {string} p.sourceShowId
 * @param {{ok:boolean,text?:string,reason:string}} p.section  extractVenueBoxSectionForShowId(source.fullText, targetShowId)
 * @param {object|null} p.target   the target show's row with the same file name, or null
 * @param {string} p.targetShowId
 * @param {string} p.expectStart   first words of the section (`_` for spaces)
 * @param {string} p.expectEnd     last words of the section
 * @returns {{ok:false, reason:string} | {ok:true, reason:string, row:object, parent:object, action:'create'|'fill'}}
 */
function planSectionCopy({ source, sourceShowId, section, target, targetShowId, expectStart, expectEnd, now = new Date().toISOString() }) {
  if (!source || typeof source !== 'object') return { ok: false, reason: 'source row missing' };
  if (!targetShowId || targetShowId === sourceShowId) return { ok: false, reason: 'target show must differ from the source show' };
  const blocked = SOURCE_BLOCKING.find((k) => source[k]);
  if (blocked) return { ok: false, reason: `source is ${blocked}` };
  if (source.contentTier !== 'complete') return { ok: false, reason: `source contentTier is ${source.contentTier}, not complete` };
  if (!section || !section.ok || typeof section.text !== 'string') return { ok: false, reason: `no unambiguous section: ${(section && section.reason) || 'none'}` };
  const m = markersMatch(section.text, expectStart, expectEnd);
  if (!m.ok) return m;

  let action = 'create';
  if (target) {
    const tb = TARGET_BLOCKING.find((k) => target[k]);
    if (tb) return { ok: false, reason: `target is ${tb}` };
    if (target.humanReviewScore != null && target.humanReviewScoreProvisional !== true) return { ok: false, reason: 'target has a locked human score' };
    if (target.isNonReview === true) return { ok: false, reason: 'target is isNonReview (clear that verdict first)' };
    const existing = String(target.fullText || '');
    if (existing.length > MAX_REPLACEABLE_TARGET_CHARS) return { ok: false, reason: `target already holds ${existing.length} chars of text` };
    if (target.criticName && source.criticName && normWords(target.criticName) !== normWords(source.criticName)) {
      return { ok: false, reason: `target critic ${target.criticName} differs from source critic ${source.criticName}` };
    }
    action = 'fill';
  }

  const child = buildChild(source, { showId: targetShowId, sectionText: section.text, anchorKind: 'venue-box' }, sourceShowId, now);
  child.rescoreReason = 'multi-show column section copied from sibling row (BRO-5325)';
  child.multiShowSectionCopy = { fromShowId: sourceShowId, method: 'venue-box', chars: section.text.length, at: now };

  let row = child;
  if (target) {
    // null, not delete: safeWriteReview's merge pass copies a missing key back from disk.
    row = { ...target, ...child, source: target.source || child.source };
    const replaced = { url: target.url || null, fullText: target.fullText || null };
    const sectionWords = ` ${normWords(section.text)} `;
    for (const f of EXCERPT_FIELDS) {
      const ex = target[f];
      if (typeof ex === 'string' && ex.trim() && !sectionWords.includes(` ${normWords(ex).split(' ').slice(0, 12).join(' ')} `)) {
        replaced[f] = ex;
        row[f] = null;
      }
    }
    row.multiShowSectionCopy.replaced = replaced;
    if (target.url && target.url !== source.url) row.previousUrl = target.url;
    for (const k of ['rejectedAt', 'rejectedBy', 'rejectionReason', 'rejectionReasoning', 'incompleteReason', 'incompleteDetail',
      'fetchDiscoveryAbandoned', 'textIssues', 'llmScore', 'ensembleData', 'contentVerification', 'truncationSignals',
      // Scores of the stub's text must not publish against the new text before the rescore.
      'assignedScore', 'originalScore', 'llmMetadata', 'scoreSource']) {
      if (k in row) row[k] = null;
    }
  }

  const ids = new Set(Array.isArray(source.multiShowSplitChildShowIds) ? source.multiShowSplitChildShowIds : []);
  ids.add(targetShowId);
  // multiShowSplitMethod keeps the BRO-4431 fan-out from re-cutting the column.
  const parent = { ...source, multiShowSplitParent: true, multiShowSplitMethod: 'venue-box', multiShowSplitChildShowIds: [...ids].sort() };
  return { ok: true, reason: `${action}: ${section.text.length}-char section`, row, parent, action };
}

module.exports = { planSectionCopy, markersMatch, parseMarker, SOURCE_BLOCKING, TARGET_BLOCKING };
