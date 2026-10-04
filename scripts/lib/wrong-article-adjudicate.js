'use strict';

/**
 * LLM adjudication of wrong-article suspects (BRO-4603).
 *
 * scripts/audit-wrong-article.js (BRO-4383) fails the daily health check on
 * every suspect without a recorded LLM verdict, and review-write-guard.js
 * leaves the ambiguous one-title-mention class "to the daily
 * audit-wrong-article.js LLM pass". That pass never existed: the only way to
 * record a verdict was a manual Opus run + `--record-verified`, so the gate
 * went red whenever new reviews landed (22 unverified on 2026-10-04) and paged
 * the owner as "Daily Data Health Check Crashed".
 *
 * This is that pass. It re-asks content-verifier's own prompt (verifyContent)
 * with a pinned stronger model. The verdict only ever CLEARS a suspect or
 * CONFIRMS it; it never edits review data:
 *   - 'same-show'     a real LLM verdict with no wrongArticle / wrongProduction
 *                     / isFilmTv flag. Clears the suspect for this exact text.
 *   - 'wrong-article' a real LLM verdict flagging wrongArticle or
 *                     wrongProduction at medium/high confidence. Stays failing,
 *                     printed as confirmed so a fix session can flag wrongShow.
 *   - 'unsure'        anything else (heuristic fallback after a provider
 *                     error, low-confidence flag). Stays failing; retried
 *                     next run because it is not recorded.
 */

function adjudicationFromCv(cv) {
  if (!cv || typeof cv.verifiedBy !== 'string' || !cv.verifiedBy.startsWith('llm')) {
    return { verdict: 'unsure', reason: 'no LLM verdict (provider error or heuristic fallback)' };
  }
  const reason = String(cv.reasoning || (cv.issues || []).join('; ') || '').slice(0, 300);
  const flagged = cv.wrongArticle === true || cv.wrongProduction === true;
  if (flagged && cv.confidence !== 'low') return { verdict: 'wrong-article', reason };
  if (!flagged && cv.isFilmTv !== true) return { verdict: 'same-show', reason };
  return { verdict: 'unsure', reason: `${cv.isFilmTv ? 'film/TV flag' : 'low-confidence flag'}: ${reason}` };
}

/** True when a recorded adjudication clears a suspect whose current text hashes to `hash`. */
function isClearedByAdjudication(entry, hash) {
  return !!entry && entry.hash === hash && entry.verdict === 'same-show';
}

/**
 * Adjudicate suspects with no verdict for their CURRENT text. 'unsure' results
 * are not recorded, so they are retried next run. Never drops existing entries
 * (a partial review-texts checkout must not shrink the map).
 *
 * @param {object} p
 * @param {{file: string, hash: string}[]} p.suspects
 * @param {Map<string, object>} p.shows
 * @param {(file: string) => object|null} p.readReview
 * @param {(args: {review: object, show: object}) => Promise<object>} p.verify - returns a verifyContent result
 * @param {object} [p.existing]
 * @param {number} [p.max]
 */
async function adjudicateSuspects({ suspects, shows, readReview, verify, model, existing = {}, max = 30, now = () => new Date().toISOString(), log = () => {} }) {
  const next = { ...existing };
  const todo = suspects.filter((s) => !(next[s.file] && next[s.file].hash === s.hash)).slice(0, max);
  const counts = { 'same-show': 0, 'wrong-article': 0, unsure: 0, skipped: 0 };
  for (const s of todo) {
    const show = shows.get(s.file.split('/')[0]);
    const review = readReview(s.file);
    if (!show || !review || typeof review.fullText !== 'string') { counts.skipped++; continue; }
    let cv;
    try {
      cv = await verify({ review, show });
    } catch (err) {
      cv = null;
      log(`  verify threw for ${s.file}: ${err.message}`);
    }
    const { verdict, reason } = adjudicationFromCv(cv);
    counts[verdict]++;
    log(`  ${verdict.padEnd(13)} ${s.file} — ${reason}`);
    if (verdict !== 'unsure') next[s.file] = { hash: s.hash, verdict, reason, model, at: now() };
  }
  return { adjudicated: next, attempted: todo.length, counts };
}

module.exports = { adjudicationFromCv, isClearedByAdjudication, adjudicateSuspects };
