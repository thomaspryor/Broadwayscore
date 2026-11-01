// Audience letter grade for scripts (videos, social posts). Audience is always a GRADE, never a number.
// Mirrors getAudienceGrade() in src/lib/audience-grade-utils.ts (TS cannot be required from node scripts);
// scripts/lib/audience-grade.test.js fails if the thresholds, letters or colours drift apart.
const MIN_AUDIENCE_REVIEWS = 15;
const BANDS = [
  [90, 'A+', '#22c55e', '#ffffff'], [88, 'A', '#16a34a', '#ffffff'], [83, 'A-', '#14b8a6', '#ffffff'],
  [78, 'B+', '#0ea5e9', '#ffffff'], [73, 'B', '#f59e0b', '#1a1a1a'], [68, 'B-', '#f97316', '#1a1a1a'],
  [63, 'C+', '#ef4444', '#ffffff'], [58, 'C', '#dc2626', '#ffffff'], [53, 'C-', '#b91c1c', '#ffffff'],
  [48, 'D', '#991b1b', '#ffffff'],
];
function getAudienceGrade(score) {
  if (score == null) return null;
  for (const [min, grade, color, textColor] of BANDS) if (score >= min) return { grade, color, textColor };
  return { grade: 'F', color: '#6b7280', textColor: '#ffffff' };
}
// slim data au.sources.<src>.c is the per-source review count
function totalAudienceReviews(au) {
  return Object.values((au && au.sources) || {}).reduce((n, s) => n + ((s && s.c) || 0), 0);
}
module.exports = { MIN_AUDIENCE_REVIEWS, BANDS, getAudienceGrade, totalAudienceReviews };
