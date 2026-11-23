/**
 * Venue "Avg Score" tile data, shared by the Broadway, Off-Broadway and West End theater pages.
 * The average is a plain mean of the venue's shows that have a critic score. The label states how
 * many shows it rests on so a venue with one or two scored shows does not read as authoritative.
 */
interface ScoredShowLike {
  criticScore?: { score?: number | null } | null;
}

export function getTheaterAvgScore(shows: ScoredShowLike[]): { avgScore: number | null; sampleLabel?: string } {
  const scores = shows
    .map(show => show.criticScore?.score)
    .filter((score): score is number => score != null);
  if (scores.length === 0) return { avgScore: null };
  const avgScore = Math.round(scores.reduce((sum, score) => sum + score, 0) / scores.length);
  return { avgScore, sampleLabel: `based on ${scores.length} ${scores.length === 1 ? 'show' : 'shows'}` };
}
