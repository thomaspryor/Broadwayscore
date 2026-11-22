import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { scoreFromSlimShow } = require('../lib/newsletter-score.js');

// Use only the published score, including its coverage/withholding decisions.
// Missing or unreadable slim files cannot justify inventing a review mean.
export function createCompositeScoreLoader(showsDir) {
  const cache = new Map();
  return function aggregateScore(showId) {
    if (cache.has(showId)) return cache.get(showId);
    let slim = null;
    try {
      slim = JSON.parse(fs.readFileSync(path.join(showsDir, `${showId}.json`), 'utf8'));
    } catch { /* No published score available. */ }
    const result = scoreFromSlimShow(slim) ?? null;
    cache.set(showId, result);
    return result;
  };
}

// Per-review scores behind the published Critic Score (the slim file's `rv`,
// already deduplicated by critic like the score). Used for the newsletter's
// Reception facts, so "critics broadly liked it" describes the same reviews
// as the number beside it. Empty when the file is missing.
export function createReviewScoresLoader(showsDir) {
  return function reviewScores(showId) {
    try {
      const slim = JSON.parse(fs.readFileSync(path.join(showsDir, `${showId}.json`), 'utf8'));
      return (Array.isArray(slim.rv) ? slim.rv : []).map(r => r && r.s).filter(s => typeof s === 'number' && Number.isFinite(s));
    } catch { return []; }
  };
}
