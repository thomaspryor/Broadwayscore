'use strict';
/**
 * Negative cache for LLM verdicts that otherwise leave no trace (BRO-7536,
 * cousins of BRO-7535 / pull-quote-negative-cache.js).
 *
 * Three scripts asked an LLM, got an answer that wrote nothing to disk, and so
 * asked the same question again on every run:
 *   - classify-non-reviews.js (4x/day, --incremental --limit=50): medium/low
 *     "not a review" verdicts, LANE-SKIP and EVIDENCE-CONFLICT outcomes got no
 *     stamp, so the same files filled the 50-call budget each run.
 *   - detect-cross-outlet-duplicates.js (weekly): borderline pairs the LLM
 *     called "different reviews" were re-asked every week.
 *   - verify-existing-reviews.js: low-confidence flag verdicts were not
 *     stamped, and RECOVER mode had no skip at all.
 *
 * Each verdict is remembered with a hash of what the LLM judged and a prompt
 * version. A later run skips the item while both match; changed text (refetch,
 * heal), changed prompt context, or a prompt / guard version change re-queues
 * it. Transient failures (errors, unparseable replies) are never stamped.
 *
 * Pure functions only: required by the three scripts and by
 * scripts/tests/*-verdict-cache.test.mjs.
 */
const crypto = require('crypto');

function sha(text, len) {
  return crypto.createHash('sha256').update(String(text == null ? '' : text)).digest('hex').slice(0, len);
}

/** Hash of the judged text plus any prompt context (show title, outlet, ...). */
function judgedInputHash(text, context = '') {
  const t = String(text == null ? '' : text);
  return sha(context ? `${t}\n#ctx=${context}` : t, 16);
}

/** Version string that changes whenever the prompt text or the guard version changes. */
function promptVersionFor(promptText, guardVersion = 1) {
  return `g${guardVersion}-${sha(promptText, 12)}`;
}

/** Field names for a per-file verdict stamp with the given prefix. */
function stampFields(prefix) {
  return Object.freeze({
    at: `${prefix}At`,
    reason: `${prefix}Reason`,
    inputHash: `${prefix}InputHash`,
    promptVersion: `${prefix}PromptVersion`,
  });
}

/** Fields to merge into a review file after a verdict that wrote nothing else. */
function buildVerdictStamp(fields, { text, context, reason, promptVersion, now }) {
  if (!promptVersion) throw new Error('buildVerdictStamp: promptVersion required');
  return {
    [fields.at]: (now instanceof Date ? now : new Date()).toISOString(),
    [fields.reason]: String(reason || 'judged'),
    [fields.inputHash]: judgedInputHash(text, context),
    [fields.promptVersion]: promptVersion,
  };
}

/** True when `data` carries a stamp for exactly this input and prompt version. */
function hasMatchingVerdictStamp(data, fields, { text, context, promptVersion, overwrite } = {}) {
  if (overwrite) return false;
  if (!data || !data[fields.at]) return false;
  if (!promptVersion || data[fields.promptVersion] !== promptVersion) return false;
  return data[fields.inputHash] === judgedInputHash(text, context);
}

// ------------------------------------------------------------------
// classify-non-reviews.js
// ------------------------------------------------------------------

const CLASSIFY_FIELDS = stampFields('nonReviewUncertain');
const CLASSIFY_REASONS = Object.freeze({
  UNCERTAIN: 'uncertain',             // medium/low "not a review": never applied
  LANE_SKIP: 'lane-skip',             // opening-night lane review: never flagged
  EVIDENCE_CONFLICT: 'evidence-conflict', // stronger evidence blocks the stamp
});
// EXTRACTION-SUSPECT is deliberately absent: the verdict judged extraction
// boilerplate, and the gap sweep refetches the body, so it must stay retriable.
const CLASSIFY_STAMPABLE = new Set(Object.values(CLASSIFY_REASONS));

