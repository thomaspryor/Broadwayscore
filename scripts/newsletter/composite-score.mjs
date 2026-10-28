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
