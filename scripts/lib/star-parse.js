'use strict';

/**
 * star-parse.js — parse a captured star/rating string to a 0-100 score, the
 * linear convention used across the scorer (5/5=100, 4/5=80, 3/5=60, 2/5=40,
 * 1/5=20; half-stars proportional). Extracted as a pure, tested helper so the
 * star-accuracy audit and any future star consumer agree on ONE conversion.
 *
 * Handles the real shapes seen in data/review-texts: "4/5 stars", "3.5/5",
 * "★★★", "Three stars", "4 out of 5", "8/10", "B+". Returns null when the
 * string carries no parseable rating (don't guess).
 */

const WORD_NUM = { one: 1, two: 2, three: 3, four: 4, five: 5, half: 0.5 };

// Letter grades → 0-100. The audit MUST grade against production's conversion,
// not its own — a local table (formerly A=95) silently disagreed with the
// canonical map (A=90) and tripped ~20 false HARD flags (D=47-vs-35, D+=52-vs-42
// etc.) where the score was actually correct (2026-06-29). Single-source from the
// canonical CommonJS map (score-extractors.js LETTER_GRADES == src/config/scoring.ts
// LETTER_GRADE_MAP); a cross-file parity test enforces they never drift.
// Keys are upper-case there; parseStar lowercases input, so look up via toUpperCase().
const { LETTER_GRADES: LETTER } = require('./score-extractors');

function clamp(n) { return Math.max(1, Math.min(100, Math.round(n))); }

/**
 * @param {string} raw  e.g. "3/5 stars", "★★★★", "Three stars", "B+"
 * @returns {{score:number, stars:number|null, outOf:number|null}|null}
 */
function parseStar(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().toLowerCase();
  if (!s) return null;

  // N/M (3/5, 3.5/5, 8/10) — the dominant shape.
  let m = s.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+)/);
  if (m) {
    const num = parseFloat(m[1]); const den = parseFloat(m[2]);
    if (den > 0 && num >= 0 && num <= den) return { score: clamp((num / den) * 100), stars: num, outOf: den };
  }

  // "N out of M" / "N out of five"
  m = s.match(/(\d+(?:\.\d+)?|one|two|three|four|five)\s*out of\s*(\d+|five|ten)/);
  if (m) {
    const num = WORD_NUM[m[1]] ?? parseFloat(m[1]);
    const den = m[2] === 'five' ? 5 : m[2] === 'ten' ? 10 : parseFloat(m[2]);
    if (Number.isFinite(num) && den > 0 && num <= den) return { score: clamp((num / den) * 100), stars: num, outOf: den };
  }

  // Glyph stars: count ★/⭑/✪ (+ optional ½). Out of 5 by convention.
  const glyphs = (s.match(/[★⭑✪]/g) || []).length;
  if (glyphs > 0) {
    const half = /[½⯨]/.test(s) ? 0.5 : 0;
    const stars = glyphs + half;
    if (stars <= 5) return { score: clamp((stars / 5) * 100), stars, outOf: 5 };
  }

  // "Three stars", "3 stars", "3.5 stars" (out of 5 implied)
  m = s.match(/(\d+(?:\.\d+)?|one|two|three|four|five)(?:\s*and a half)?\s*stars?\b/);
  if (m) {
    let stars = WORD_NUM[m[1]] ?? parseFloat(m[1]);
    if (/and a half/.test(s)) stars += 0.5;
    if (Number.isFinite(stars) && stars <= 5) return { score: clamp((stars / 5) * 100), stars, outOf: 5 };
  }

  // Letter grade (exact token).
  const lg = LETTER[s.toUpperCase()];
  if (lg != null) return { score: lg, stars: null, outOf: null };

  return null;
}

module.exports = { parseStar, clamp };
