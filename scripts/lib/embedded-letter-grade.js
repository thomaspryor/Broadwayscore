/**
 * Letter grade pulled from review prose, shared by the fallback scorers
 * (fix-default-scores.js, score-all-unscored.js).
 *
 * BRO-8350 (class "star-vs-score mismatch", 5th case): the two scripts each
 * carried their own /i regex, so "calculating a stronger head for business"
 * read as "rating A" and a lukewarm Reviews Hub review got originalScore "A"
 * (93). BRO-6779 fixed the same defect in score-extractors.js; these copies
 * were missed. Rules, all required:
 *   - the keyword ("grade:" / "rating") starts at a word boundary, so
 *     "calculating a" / "operating a" never match;
 *   - the letter is UPPERCASE: "rating a" is an article, never a grade;
 *   - "score" is not a keyword (musical score), and bare "grade" needs a colon.
 */
const { LETTER_GRADES } = require('./score-conversion-rules');

const KEYWORD_GRADE_RE = /\b(?:grade:\s*|rating[:\s]+)([A-Za-z](?![+-]\w)[+-]?)(?![\w])/gi;
const END_GRADE_RE = /\s([A-DF][+-]?)\s*$/;

function normalize(letter) {
  if (!/^[A-DF][+-]?$/.test(letter)) return null;
  const score = LETTER_GRADES[letter];
  return typeof score === 'number' ? { grade: letter, score } : null;
}

function extractEmbeddedLetterGrade(text) {
  if (!text || typeof text !== 'string') return null;
  const end = text.trim().slice(-10).match(END_GRADE_RE);
  if (end) {
    const hit = normalize(end[1]);
    if (hit) return hit;
  }
  for (const m of text.matchAll(KEYWORD_GRADE_RE)) {
    const hit = normalize(m[1]);
    if (hit) return hit;
  }
  return null;
}

module.exports = { extractEmbeddedLetterGrade };
