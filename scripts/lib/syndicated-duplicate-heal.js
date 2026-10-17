/**
 * syndicated-duplicate-heal.js (BRO-4415) — decide whether a syndicated
 * secondary (isSyndicatedDuplicate + syndicatedPrimaryFile) should lose its
 * mark because its PRIMARY is excluded.
 *
 * detect-syndicated-duplicates.js marks the secondary only while both copies
 * score. If the primary is flagged later, explainExclusion keeps excluding the
 * secondary for 'isSyndicatedDuplicate', so a possibly valid review scores
 * nowhere. Whether the primary's exclusion also condemns the secondary depends
 * on the reason:
 *
 *   primary-only (the verdict is about the primary FILE, so the mark is stale):
 *     - wrongAttribution: the primary's byline/outlet label is wrong.
 *     - wrongProduction with no text-based (CV) verdict: a date/URL/misfile
 *       verdict about that copy. A CV verdict ("this text is another
 *       production") reads the same text the secondary holds, so it counts as
 *       primary-only ONLY when the secondary carries a human
 *       wrongProductionManualClear.
 *     - garbage_text rejection: the primary's extraction is corrupt; the
 *       secondary's own text is checked by explainExclusion below.
 *   shared (the verdict is about the article): wrongShow, nonReview /
 *     isNotReview, other rejections, CV wrong-article, duplicate-class reasons.
 *     The mark stays.
 *
 * A clear also needs: the pointer names a different file in the same show,
 * same-article evidence (the detector's stored similarity, or the same article
 * path), no operator assertion on the secondary (a wrongProduction manual
 * clear is the one assertion that SUPPORTS a wrongProduction clear), and the
 * cleared secondary must pass explainExclusion (else clearing gains nothing).
 *
 * Pure: the caller supplies `io.exists(file)`/`io.read(file)` for same-show
 * siblings and `explain(data, file)` (explainExclusion bound to the show).
 */
const path = require('path');
const { carriesOperatorAssertion, sameArticlePath } = require('./outlet-mismatch-heal');
const { isGarbageTierReason } = require('./review-guards');

const MIN_SIMILARITY = 50; // detect-syndicated-duplicates.js THRESHOLD default

/** Drop the keys of a human wrongProduction clear (the assertion that supports a wrongProduction heal). */
function withoutWrongProductionClear(data) {
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (/^wrongProductionManualClear/.test(k) || k === 'humanReviewedWrongProduction') continue;
    out[k] = v;
  }
  return out;
}

/** Classify the primary's exclusion as 'primary-only' or 'shared' (with a label for reports). */
function classifyPrimaryExclusion(primary, why, secondary) {
  if (why === 'wrongAttribution') return { scope: 'primary-only', label: 'wrongAttribution' };
  if (why === 'wrongProduction') {
    if (primary.wrongShow === true) return { scope: 'shared', label: 'wrongProduction+wrongShow' };
    const cvVerdict = typeof primary.wrongProductionReason === 'string' && primary.wrongProductionReason.trim() !== '';
    if (!cvVerdict) return { scope: 'primary-only', label: 'wrongProduction (misfiled/dated copy)' };
    if (secondary.wrongProductionManualClear === true) return { scope: 'primary-only', label: 'wrongProduction (CV) vs human clear on the secondary' };
    return { scope: 'shared', label: 'wrongProduction (CV text verdict)' };
  }
  if (why === 'rejectionReason' && isGarbageTierReason(primary) && primary.wrongShow !== true) {
    return { scope: 'primary-only', label: 'garbage_text extraction' };
  }
  return { scope: 'shared', label: String(why) };
}

/**
 * @param {object} p
 * @param {object} p.data     the secondary's record
 * @param {string} p.file     the secondary's filename
 * @param {string} p.folder   the show folder name
 * @param {{exists:(f:string)=>boolean, read:(f:string)=>object}} p.io  same-show siblings
 * @param {(data:object, file:string)=>(string|null)} p.explain
 * @returns {null | { decision: 'clear'|'keep', reason: string, primaryFile: string, primaryWhy?: string, cleared?: object }}
 *   null when the file is not a syndicated secondary, or its primary scores / is only a duplicate-pointer exclusion.
 */
function syndicatedDuplicateHealPlan({ data, file, folder, io, explain }) {
  if (!data || data.isSyndicatedDuplicate !== true || typeof data.syndicatedPrimaryFile !== 'string') return null;
  const ptr = data.syndicatedPrimaryFile;
  const slash = ptr.indexOf('/');
  const ptrFolder = slash >= 0 ? ptr.slice(0, slash) : folder;
  const primaryFile = path.basename(ptr);
  const base = { primaryFile };
  if (ptrFolder !== folder) return { decision: 'keep', reason: 'primary-in-other-show', ...base };
  if (primaryFile === file) return { decision: 'keep', reason: 'self-pointer (BRO-4891 clear path)', ...base };
  if (!io.exists(primaryFile)) return { decision: 'keep', reason: 'primary-missing (dangling pointer)', ...base };
  const primary = io.read(primaryFile);
  const primaryWhy = explain(primary, primaryFile);
  if (!primaryWhy) return null; // primary scores: an ordinary live duplicate
  if (primaryWhy === 'isSyndicatedDuplicate' || primaryWhy === 'duplicateOf') return null; // BRO-4411 cycle path
  const withWhy = { ...base, primaryWhy };

  const { scope, label } = classifyPrimaryExclusion(primary, primaryWhy, data);
  if (scope !== 'primary-only') return { decision: 'keep', reason: `shared exclusion (${label})`, ...withWhy };

  const sim = Number(data.syndicationSimilarity);
  if (!((Number.isFinite(sim) && sim >= MIN_SIMILARITY) || sameArticlePath(data.url, primary.url))) {
    return { decision: 'keep', reason: 'same-article not verified', ...withWhy };
  }
  const probe = primaryWhy === 'wrongProduction' ? withoutWrongProductionClear(data) : data;
  if (carriesOperatorAssertion(probe)) return { decision: 'keep', reason: 'operator assertion on the secondary', ...withWhy };

  // false/null, not delete: the write guard's merge mode restores any key the write leaves undefined.
  const cleared = { ...data, isSyndicatedDuplicate: false, syndicatedPrimaryFile: null, syndicationSimilarity: null };
  const stillWhy = explain(cleared, file);
  if (stillWhy) return { decision: 'keep', reason: `secondary still excluded (${stillWhy})`, ...withWhy };
  return { decision: 'clear', reason: `primary-only exclusion (${label})`, cleared, ...withWhy };
}

module.exports = { syndicatedDuplicateHealPlan, classifyPrimaryExclusion, MIN_SIMILARITY };
