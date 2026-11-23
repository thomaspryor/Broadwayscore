/** Word-trigram Jaccard similarity (0-100). Extracted from detect-syndicated-duplicates.js (BRO-7957) so the migration shares it. */
const { foldDiacritics } = require('./title-match');

function words(text) {
  return foldDiacritics(text).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
}

function trigramSet(ws) {
  const out = new Set();
  for (let i = 0; i < ws.length - 2; i++) out.add(ws.slice(i, i + 3).join(' '));
  return out;
}

function trigramSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  const words1 = words(text1);
  const words2 = words(text2);
  if (words1.length < 10 || words2.length < 10) return 0;

  const trigrams1 = trigramSet(words1);
  const trigrams2 = trigramSet(words2);

  let intersection = 0;
  for (const t of trigrams1) if (trigrams2.has(t)) intersection++;
  return Math.round(100 * intersection / (trigrams1.size + trigrams2.size - intersection));
}

/**
 * BRO-7391: share (0-100) of the SHORTER text's word trigrams found in the longer
 * one, plus which side is shorter. Jaccard cannot see a truncated syndicated copy:
 * the Chicago Tribune's 56-word prefix of Variety's 587-word Stasio review scored
 * ~8% Jaccard (threshold 50) while being 100% contained, so the review counted
 * twice. Returns 0 when the shorter text has fewer than minWords eligible words,
 * because a couple of shared stock phrases would otherwise read as containment.
 *
 * @returns {{ containment: number, shorter: 1|2, shorterWords: number }}
 */
function trigramContainment(text1, text2, { minWords = 20 } = {}) {
  const none = { containment: 0, shorter: 1, shorterWords: 0 };
  if (!text1 || !text2) return none;
  const w1 = words(text1);
  const w2 = words(text2);
  const shorter = w1.length <= w2.length ? 1 : 2;
  const [ws, wl] = shorter === 1 ? [w1, w2] : [w2, w1];
  if (ws.length < minWords) return { ...none, shorter, shorterWords: ws.length };
  const ts = trigramSet(ws);
  const tl = trigramSet(wl);
  let hit = 0;
  for (const t of ts) if (tl.has(t)) hit++;
  return { containment: Math.round(100 * hit / ts.size), shorter, shorterWords: ws.length };
}

module.exports = { trigramSimilarity, trigramContainment };
