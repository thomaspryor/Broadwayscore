/** Word-trigram Jaccard similarity (0-100). Extracted from detect-syndicated-duplicates.js (BRO-7957) so the migration shares it. */
const { foldDiacritics } = require('./title-match');

function trigramSimilarity(text1, text2) {
  if (!text1 || !text2) return 0;
  const words1 = foldDiacritics(text1).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  const words2 = foldDiacritics(text2).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
  if (words1.length < 10 || words2.length < 10) return 0;

  const trigrams1 = new Set();
  const trigrams2 = new Set();
  for (let i = 0; i < words1.length - 2; i++) trigrams1.add(words1.slice(i, i + 3).join(' '));
  for (let i = 0; i < words2.length - 2; i++) trigrams2.add(words2.slice(i, i + 3).join(' '));

  let intersection = 0;
  for (const t of trigrams1) if (trigrams2.has(t)) intersection++;
  return Math.round(100 * intersection / (trigrams1.size + trigrams2.size - intersection));
}

module.exports = { trigramSimilarity };
