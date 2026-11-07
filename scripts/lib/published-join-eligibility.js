'use strict';
/**
 * published-join-eligibility.js (BRO-5927) — which review-text files the star-band audit may judge against a
 * published score. The audit joins files to reviews.json by showId + URL, so two kinds of file pick up a score that is
 * not theirs and were reported as "published score outside the critic's rating" (65 rows, 55 of them false):
 *   - a duplicate file (duplicateOf): its URL joins to the canonical twin's published score;
 *   - a twin with a different byline on the same URL (a mislabeled or stale file): the published row is the other critic's.
 */
const { sameCritic } = require('./cloned-excerpt-guard');
const { hasPrimaryRating } = require('./published-score-star-band');

const unknownCritic = (n) => !n || /^(unknown|staff|n\/a)$/i.test(String(n).trim());

/** True when both names are known and name two different critics (typos and truncated bylines count as the same). */
function differentCritic(fileName, pubName) {
  if (unknownCritic(fileName) || unknownCritic(pubName)) return false;
  const a = String(fileName).toLowerCase().trim();
  const b = String(pubName).toLowerCase().trim();
  if (a.startsWith(b) || b.startsWith(a)) return false;
  return !sameCritic({ criticName: fileName }, { criticName: pubName });
}

/**
 * A shadowed file whose own article is another show's or production's (or a round-up) is not evidence about the
 * published review: its rating belongs to that other article (BRO-5927: The Front Page's Time Out row joined to a
 * wrongShow file's star; an Othello duplicate flagged as the 2025 Haymarket production). The rebuild's sibling-rating
 * clamp excludes the same flags (sibling-rating-inherit.js), so the audit and the clamp agree on what binds.
 */
function excludedEvidence(data) {
  return !!(data.wrongShow === true || data.wrongProduction === true || data.isRoundupArticle === true);
}

/**
 * How review-text file `data` may be judged against the published row `pub`:
 *   null        no join (no published row, or a shadowed file that cannot stand for it)
 *   'own'       the file is the published record (same critic, not a duplicate): every test applies
 *   'shadowed'  a duplicate or different-byline twin that holds the only rating: only the critic's rating binds, never
 *               its own model consensus (the published record has its own ensemble, judged when that file joins; BRO-5927
 *               The Cher Show: one text read Negative by 3 models on the published file, Positive by 4 on its twin)
 * `siblings`: the other files joined to the same published row. A duplicate or different-byline file is skipped when a
 * sibling can stand in for it (non-duplicate, same critic, carries the outlet's own rating); otherwise it may be the
 * only file holding the rating (the canonical twin often has url:null or no rating) and a real violation would hide.
 */
function publishedJoinMode(data, pub, siblings = []) {
  if (!pub || !data) return null;
  const otherByline = differentCritic(data.criticName, pub.criticName);
  const shadowed = data.duplicateOf || otherByline;
  if (!shadowed) return 'own';
  if (excludedEvidence(data)) return null;
  // For another critic's byline, a rated duplicate carrying the published critic's byline stands in too: it is that
  // critic's rating, this file's is not (BRO-5927 Devil Wears Prada: an Alice Saville 2/5 twin, a "Louis Chilton" 4/5).
  const standIn = siblings.some((s) => s && s !== data && !excludedEvidence(s) && (!s.duplicateOf || otherByline)
    && !differentCritic(s.criticName, pub.criticName) && hasPrimaryRating(s));
  return standIn ? null : 'shadowed';
}

/** Whether review-text file `data` may be judged against the published row `pub` at all (see publishedJoinMode). */
function canJudgePublished(data, pub, siblings = []) {
  return publishedJoinMode(data, pub, siblings) !== null;
}

module.exports = { differentCritic, canJudgePublished, publishedJoinMode };
