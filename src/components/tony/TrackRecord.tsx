/**
 * Shared Track Record section — historical accuracy of Tony predictions.
 * Used on both the /tony-awards/predictions umbrella (always expanded) and
 * the /tony-awards/predictions/[season] pages (collapsed by default).
 *
 * All counts derived from `summaries` so hero stat, per-category bars,
 * season-by-season grid, and miss cards stay internally consistent
 * regardless of upstream stats-computation path.
 */
import type { TonySeasonSummary } from '@/lib/data-tony-predictions';

interface Props {
  summaries: TonySeasonSummary[];
  /** Total Tony seasons (for the "across X Tony seasons" subtitle). */
  seasonCount: number;
}

export function TrackRecord({ summaries, seasonCount }: Props) {
  const completedSummaries = summaries.filter(s => s.hasTonyResults);
  let totalHits = 0;
  let totalCells = 0;
  const misses: Array<{ seasonLabel: string; categoryLabel: string; ourPick: string; tonyWinner: string }> = [];
  const CAT_COLS = ['Musical', 'Play', 'Revival Musical', 'Revival Play'];
  const catTotals: Record<string, { hits: number; total: number }> = {};
  for (const c of CAT_COLS) catTotals[c] = { hits: 0, total: 0 };
  for (const sum of completedSummaries) {
    for (const h of sum.categoryHighlights) {
      if (!h.winnerTitle) continue;
      totalCells++;
      if (catTotals[h.category]) catTotals[h.category].total++;
      if (h.topShowTitle && h.winnerTitle === h.topShowTitle) {
        totalHits++;
        if (catTotals[h.category]) catTotals[h.category].hits++;
      } else if (h.topShowTitle) {
        misses.push({
          seasonLabel: sum.season.label,
          categoryLabel: h.category,
          ourPick: h.topShowTitle,
          tonyWinner: h.winnerTitle,
        });
      }
    }
  }
  const accuracyPct = totalCells > 0 ? Math.round((totalHits / totalCells) * 1000) / 10 : 0;
  const byCategory = CAT_COLS.map(c => ({
    category: `Best ${c}`,
    hits: catTotals[c].hits,
    total: catTotals[c].total,
    pct: catTotals[c].total > 0 ? Math.round((catTotals[c].hits / catTotals[c].total) * 1000) / 10 : 0,
  }));
  const sortedCompleted = [...completedSummaries].sort((a, b) => b.season.ceremonyYear - a.season.ceremonyYear);

  return (
    <>
      {/* Hero stat */}
      <div className="text-center pb-5 mb-5 border-b border-white/5">
        <div className="text-5xl sm:text-6xl font-bold text-brand leading-none mb-2 tabular-nums tracking-tight">
          <span>{totalHits}</span><span className="text-gray-600 font-light mx-1">/</span><span>{totalCells}</span>
        </div>
        <p className="text-sm text-gray-300">
          Our #1 pick won across {seasonCount} Tony seasons &middot; <span className="text-white font-semibold">{accuracyPct}% accuracy</span>
        </p>
      </div>

      {/* Per-category bars — stacked label on mobile, inline on sm+ */}
      <div className="space-y-3 sm:space-y-2.5 mb-6">
        {byCategory.map(({ category, hits, total, pct }) => (
          <div key={category}>
            <div className="flex items-baseline justify-between mb-1 sm:hidden">
              <span className="text-sm text-gray-300">{category}</span>
              <span className="text-xs text-gray-500 tabular-nums">
                {hits}/{total} <span className="text-white font-bold ml-1">{pct}%</span>
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="hidden sm:inline text-sm text-gray-300 w-44 flex-shrink-0 truncate">{category}</span>
              <div className="flex-1 h-6 bg-white/5 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all ${pct === 100 ? 'bg-emerald-500/80' : pct >= 80 ? 'bg-brand/80' : 'bg-blue-500/70'}`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="hidden sm:inline text-xs text-gray-500 w-10 text-right tabular-nums">{hits}/{total}</span>
              <span className="hidden sm:inline text-sm font-bold text-white w-14 text-right tabular-nums">{pct}%</span>
            </div>
          </div>
        ))}
      </div>

      {/* Season-by-season grid */}
      <div className="mb-6">
        <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-3">Season by season</h3>
        <div className="overflow-x-auto -mx-1">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-gray-500 uppercase tracking-wide">
                <th className="text-left font-medium pb-2 px-1">Season</th>
                {CAT_COLS.map(c => (
                  <th key={c} className="text-center font-medium pb-2 px-1">
                    <span className="sm:hidden">{c.replace('Revival ', 'R. ').replace('Musical', 'Mus.').replace('Play', 'Play')}</span>
                    <span className="hidden sm:inline">{c}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedCompleted.map(sum => (
                <tr key={sum.season.label} className="border-t border-white/5">
                  <td className="py-2 px-1 text-white font-medium whitespace-nowrap">{sum.season.label}</td>
                  {CAT_COLS.map(c => {
                    const h = sum.categoryHighlights.find(x => x.category === c);
                    if (!h || !h.winnerTitle) {
                      return <td key={c} className="text-center text-gray-600 py-2 px-1">&mdash;</td>;
                    }
                    const hit = h.topShowTitle === h.winnerTitle;
                    return (
                      <td key={c} className="text-center py-2 px-1">
                        {hit ? (
                          <span className="text-emerald-400" aria-label="hit">✓</span>
                        ) : (
                          <span className="text-amber-400" aria-label="miss">✗</span>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Where we missed */}
      {misses.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wider mb-1">Where we missed ({misses.length})</h3>
          <p className="text-xs text-gray-500 mb-3">
            Our #1 didn&apos;t match the Tony winner in these category-seasons. Most are voter-sentiment upsets (cultural significance, star power) that blended scores can&apos;t fully capture.
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            {misses.map(m => (
              <div key={`${m.seasonLabel}-${m.categoryLabel}`} className="rounded-lg border border-white/5 bg-white/[0.02] p-3">
                <div className="text-xs text-gray-500 mb-1">
                  {m.seasonLabel} &middot; Best {m.categoryLabel}
                </div>
                <div className="text-sm text-gray-300 space-y-0.5">
                  <div>
                    <span className="text-gray-500 text-xs">Our #1:</span> <span className="text-white">{m.ourPick}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 text-xs">Tony:</span> <span className="text-amber-400 font-medium">{m.tonyWinner}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
