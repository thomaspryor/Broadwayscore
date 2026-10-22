'use strict';
/**
 * published-join-eligibility.js (BRO-5927) — which review-text files the star-band audit may judge against a
 * published score. The audit joins files to reviews.json by showId + URL, so two kinds of file pick up a score that is
 * not theirs and were reported as "published score outside the critic's rating" (65 rows, 55 of them false):
 *   - a duplicate file (duplicateOf): its URL joins to the canonical twin's published score;
 *   - a twin with a different byline on the same URL (a mislabeled or stale file): the published row is the other critic's.
 */
const { sameCritic } = require('./cloned-excerpt-guard');

const unknownCritic = (n) => !n || /^(unknown|staff|n\/a)$/i.test(String(n).trim());

/** True when both names are known and name two different critics (typos and truncated bylines count as the same). */
function differentCritic(fileName, pubName) {
  if (unknownCritic(fileName) || unknownCritic(pubName)) return false;
  const a = String(fileName).toLowerCase().trim();
  const b = String(pubName).toLowerCase().trim();
  if (a.startsWith(b) || b.startsWith(a)) return false;
  return !sameCritic({ criticName: fileName }, { criticName: pubName });
}

/** Whether review-text file `data` may be judged against the published row `pub` (null = no join). */
function canJudgePublished(data, pub) {
  if (!pub || !data || data.duplicateOf) return false;
  return !differentCritic(data.criticName, pub.criticName);
}

module.exports = { differentCritic, canJudgePublished };
