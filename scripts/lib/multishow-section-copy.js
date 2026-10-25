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
const { buildChild, rewriteParent } = require('./multi-show-review-fanout');
const { EXCERPT_FIELDS } = require('./excerpt-fields');
const { foldDiacritics } = require('./title-match');

// Flags that mean the source is not this critic's review of these shows.
const SOURCE_BLOCKING = ['wrongAttribution', 'isNonReview', 'duplicateOf', 'wrongShow', 'wrongProduction',
  'isSyndicatedDuplicate', 'isRoundupArticle', 'multiShowSplitChild'];
// Verdicts on the target row a copy must never overwrite.
const TARGET_BLOCKING = ['_locked', 'manualContentTier', 'wrongAttribution', 'duplicateOf', 'isRoundupArticle', 'wrongShow', 'wrongProduction'];
const MIN_MARKER_WORDS = 4;
const MIN_OWN_SECTION_CHARS = 800;
// A target body at least this long is a real text that a person must compare.
const MAX_REPLACEABLE_TARGET_CHARS = 400;

function normWords(s) {
  return foldDiacritics(String(s || '')).toLowerCase().replace(/[’'‘]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Plan markers arrive with `_` for spaces (run-script args split on spaces). */
function parseMarker(raw) {
  return normWords(String(raw || '').replace(/_/g, ' '));
}

/**
 * Cut the stretch of `text` that starts at the words of `startMarker` and ends
 * at the words of `endMarker` (`_` for spaces; punctuation and case between
 * the words are ignored). For a column with no venue boxes (an NYT piece that
 * opens with a shared lede, then one section per show): the plan author read
 * the article and names where this show's section begins and ends. Refuses
 * unless each marker occurs exactly once and the start comes before the end,
 * so a marker that drifts can never file another show's text.
 * @returns {{ok:boolean, text?:string, reason:string}}
 */
function sectionByMarkers(text, startMarker, endMarker) {
  const src = String(text || '');
  const toRe = (marker) => {
    const words = parseMarker(marker).split(' ').filter(Boolean);
    if (words.length < MIN_MARKER_WORDS) return null;
    // Curly quotes match through the separator class; accented letters must be spelled as in the text.
    return new RegExp(`(?<![A-Za-z0-9])${words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join("[^A-Za-z0-9]+")}(?![A-Za-z0-9])`, 'gi');
  };
  const startRe = toRe(startMarker);
  const endRe = toRe(endMarker);
  if (!startRe || !endRe) return { ok: false, reason: `start and end markers need ${MIN_MARKER_WORDS}+ words each` };
  const starts = [...src.matchAll(startRe)];
  const ends = [...src.matchAll(endRe)];
  if (starts.length !== 1) return { ok: false, reason: `start marker occurs ${starts.length} times, need exactly 1` };
  if (ends.length !== 1) return { ok: false, reason: `end marker occurs ${ends.length} times, need exactly 1` };
  const from = starts[0].index;
  const to = ends[0].index + ends[0][0].length;
  if (to <= from) return { ok: false, reason: 'end marker comes before the start marker' };
  // Keep the sentence's closing punctuation that follows the last word.
  const tail = /^[.!?…]?[”"’']?/.exec(src.slice(to))[0];
  return { ok: true, text: src.slice(from, to + tail.length).trim(), reason: 'marker section' };
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
/**
 * The row's text now comes from a stored column, not from wherever the stub
 * was found: record it, or a stub found by the legacy web-search step stays an
 * "unverifiable web-search row" and is never scored (review-guards.js
 * isUnverifiableWebSearchRow; venus-in-fur-2011, BRO-5325).
 */
function withSplitSource(target) {
  const sources = new Set([].concat(target.sources || [], target.source || []).filter((x) => typeof x === 'string' && x));
  sources.add('multi-show-split');
  return [...sources];
}

function planSectionCopy({ source, sourceShowId, section, target, targetShowId, expectStart, expectEnd, method = 'venue-box', ownSection = null, now = new Date().toISOString() }) {
  if (!source || typeof source !== 'object') return { ok: false, reason: 'source row missing' };
  if (!targetShowId || targetShowId === sourceShowId) return { ok: false, reason: 'target show must differ from the source show' };
  const blocked = SOURCE_BLOCKING.find((k) => source[k]);
  if (blocked) return { ok: false, reason: `source is ${blocked}` };
  if (source.contentTier !== 'complete') return { ok: false, reason: `source contentTier is ${source.contentTier}, not complete` };
  if (!section || !section.ok || typeof section.text !== 'string') return { ok: false, reason: `no unambiguous section: ${(section && section.reason) || 'none'}` };
  const m = markersMatch(section.text, expectStart, expectEnd);
  if (!m.ok) return m;
  const multiShowSource = {
    showId: sourceShowId, outletId: source.outletId, criticName: source.criticName,
    url: source.url, method,
  };

  // A row this tool already filed from this column with this exact section:
  // only its provenance is brought up to date (a re-run of the plan).
  const ids = new Set(Array.isArray(source.multiShowSplitChildShowIds) ? source.multiShowSplitChildShowIds : []);
  ids.add(targetShowId);
  // multiShowSplitMethod keeps the BRO-4431 fan-out from re-cutting the column.
  let parent = { ...source, multiShowSplitParent: true, multiShowSplitMethod: method, multiShowSplitChildShowIds: [...ids].sort() };
  // A marker split also cuts the source down to its OWN section: the scorer only
  // trims venue-box columns at score time, so a whole article left in the source
  // row would score its verdict on the other show too.
  if (ownSection) {
    // The trim is written with force, which skips the write guard's lock checks.
    const lockedKey = ['_locked', 'manualContentTier'].find((k) => source[k]) || (source.humanReviewScore != null && source.humanReviewScoreProvisional !== true ? 'humanReviewScore' : null);
    if (lockedKey) return { ok: false, reason: `source is ${lockedKey}, will not trim it` };
    if (!ownSection.ok || typeof ownSection.text !== 'string') return { ok: false, reason: `no unambiguous own section: ${ownSection.reason || 'none'}` };
    if (ownSection.text.length < MIN_OWN_SECTION_CHARS) return { ok: false, reason: `own section is only ${ownSection.text.length} chars` };
    if (normWords(section.text).includes(normWords(ownSection.text).slice(0, 200)) || normWords(ownSection.text).includes(normWords(section.text).slice(0, 200))) {
      return { ok: false, reason: 'own section and target section overlap' };
    }
    parent = {
      ...rewriteParent(source, { sectionText: ownSection.text, anchorKind: method }, parent.multiShowSplitChildShowIds, now),
      multiShowSplitMethod: method,
    };
    // Scores of the whole article must not publish against the trimmed text before the rescore.
    for (const k of ['assignedScore', 'originalScore', 'llmMetadata', 'scoreSource']) if (k in parent) parent[k] = null;
  }
  if (target && target.multiShowSectionCopy && target.multiShowSectionCopy.fromShowId === sourceShowId && target.fullText === section.text) {
    return { ok: true, reason: `refresh: ${section.text.length}-char section already filed`, row: { ...target, sources: withSplitSource(target), multiShowSource }, parent, action: 'refresh' };
  }

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

  const child = buildChild(source, { showId: targetShowId, sectionText: section.text, anchorKind: method }, sourceShowId, now);
  child.rescoreReason = 'multi-show column section copied from sibling row (BRO-5325)';
  child.multiShowSectionCopy = { fromShowId: sourceShowId, method, chars: section.text.length, at: now };
  child.multiShowSource = multiShowSource;

  let row = child;
  if (target) {
    // null, not delete: safeWriteReview's merge pass copies a missing key back from disk.
    row = { ...target, ...child, source: target.source || child.source, sources: withSplitSource(target) };
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

  return { ok: true, reason: `${action}: ${section.text.length}-char section`, row, parent, action };
}

module.exports = { planSectionCopy, sectionByMarkers, markersMatch, parseMarker, SOURCE_BLOCKING, TARGET_BLOCKING };