/** Outcome name ('uncertain', 'lane-skip', 'evidence-conflict', 'extraction-suspect', ...) -> stamp reason or null. */
function classifyStampReason(outcome) {
  return CLASSIFY_STAMPABLE.has(outcome) ? outcome : null;
}

/**
 * Skip a file in classify-non-reviews selection? Only when the stamp matches the
 * current text and prompt AND, for conditional outcomes, the condition that
 * blocked the verdict still holds (a lapsed lane or withdrawn evidence means the
 * same verdict would now be applied, so ask again).
 */
function shouldSkipClassify(data, { showTitle, promptVersion, overwrite, laneStillBypasses, evidenceStillBlocks } = {}) {
  if (!hasMatchingVerdictStamp(data, CLASSIFY_FIELDS, { text: data && data.fullText, context: showTitle, promptVersion, overwrite })) return false;
  const reason = data[CLASSIFY_FIELDS.reason];
  if (reason === CLASSIFY_REASONS.UNCERTAIN) return true;
  if (reason === CLASSIFY_REASONS.LANE_SKIP) return !!laneStillBypasses;
  if (reason === CLASSIFY_REASONS.EVIDENCE_CONFLICT) return !!evidenceStillBlocks;
  return false;
}

// ------------------------------------------------------------------
// verify-existing-reviews.js
// ------------------------------------------------------------------

const VERIFY_FIELDS = stampFields('retroVerifyJudged');   // VERIFY mode: low-confidence flag verdicts
const RECOVER_FIELDS = stampFields('retroRecoverJudged'); // RECOVER mode: flag kept after an LLM read

/** Prompt context for a content-verifier call: everything besides the text that shapes the verdict. */
function verifierContext(review, show) {
  const r = review || {};
  const s = show || {};
  return [s.title || '', s.openingDate || '', s.venue || '', r.outlet || r.outletId || '', r.criticName || '', r.publishDate || '', r.url || ''].join('|');
}

// ------------------------------------------------------------------
// detect-cross-outlet-duplicates.js: pair-verdict store
// ------------------------------------------------------------------

/** Order-independent key for two judged texts. */
function pairKey(hashA, hashB) {
  return [String(hashA), String(hashB)].sort().join('~');
}

/** Prior boolean verdict for this pair under this prompt version, else null. */
function lookupPairVerdict(store, hashA, hashB, promptVersion, { overwrite } = {}) {
  if (overwrite || !store || !promptVersion) return null;
  const e = store[pairKey(hashA, hashB)];
  if (!e || e.promptVersion !== promptVersion || typeof e.verdict !== 'boolean') return null;
  return e.verdict;
}

/** Record a definite verdict. null (error / unparseable) is never recorded, so it is retried. */
function recordPairVerdict(store, hashA, hashB, { verdict, promptVersion, now, showId, files } = {}) {
  if (typeof verdict !== 'boolean' || !promptVersion) return false;
  store[pairKey(hashA, hashB)] = {
    verdict,
    promptVersion,
    at: (now instanceof Date ? now : new Date()).toISOString(),
    ...(showId ? { showId } : {}),
    ...(Array.isArray(files) ? { files: files.slice(0, 2) } : {}),
  };
  return true;
}

/** Keep only entries whose key was looked up this run (call after a full, unfiltered run). */
function prunePairStore(store, touchedKeys) {
  const out = {};
  for (const k of Object.keys(store || {})) if (touchedKeys.has(k)) out[k] = store[k];
  return out;
}

module.exports = {
  judgedInputHash,
  promptVersionFor,
  stampFields,
  buildVerdictStamp,
  hasMatchingVerdictStamp,
  CLASSIFY_FIELDS,
  CLASSIFY_REASONS,
  classifyStampReason,
  shouldSkipClassify,
  VERIFY_FIELDS,
  RECOVER_FIELDS,
  verifierContext,
  pairKey,
  lookupPairVerdict,
  recordPairVerdict,
  prunePairStore,
};
