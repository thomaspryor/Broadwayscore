'use strict';
/**
 * Pure helpers shared by detect-cross-outlet-duplicates.js and
 * audit-cross-outlet-different-critic.js (BRO-6774).
 */

/**
 * Best available text of a review file: fullText (>50 chars), else the joined
 * aggregator excerpts. Same rule the detector uses, so the audit judges the
 * text the detector compared (BRO-6759 gotcha: the audit read fullText only).
 */
function getBestText(data) {
  if (data && data.fullText && data.fullText.length > 50) return { text: data.fullText, source: 'fullText' };
  const excerpts = [data && data.dtliExcerpt, data && data.bwwExcerpt, data && data.showScoreExcerpt, data && data.nycTheatreExcerpt].filter(Boolean);
  if (excerpts.length > 0) return { text: excerpts.join(' '), source: 'excerpts' };
  return { text: '', source: 'none' };
}

/**
 * Resolve one fingerprint group (rows already sorted best-first, pointers removed)
 * into copy -> keeper pairs. The old loop compared every member to plain[0]; when a
 * member was the declared copy's *source* (verdict.copy === 'a') plain[0] became the
 * copy while later members still pointed at it, so a 3+ member group hid the primary
 * AND the files that pointed at it (BRO-6759 gotcha 2). Here the keeper moves with
 * the swap and any earlier copy is re-pointed at the new keeper.
 *
 * @param {Array<object>} plain  group members, best-first
 * @param {(keep:object, copy:object)=>{action:string, copy?:string, reason?:string}} classify
 * @returns {{pairs: Array<{keep:object, copy:object}>, review: Array<{keep:object, copy:object, verdict:object}>}}
 */
function resolveFingerprintGroup(plain, classify) {
  const pairs = [];
  const review = [];
  if (!plain || plain.length < 2) return { pairs, review };
  let keeper = plain[0];
  for (let i = 1; i < plain.length; i++) {
    const member = plain[i];
    const verdict = classify(keeper, member);
    if (verdict.action === 'review') { review.push({ keep: keeper, copy: member, verdict }); continue; }
    if (verdict.copy === 'a') {
      // The current keeper declares the member as its source: the member keeps the text.
      const old = keeper;
      keeper = member;
      // Earlier copies move to the new keeper only if the policy accepts that pair too
      // (the fingerprint covers 500 chars, provenance reads more), else they go to review.
      for (let k = pairs.length - 1; k >= 0; k--) {
        const p = pairs[k];
        if (p.keep !== old) continue;
        const v = classify(keeper, p.copy);
        if (v.action === 'review') { pairs.splice(k, 1); review.push({ keep: keeper, copy: p.copy, verdict: v }); } else p.keep = keeper;
      }
      for (const r of review) if (r.keep === old) r.keep = keeper;
      pairs.push({ keep: keeper, copy: old });
    } else {
      pairs.push({ keep: keeper, copy: member });
    }
  }
  return { pairs, review };
}


/**
 * BRO-7663: share of an aggregator excerpt's word trigrams found in another
 * file's fullText (0-100), or null when the excerpt is too short to judge.
 * Trigram Jaccard (the detector's Layer 2) scores a 45-word excerpt inside a
 * 1,500-word review at ~3%, so a roundup quote filed under the wrong outlet
 * (BWW credited Joe Dziemianowicz's New York Theatre Guide line to his old
 * paper, the Daily News, on the-fantasticks-2026) was never paired.
 */
const CONTAINMENT_MIN_WORDS = 12;
const CONTAINMENT_MATCH = 85;
function words(text) {
  const { foldDiacritics } = require('./title-match');
  return foldDiacritics(String(text || '')).toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}
function excerptContainment(excerptText, fullText) {
  const ew = words(excerptText);
  const fw = words(fullText);
  if (ew.length < CONTAINMENT_MIN_WORDS || fw.length <= ew.length) return null;
  const full = new Set();
  for (let i = 0; i < fw.length - 2; i++) full.add(fw.slice(i, i + 3).join(' '));
  let total = 0;
  let hit = 0;
  for (let i = 0; i < ew.length - 2; i++) { total++; if (full.has(ew.slice(i, i + 3).join(' '))) hit++; }
  return total === 0 ? null : Math.round(100 * hit / total);
}

/**
 * For a pair of detector rows ({text, textSource}), the excerpt-only row whose
 * excerpt sits inside the other row's fullText: returns 'a' or 'b' (the copy),
 * with the containment percent, or null. The excerpt side is always the copy:
 * an aggregator quote never outranks the fetched review it was lifted from.
 * Only a bare quote qualifies: no url of its own and no named critic. A row
 * with a url or a byline may be the real review with a misfetched sibling
 * (trouble-in-mind-2021 washpost, the-humans-2016 ap), so it stays with the
 * existing similarity/LLM path (full-corpus dry run, BRO-7663).
 */
