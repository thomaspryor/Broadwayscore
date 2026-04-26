// Pure score parsing — safe for both server and client. No fs / 'server-only'.
//
// Mirrors scripts/lib/score-parsers.js parseOriginalScore() but skips the
// LETTER_GRADE_OUTLETS gate — for manual ingestion, the operator is the
// authority on what the rating is, not the outlet's typical format.

const LETTER_GRADE_VALUES: Record<string, number> = {
  'A+': 98,
  A: 95,
  'A-': 92,
  'B+': 88,
  B: 85,
  'B-': 82,
  'C+': 78,
  C: 75,
  'C-': 72,
  'D+': 68,
  D: 65,
  'D-': 62,
  F: 50,
};

export interface ScoreParseResult {
  score: number;
  type: 'stars' | 'letter' | 'numeric';
}

export function parseScore(rating: string): ScoreParseResult | null {
  if (!rating) return null;
  const r = rating.trim();
  if (!r) return null;

  // Stars: "4/5", "4 out of 5", "4 stars", "3.5/10"
  const starMatch = r.match(/^(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+)|out\s+of\s+(\d+)|stars?)/i);
  if (starMatch) {
    const stars = parseFloat(starMatch[1]);
    const maxStars = parseInt(starMatch[2] || starMatch[3] || '5');
    if (maxStars > 0 && stars <= maxStars) {
      return { score: Math.round((stars / maxStars) * 100), type: 'stars' };
    }
  }

  // Unicode stars: ★★★☆☆ (with optional half-star using ½ or ".5")
  const filled = (r.match(/★/g) || []).length;
  const empty = (r.match(/☆/g) || []).length;
  const halfStar = /½|\.5|\bhalf\b/i.test(r) ? 0.5 : 0;
  if (filled > 0) {
    const total = filled + empty || 5;
    return { score: Math.round(((filled + halfStar) / total) * 100), type: 'stars' };
  }

  // Letter grades: "A+", "B-", "F"
  const upper = r.toUpperCase();
  if (LETTER_GRADE_VALUES[upper] !== undefined) {
    return { score: LETTER_GRADE_VALUES[upper], type: 'letter' };
  }
  const letterMatch = upper.match(/^([A-D][+-]?|F)$/);
  if (letterMatch && LETTER_GRADE_VALUES[letterMatch[1]] !== undefined) {
    return { score: LETTER_GRADE_VALUES[letterMatch[1]], type: 'letter' };
  }

  // Numeric: "90", "90%", "90/100", "85/100"
  const numMatch = r.match(/^(\d+(?:\.\d+)?)\s*(?:%|\/\s*100)?$/);
  if (numMatch) {
    const num = parseFloat(numMatch[1]);
    if (num >= 0 && num <= 100) {
      return { score: Math.round(num), type: 'numeric' };
    }
  }

  return null;
}
