'use strict';
/**
 * BRO-8292: re-check joint-split parents against the current planner.
 * A parent split by an older planner keeps only its own section; the whole
 * article lives in fullText (if a re-collect restored it) or in the
 * review-texts git history. These pure helpers pick that whole text and ask
 * planMultiShowFanout whether it would still split it.
 */
const { planMultiShowFanout } = require('./multi-show-review-fanout');

const SPLIT_MARKERS = [
  'multiShowSplitProcessed', 'multiShowSplitParent', 'multiShowSplitChildShowIds',
  'multiShowSplitAnchorKind', 'multiShowSplitOriginalLength', 'multiShowSplitTextLength',
  'multiShowSplitSectionHash', 'multiShowSplitSourceComplete', 'multiShowSplitSiblingShowIds',
];

function isJointParent(data) {
  return !!(data && data.multiShowSplitParent === true && data.multiShowSplitAnchorKind === 'joint');
}

/**
 * The whole pre-split article for a joint parent. `history` is the file's
 * older revisions, newest first (parsed JSON). Returns { text, source } or null.
 * Current fullText wins when it is back at the original length; otherwise the
 * newest revision whose text length is within 50 chars of the recorded
 * original (or, if none, the longest earlier text longer than the section).
 */
function pickWholeText(data, history = []) {
  const orig = Number(data.multiShowSplitOriginalLength);
  const near = (t) => typeof t === 'string' && Number.isFinite(orig) && Math.abs(t.length - orig) <= 50;
  const cur = typeof data.fullText === 'string' ? data.fullText : '';
  if (near(cur) || (Number.isFinite(orig) && cur.length > orig)) return { text: cur, source: 'current' };
  for (let i = 0; i < history.length; i++) {
    const h = history[i] || {};
    for (const k of ['fullText', 'wrongFullText']) if (near(h[k])) return { text: h[k], source: `history:${i}:${k}` };
  }
  let best = null;
  for (let i = 0; i < history.length; i++) {
    const t = (history[i] || {}).fullText;
    if (typeof t === 'string' && t.length > cur.length + 200 && (!best || t.length > best.text.length)) best = { text: t, source: `history:${i}:longest` };
  }
  return best;
}

/**
 * Re-plan a joint parent's whole text as if it had never been split.
 * Returns { verdict: 'no-split' | 'still-split' | 'no-whole-text', ... }.
 */
function replanJointParent(data, history, shows) {
  const whole = pickWholeText(data, history);
  if (!whole) return { verdict: 'no-whole-text' };
  const fresh = { ...data, fullText: whole.text };
  for (const k of SPLIT_MARKERS) delete fresh[k];
  const plan = planMultiShowFanout(fresh, shows, { ownShowId: data.showId, joint: true });
  const holdsWhole = typeof data.fullText === 'string' && data.fullText.length >= whole.text.length - 50;
  if (!plan || plan.otherSections.length === 0) {
    return { verdict: 'no-split', source: whole.source, wholeChars: whole.text.length, holdsWhole };
  }
  return {
    verdict: 'still-split', source: whole.source, wholeChars: whole.text.length, holdsWhole,
    strategy: plan.strategy, sections: plan.otherSections.map((s) => s.showId),
    ownChars: plan.ownSection.sectionText.length,
  };
}

module.exports = { isJointParent, pickWholeText, replanJointParent, SPLIT_MARKERS };
