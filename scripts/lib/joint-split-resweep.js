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
    for (const k of ['fullText', 'wrongFullText']) if (near(h[k])) return { text: h[k], source: `history:${h._rev || i}:${k}` };
  }
  let best = null;
  for (let i = 0; i < history.length; i++) {
    const t = (history[i] || {}).fullText;
    if (typeof t === 'string' && t.length > cur.length + 200 && (!best || t.length > best.text.length)) best = { text: t, source: `history:${history[i]._rev || i}:longest` };
  }
  return best;
}

/**
 * Re-plan a joint parent's whole text as if it had never been split.
 * Returns { verdict: 'lede-cousin' | 'no-split' | 'still-split' | 'no-whole-text', ... }.
 * Only 'lede-cousin' (and 'refetch' from a reconstruction) is a BRO-8272 mis-split to repair.
 */
function replanJointParent(data, history, shows) {
  const whole = pickWholeText(data, history);
  if (!whole) return { verdict: 'no-whole-text' };
  const fresh = { ...data, fullText: whole.text };
  for (const k of SPLIT_MARKERS) delete fresh[k];
  const plan = planMultiShowFanout(fresh, shows, { ownShowId: data.showId, joint: true });
  const holdsWhole = typeof data.fullText === 'string' && data.fullText.length >= whole.text.length - 50;
  if (!plan || plan.otherSections.length === 0) {
    // A BRO-8272 cousin only when the lede-comparison rule is the one thing stopping the split;
    // any other null (a real column the joint strategy no longer reads) keeps its split.
    const without = planMultiShowFanout(fresh, shows, { ownShowId: data.showId, joint: true, skipLedeComparison: true });
    const cousin = !!(without && without.strategy === 'joint' && without.otherSections.length);
    return { verdict: cousin ? 'lede-cousin' : 'no-split', source: whole.source, wholeChars: whole.text.length, holdsWhole };
  }
  return {
    verdict: 'still-split', source: whole.source, wholeChars: whole.text.length, holdsWhole,
    strategy: plan.strategy, sections: plan.otherSections.map((s) => s.showId),
    ownChars: plan.ownSection.sectionText.length,
  };
}

/**
 * When no whole text survives anywhere, rebuild candidates from the parent's
 * section plus its children's sections (each still its split section when
 * its fullText length matches multiShowSplitTextLength). Section order is
 * unknown, so every order is returned; null unless the pieces add up to the
 * recorded original length (within 10%).
 */
function reconstructCandidates(data, children) {
  const own = typeof data.fullText === 'string' ? data.fullText : '';
  const parts = [own];
  for (const c of children) {
    if (!c || c.multiShowSplitChild !== true || typeof c.fullText !== 'string') return null;
    if (Number.isFinite(c.multiShowSplitTextLength) && Math.abs(c.fullText.length - c.multiShowSplitTextLength) > 50) return null;
    parts.push(c.fullText);
  }
  if (parts.length < 2 || parts.length > 4) return null;
  const orig = Number(data.multiShowSplitOriginalLength);
  const sum = parts.reduce((n, t) => n + t.length, 0);
  if (!Number.isFinite(orig) || Math.abs(sum - orig) > orig * 0.1) return null;
  const perms = (a) => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map((r) => [x, ...r])));
  return perms(parts).map((p) => p.join('\n\n'));
}

/**
 * Re-plan every reconstruction. 'still-split' only when EVERY order still
 * splits; any order that does not is 'refetch' (the true order is unknown).
 */
function replanReconstructed(data, children, shows) {
  const cands = reconstructCandidates(data, children);
  if (!cands) return { verdict: 'no-whole-text' };
  let split = 0;
  let cousin = 0;
  for (const text of cands) {
    const fresh = { ...data, fullText: text };
    for (const k of SPLIT_MARKERS) delete fresh[k];
    const plan = planMultiShowFanout(fresh, shows, { ownShowId: data.showId, joint: true });
    if (plan && plan.otherSections.length) { split++; continue; }
    const without = planMultiShowFanout(fresh, shows, { ownShowId: data.showId, joint: true, skipLedeComparison: true });
    if (without && without.strategy === 'joint' && without.otherSections.length) cousin++;
  }
  // Order unknown: any order that is a lede-comparison cousin means refetch to see the true one.
  const verdict = cousin ? 'refetch' : split === cands.length ? 'still-split' : 'no-split';
  return { verdict, source: 'reconstructed', orders: cands.length, ordersSplit: split, ordersCousin: cousin };
}

module.exports = { isJointParent, pickWholeText, replanJointParent, reconstructCandidates, replanReconstructed, SPLIT_MARKERS };
