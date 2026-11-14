import type { CeremonyContribution, ScoreResult, TierBadge } from '@/lib/awards-scoring';

// Moved out of SortableAwardScoreTable (BRO-5968) so the server can compute the
// Notable label and ship only that string, not the full per-ceremony breakdown.
function categoryShort(category: string): string {
  const c = category.toLowerCase();
  if (/best musical$|outstanding musical/.test(c)) return 'Best Musical';
  if (/best play$|outstanding play/.test(c)) return 'Best Play';
  if (/revival of a musical/.test(c)) return 'Best Revival (Musical)';
  if (/revival of a play/.test(c)) return 'Best Revival (Play)';
  if (/best.*score|outstanding.*score/.test(c)) return 'Best Score';
  if (/best book|outstanding book/.test(c)) return 'Best Book';
  if (/direction|director/.test(c)) return 'Best Direction';
  if (/choreograph/.test(c)) return 'Best Choreography';
  if (/distinguished performance|best actor|best actress|lead.*performance|lead.*performer/.test(c)) return 'Lead Performance';
  if (/featured/.test(c)) return 'Featured Performance';
  if (/^drama$/.test(c)) return 'Drama';
  return category.length > 24 ? category.slice(0, 24) + '…' : category;
}

function isBestShowCategory(category: string): boolean {
  const c = category.toLowerCase();
  return /best (musical|play)$|revival of a (musical|play)/.test(c);
}

// Returns a single notable win label for the Notable column, or null if none.
// Only returns win-type results (no nom-count fallback — that lives in Tony Record column).
export function computeNotableWin(breakdown: CeremonyContribution[], tonyWins: number): string | null {
  // Pulitzer — always most prestigious
  const pulitzer = breakdown.find(b => b.ceremony === 'Pulitzer Prize');
  if (pulitzer) {
    if (pulitzer.items.find(i => i.result === 'win')) return 'Pulitzer Drama';
    if (pulitzer.items.find(i => i.result === 'nom')) return 'Pulitzer Finalist';
  }

  // NYDCC
  const nydcc = breakdown.find(b => b.ceremony === "NY Drama Critics' Circle");
  if (nydcc?.items.find(i => i.result === 'win')) return 'NYDCC Winner';

  const tony = breakdown.find(b => b.ceremony === 'Tony Awards');

  // Sweepers: "X Tony Wins" is more distinctive than listing one category
  if (tonyWins >= 3) return `${tonyWins} Tony Wins`;

  // Notable Tony win that isn't Best Musical/Play (more distinctive than Best Show)
  if (tony) {
    const notableWin = tony.items.find(i => i.result === 'win' && !isBestShowCategory(i.category));
    if (notableWin) return `Tony · ${categoryShort(notableWin.category)}`;

    // Best Musical/Play/Revival win as fallback
    const bestShowWin = tony.items.find(i => i.result === 'win' && isBestShowCategory(i.category));
    if (bestShowWin) return `Tony · ${categoryShort(bestShowWin.category)}`;
  }

  return null;
}

/** The ScoreResult fields the award table renders; breakdown is reduced to `notableWin`. */
export interface SlimAwardScore {
  displayScore: number;
  badge: TierBadge;
  inProgress: boolean;
  tonyWins: number;
  tonyNoms: number;
  tonySeason?: string;
  notableWin: string | null;
}

export function toSlimAwardScore(score: ScoreResult): SlimAwardScore {
  return {
    displayScore: score.displayScore,
    badge: score.badge,
    inProgress: score.inProgress,
    tonyWins: score.tonyWins,
    tonyNoms: score.tonyNoms,
    tonySeason: score.tonySeason,
    notableWin: computeNotableWin(score.breakdown, score.tonyWins),
  };
}