function excerptCopySide(a, b) {
  const { isPlaceholderCritic } = require('./cross-outlet-pair-policy');
  for (const [ex, full, side] of [[a, b, 'a'], [b, a, 'b']]) {
    if (ex.textSource !== 'excerpts' || full.textSource !== 'fullText') continue;
    if (ex.hasUrl || !isPlaceholderCritic(ex.criticName)) continue;
    const pct = excerptContainment(ex.text, full.text);
    if (pct !== null && pct >= CONTAINMENT_MATCH) return { copy: side, containment: pct };
  }
  return null;
}

/**
 * BRO-7684: the excerpt-containment flags for one show dir, with no LLM, so the
 * rebuild can set them in the same run a bare quote (or its sibling's fullText)
 * lands, instead of waiting for the weekly detector. Same row filters and pair
 * rule as detect-cross-outlet-duplicates.js Layer 2 for an excerptCopySide hit.
 * Stricter than the detector on purpose: a row a person cleared
 * (crossOutletDuplicate false or crossOutletClearReason) is never re-flagged,
 * and the keeper must not itself be a flagged copy (no copy-of-a-copy chains).
 *
 * @param {Array<{file:string, data:object}>} entries  every review file in the show dir
 * @returns {Array<{file:string, primaryFile:string, containment:number}>}
 */
function excerptContainmentFlags(entries) {
  const { crossOutletPointer, skipAsAlreadyFlagged, excludeFromCrossOutletCompare } = require('./cross-outlet-pointer');
  const { classifyCrossOutletPair } = require('./cross-outlet-pair-policy');
  const byFile = new Map((entries || []).map(e => [e.file, e.data]));
  const readSibling = (f) => byFile.get(f) || null;
  const rows = [];
  for (const { file, data } of entries || []) {
    if (!data || data.rejectionReason) continue;
    if (excludeFromCrossOutletCompare(data)) continue;
    const { text, source } = getBestText(data);
    if (!text || text.length < 50) continue;
    if (skipAsAlreadyFlagged(data, file, readSibling)) continue;
    // A pointer to another outlet's file is report-only in the detector.
    if (crossOutletPointer(data, file, readSibling)) continue;
    rows.push({
      file, data,
      outletId: data.outletId || file.split('--')[0],
      outlet: data.outlet || data.outletId || '',
      criticName: data.criticName || '',
      hasUrl: Boolean(data.url),
      text, textSource: source,
    });
  }
  const flags = [];
  for (const ex of rows) {
    if (ex.textSource !== 'excerpts') continue;
    if (typeof ex.data.crossOutletDuplicate === 'boolean' || ex.data.crossOutletClearReason) continue;
    let best = null;
    for (const full of rows) {
      if (full === ex || full.textSource !== 'fullText') continue;
      if (full.outletId === ex.outletId) continue;
      if (ex.criticName && full.criticName && ex.criticName.toLowerCase() === full.criticName.toLowerCase()) continue;
      if (full.data.crossOutletDuplicate === true) continue;
      const hit = excerptCopySide(ex, full);
      if (!hit || hit.copy !== 'a') continue;
      const verdict = classifyCrossOutletPair(ex, full, { similarity: 100 });
      if (verdict.action === 'review' || (verdict.copy && verdict.copy !== 'a')) continue;
      if (!best || hit.containment > best.containment || (hit.containment === best.containment && full.text.length > best.len)) {
        best = { file: ex.file, primaryFile: full.file, containment: hit.containment, len: full.text.length };
      }
    }
    if (best) flags.push({ file: best.file, primaryFile: best.primaryFile, containment: best.containment });
  }
  return flags;
}

/**
 * Set the detector's crossOutlet* fields on `data` for one excerptContainmentFlags
 * hit. Only the fields clearCrossOutletFields (cascade-clear-duplicate-refs.js)
 * removes, so a later clear leaves nothing stale behind.
 */
function applyExcerptContainmentFlag(data, showId, flag, now = new Date()) {
  data.crossOutletDuplicate = true;
  data.crossOutletPrimaryFile = `${showId}/${flag.primaryFile}`;
  data.crossOutletSimilarity = 100; // what the detector records for a containment pair
  data.crossOutletMethod = 'excerpt-containment';
  data.crossOutletFlaggedAt = now.toISOString();
  return data;
}

module.exports = { getBestText, resolveFingerprintGroup, excerptContainment, excerptCopySide, excerptContainmentFlags, applyExcerptContainmentFlag, CONTAINMENT_MATCH };
