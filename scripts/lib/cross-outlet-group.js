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
      for (const p of pairs) if (p.keep === old) p.keep = keeper;
      pairs.push({ keep: keeper, copy: old });
    } else {
      pairs.push({ keep: keeper, copy: member });
    }
  }
  return { pairs, review };
}

module.exports = { getBestText, resolveFingerprintGroup };
