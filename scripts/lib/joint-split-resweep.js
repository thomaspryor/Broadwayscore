'use strict';
/**
 * BRO-8292: re-check joint-split parents against the current planner.
 * A parent split by an older planner keeps only its own section; the whole
 * article lives in fullText (if a re-collect restored it), in a trimmed
 * sibling's multiShowWholeArticleText, or in the review-texts git history.
 * These pure helpers pick that whole text and ask planMultiShowFanout whether
 * it would still split it, and whether the BRO-8272 lede-comparison rule is
 * the only reason it no longer would.
 */
const { planMultiShowFanout, urlKey } = require('./multi-show-review-fanout');

const SPLIT_MARKERS = [
  'multiShowSplitProcessed', 'multiShowSplitParent', 'multiShowSplitChildShowIds',
  'multiShowSplitAnchorKind', 'multiShowSplitOriginalLength', 'multiShowSplitTextLength',
  'multiShowSplitSectionHash', 'multiShowSplitSourceComplete', 'multiShowSplitSiblingShowIds',
];
const PARTIAL_TIERS = new Set(['truncated', 'excerpt', 'stub']);

function isJointParent(data) {
  return !!(data && data.multiShowSplitParent === true && data.multiShowSplitAnchorKind === 'joint');
}

/** Same article: both URLs present and equal after normalisation. */
function sameUrl(a, b) {
  return !!(a && b && a.url && b.url && urlKey(a.url) === urlKey(b.url));
}

/**
 * The whole pre-split article for a joint parent. Returns { text, source } or null.
 * `history` = the file's committed revisions, newest first (parsed JSON, `_rev` optional; any iterable);
 * `children` = the split siblings' current records. Every candidate must carry the
 * parent's URL (a slot that once held another article must not decide the verdict)
 * and sit within max(50, 3%) of the recorded original length.
 */
function pickWholeText(data, history = [], children = []) {
  const orig = Number(data.multiShowSplitOriginalLength);
  if (!Number.isFinite(orig)) return null;
  const near = (t) => typeof t === 'string' && Math.abs(t.length - orig) <= Math.max(50, orig * 0.03);
  if (near(data.fullText)) return { text: data.fullText, source: 'current' };
  if (near(data.multiShowWholeArticleText)) return { text: data.multiShowWholeArticleText, source: 'current:multiShowWholeArticleText' };
  for (const c of children) {
    if (c && sameUrl(c, data) && near(c.multiShowWholeArticleText)) return { text: c.multiShowWholeArticleText, source: `child:${c.showId || '?'}:multiShowWholeArticleText` };
  }
  // `history` may be a lazy iterable (the sweep's git reader stops at the first hit).
  let i = -1;
  for (const rev of history) {
    i++;
    const h = rev || {};
    if (!sameUrl(h, data)) continue;
    for (const k of ['fullText', 'wrongFullText', 'multiShowWholeArticleText']) {
      if (near(h[k])) return { text: h[k], source: `history:${h._rev || i}:${k}` };
    }
  }
  return null;
}

/** The record as the planner should read it: markers stripped, a partial tier not allowed to hide the text. */
function freshRecord(data, text) {
  const fresh = { ...data, fullText: text };
  for (const k of SPLIT_MARKERS) delete fresh[k];
  delete fresh.multiShowWholeArticleText;
  if (PARTIAL_TIERS.has(fresh.contentTier)) fresh.contentTier = 'complete';
  return fresh;
}

/** { split, cousin } for one candidate whole text. */
function planBoth(data, text, shows) {
  const fresh = freshRecord(data, text);
  const opts = { ownShowId: data.showId, joint: true };
  const plan = planMultiShowFanout(fresh, shows, opts);
  if (plan && plan.otherSections.length) return { split: true, cousin: false, plan };
  // A BRO-8272 cousin only when the lede-comparison rule is the one thing stopping the split;
  // any other null (a real column the joint strategy no longer reads) is not one.
  const without = planMultiShowFanout(fresh, shows, { ...opts, skipLedeComparison: true });
  return { split: false, cousin: !!(without && without.strategy === 'joint' && without.otherSections.length) };
}

/**
 * Re-plan a joint parent's whole text as if it had never been split.
 * verdict: 'lede-cousin' (repair: force-refetch + rescore) | 'no-split' (planner declines
 * for another reason: keep the split) | 'still-split' | 'no-whole-text'.
 */
function replanJointParent(data, history, shows, children = []) {
  const whole = pickWholeText(data, history, children);
  if (!whole) return { verdict: 'no-whole-text' };
  return replanText(data, whole, shows);
}

/** Re-plan one known whole text ({ text, source }) for a joint parent. */
function replanText(data, whole, shows) {
  const r = planBoth(data, whole.text, shows);
  const base = { source: whole.source, wholeChars: whole.text.length,
    holdsWhole: typeof data.fullText === 'string' && data.fullText.length >= whole.text.length - 50 };
  if (!r.split) return { verdict: r.cousin ? 'lede-cousin' : 'no-split', ...base };
  return { verdict: 'still-split', ...base, strategy: r.plan.strategy,
    sections: r.plan.otherSections.map((s) => s.showId), ownChars: r.plan.ownSection.sectionText.length };
}

/**
 * When no whole text survives anywhere, rebuild candidates from the parent's
 * section plus its children's sections. Each child must be this parent's split
 * child for the same URL and still hold its section (length matches
 * multiShowSplitTextLength). Section order is unknown, so every order is
 * returned; null unless the pieces add up to the recorded original (within 10%).
 */
function reconstructCandidates(data, children) {
  const own = typeof data.fullText === 'string' ? data.fullText : '';
  const parts = [own];
  for (const c of children) {
    if (!c || c.multiShowSplitChild !== true || typeof c.fullText !== 'string') return null;
    if (c.multiShowSplitParentShowId && data.showId && c.multiShowSplitParentShowId !== data.showId) return null;
    if (!sameUrl(c, data)) return null;
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
 * Re-plan every reconstruction. The true order is unknown, so this is weak
 * evidence: 'refetch' when any order is a lede cousin, 'recon-still-split' when
 * every order still splits, else 'recon-no-cousin' (no order is a cousin, but
 * the text is a guess: --fetch checks it against the real article).
 */
function replanReconstructed(data, children, shows) {
  const cands = reconstructCandidates(data, children);
  if (!cands) return { verdict: 'no-whole-text' };
  let split = 0;
  let cousin = 0;
  for (const text of cands) {
    const r = planBoth(data, text, shows);
    if (r.split) split++;
    else if (r.cousin) cousin++;
  }
  const verdict = cousin ? 'refetch' : split === cands.length ? 'recon-still-split' : 'recon-no-cousin';
  return { verdict, source: 'reconstructed', orders: cands.length, ordersSplit: split, ordersCousin: cousin };
}

module.exports = { isJointParent, pickWholeText, replanJointParent, replanText, reconstructCandidates, replanReconstructed, SPLIT_MARKERS };
