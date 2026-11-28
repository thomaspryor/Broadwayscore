/**
 * Market label for a critic's page copy ("Broadway Critic at X", "reviewed 3
 * West End shows"). The template used to hardcode "Broadway", so London-only
 * critics read as Broadway critics (BRO-5970).
 */
const CATEGORY_LABEL: Record<string, string> = {
  'broadway': 'Broadway',
  'off-broadway': 'Off-Broadway',
  'west-end': 'West End',
  'off-west-end': 'West End',
};

/** Dominant market of a critic's reviews; 'Theater' when no review has a known category. */
export function criticMarketLabel(reviews: ReadonlyArray<{ showCategory?: string | null }>): string {
  const counts = new Map<string, number>();
  for (const r of reviews) {
    const label = CATEGORY_LABEL[r.showCategory || ''];
    if (label) counts.set(label, (counts.get(label) || 0) + 1);
  }
  let best = 'Theater';
  let bestCount = 0;
  let total = 0;
  for (const [label, n] of Array.from(counts.entries())) {
    total += n;
    if (n > bestCount) { best = label; bestCount = n; }
  }
  // Mixed-market critics (under 80% one market) get the neutral label.
  return total > 0 && bestCount / total >= 0.8 ? best : 'Theater';
}

/** "1 West End show" / "3 Broadway shows". */
export function showCountPhrase(count: number, market: string): string {
  const noun = `show${count === 1 ? '' : 's'}`;
  return market === 'Theater' ? `${count} ${noun}` : `${count} ${market} ${noun}`;
}
