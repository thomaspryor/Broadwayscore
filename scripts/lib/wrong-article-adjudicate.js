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
 *                     / isFilmTv flag, and the text is valid or only truncated.
 *                     Clears the suspect for this exact text.
 *   - 'wrong-article' wrongArticle (unless it is the only flag and low
 *                     confidence), wrongProduction at medium/high, or a text
 *                     that is under 200 chars once consent/JSON prefixes are
 *                     stripped (verifyContent 'skip-short': not a review).
 *                     Stays failing, printed as CONFIRMED.
 *   - 'unsure'        everything else (provider error, heuristic fallback,
 *                     low-confidence flag, film/TV, invalid-but-not-truncated).
 *                     Stays failing; recorded with a retry-after so it does not
 *                     take a slot from never-asked suspects every run.
 *
 * Only structured fields are stored (the file is in the PUBLIC repo; LLM
 * reasoning can quote the review text, which belongs in the private repos).
 */

const UNSURE_RETRY_DAYS = 7;

function adjudicationFromCv(cv) {
  const flags = cv ? {
    isValid: cv.isValid !== false,
    truncated: !!cv.truncated,
    wrongArticle: !!cv.wrongArticle,
    wrongProduction: !!cv.wrongProduction,
    isFilmTv: !!cv.isFilmTv,
    confidence: cv.confidence || null,
  } : null;
  const reason = cv ? String(cv.reasoning || (cv.issues || []).join('; ') || '').slice(0, 200) : '';
  if (cv && cv.verifiedBy === 'skip-short') {
    return { verdict: 'wrong-article', flags, reason: 'under 200 chars once consent/JSON prefixes are stripped: not a review' };
  }
  if (!cv || typeof cv.verifiedBy !== 'string' || !cv.verifiedBy.startsWith('llm')) {
    return { verdict: 'unsure', flags, reason: 'no LLM verdict (provider error or heuristic fallback)' };
  }
  // verifyContent reports wrongProduction's (possibly temporally downgraded)
  // confidence whenever wrongProduction is set, so 'low' only describes a
  // wrongArticle flag when wrongArticle is the only flag.
  if (flags.wrongArticle && !(flags.confidence === 'low' && !flags.wrongProduction)) {
    return { verdict: 'wrong-article', flags, reason };
  }
  if (flags.wrongProduction && flags.confidence !== 'low') return { verdict: 'wrong-article', flags, reason };
  const clean = !flags.wrongArticle && !flags.wrongProduction && !flags.isFilmTv;
  if (clean && (flags.isValid || flags.truncated)) return { verdict: 'same-show', flags, reason };
  return { verdict: 'unsure', flags, reason };
}

/** True when a recorded adjudication clears a suspect whose current text hashes to `hash`. */
function isClearedByAdjudication(entry, hash) {
  return !!entry && entry.hash === hash && entry.verdict === 'same-show';
}

/** Whether a suspect still needs asking: never asked, text changed, or an unsure verdict past its retry date. */
function needsAsking(entry, hash, nowMs) {
  if (!entry || entry.hash !== hash) return true;
  if (entry.verdict !== 'unsure') return false;
  const at = Date.parse(entry.at || '');
  return !Number.isFinite(at) || nowMs - at >= UNSURE_RETRY_DAYS * 86400e3;
}

/**
 * Adjudicate suspects with no verdict for their CURRENT text. Never-asked
 * suspects go first. Never drops existing entries (a partial review-texts
 * checkout must not shrink the map). `onEntry(file, entry)` fires after each
 * verdict so the caller can persist incrementally (a step timeout must not
 * lose the run's verdicts).
 *
 * @param {object} p
 * @param {{file: string, hash: string}[]} p.suspects
 * @param {Map<string, object>} p.shows
 * @param {(file: string) => object|null} p.readReview
 * @param {(args: {review: object, show: object}) => Promise<object>} p.verify - returns a verifyContent result
 */
async function adjudicateSuspects({ suspects, shows, readReview, verify, model, existing = {}, max = 30, now = () => new Date().toISOString(), log = () => {}, onEntry = () => {} }) {
  const next = { ...existing };
  const nowMs = Date.parse(now()) || Date.now();
  const todo = suspects
    .filter((s) => needsAsking(next[s.file], s.hash, nowMs))
    .sort((a, b) => Number(!!next[a.file]) - Number(!!next[b.file]))
    .slice(0, Math.max(0, max));
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
    const { verdict, flags, reason } = adjudicationFromCv(cv);
    counts[verdict]++;
    log(`  ${verdict.padEnd(13)} ${s.file} — ${reason}`);
    const entry = { hash: s.hash, verdict, flags, model, at: now() };
    next[s.file] = entry;
    onEntry(s.file, entry);
  }
  return { adjudicated: next, attempted: todo.length, counts };
}

/** One-line description of why a verdict confirmed a suspect, from stored flags only. */
function describeConfirmed(entry) {
  const f = entry && entry.flags;
  if (!f) return 'LLM judged it not a review of this show';
  const parts = [];
  if (f.wrongArticle) parts.push('different article / not a review');
  if (f.wrongProduction) parts.push(`different production (${f.confidence || 'medium'} confidence)`);
  if (!parts.length) parts.push('not a review once page junk is stripped');
  return parts.join('; ');
}

module.exports = { adjudicationFromCv, isClearedByAdjudication, needsAsking, adjudicateSuspects, describeConfirmed, UNSURE_RETRY_DAYS };
