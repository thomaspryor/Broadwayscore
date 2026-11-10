'use strict';
/**
 * Roll back a gap-recovery accept whose gain was page chrome (BRO-7171 Stage 4).
 *
 * Before gate 9 (novel prose, c16146469f7) a same-text re-fetch that picked up
 * a newsletter box or footer passed the length bar and landed as "recovered".
 * The review prose is unchanged, so restoring the prior text loses nothing and
 * removes the chrome the scorer and the gap metric were reading.
 *
 * Pure decision; scripts/gap-recovery-rollback.js does the locked write.
 */
const { sha256, novelProseVerdict } = require('./gap-acceptance');

// The text fields recoverReviewText writes (gap-acceptance.js), minus two:
// - textFetchedAt is restored to the prior text's own stamp below (not "now":
//   a now-stamp made restored OLD text beat any genuinely newer refetch a CI
//   job landed meanwhile). The merge driver instead prefers a rolled-back side
//   over exactly the chrome text it undoes (review-json-three-way-merge
//   rollbackWins: other side's fullText hash === provenance.newFullTextHash),
//   which is what kept the first live run from losing 103/105 to the rebase.
// - contentTier / contentTierReason stay: the driver refuses a fresher side
//   whose tier is worse, and the rebuild's tier write-back reclassifies the
//   restored text anyway (classifyTierWriteBack).
const TEXT_FIELDS = Object.freeze(['fullText', 'isFullReview', 'textWordCount', 'fetchMethod',
  'sourceMethod', 'incompleteReason', 'incompleteDetail']);

/**
 * @param {{current: object, prior: object, nowIso?: string}} a
 *   current: the record on disk now; prior: the record before the accept (git parent)
 * @returns {{ok: false, reason: string} | {ok: true, patch: object, novel: number, need: number}}
 */
function chromeRollbackDecision({ current, prior, nowIso = new Date().toISOString() }) {
  const prov = current && current.textRecoveryProvenance;
  if (!prov) return { ok: false, reason: 'no_recovery_provenance' };
  // A stamp whose text never landed (lost a rebase) is retried, not skipped.
  if (prov.rolledBack && sha256(current.fullText || '') !== prov.newFullTextHash) return { ok: false, reason: 'already_rolled_back' };
  if (prov.priorUrl !== undefined && prov.priorUrl !== null) return { ok: false, reason: 'accept_moved_url' };
  if (!prior || typeof prior.fullText !== 'string' || !prior.fullText) return { ok: false, reason: 'no_prior_text' };
  if ((prior.url || null) !== (current.url || null)) return { ok: false, reason: 'url_differs_from_prior' };
  if (sha256(current.fullText || '') !== prov.newFullTextHash) return { ok: false, reason: 'text_changed_since_accept' };
  if (sha256(prior.fullText) !== prov.priorFullTextHash) return { ok: false, reason: 'prior_is_not_the_accepted_prior' };
  // The acceptance gate's own bar (novelProseVerdict): roll back exactly what gate 9 now refuses.
  const { ok: realProse, novel, need } = novelProseVerdict(prior.fullText, current.fullText);
  if (realProse) return { ok: false, reason: 'real_new_prose', novel, need };
  const patch = {};
  for (const f of TEXT_FIELDS) if (prior[f] !== undefined) patch[f] = prior[f];
  // Restore the prior stamp. No prior stamp -> null (the writer Object.assigns,
  // so omitting it would leave the accept's newer stamp on the old text).
  patch.textFetchedAt = prior.textFetchedAt || null;
  patch.textRecoveryProvenance = { ...prov, rolledBack: { at: nowIso, reason: 'chrome_gain', novelProseChars: novel, needed: need, priorTextFetchedAt: prior.textFetchedAt || null } };
  return { ok: true, patch, novel, need };
}

module.exports = { chromeRollbackDecision, TEXT_FIELDS };
