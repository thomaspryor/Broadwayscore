/**
 * SeasonHistoryTable - the last 11 Broadway seasons side by side: mix
 * (musicals, revivals within each bucket), nonprofit share, recoupment and
 * disclosed capitalization (buildSeasonProfiles in season-profile.ts).
 * Recoupment and money cells read "—" where we track too few of a season's
 * productions to state them.
 */

import Link from 'next/link';
import {
  formatRowValue,
  hasFullCapitalCoverage,
  hasTrackedCoverage,
  type SeasonProfile,
} from '@/lib/season-profile';

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

export default function SeasonHistoryTable({ profiles, currentSeason }: { profiles: SeasonProfile[]; currentSeason: string | null }) {
  return (
    <div className="card rounded-xl overflow-hidden" data-testid="season-history">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-white/10 bg-surface-overlay">
              <th className="py-3 px-3 font-medium whitespace-nowrap sticky left-0 z-10 bg-surface-overlay">Season</th>
              <th className="py-3 px-3 font-medium text-right whitespace-nowrap">Productions</th>
              <th className="py-3 px-3 font-medium text-right whitespace-nowrap">Musicals</th>
              <th className="py-3 px-3 font-medium text-right whitespace-nowrap">Revivals</th>
              <th className="py-3 px-3 font-medium text-right whitespace-nowrap">Musical revivals</th>
              <th className="py-3 px-3 font-medium text-right whitespace-nowrap">Play revivals</th>
              <th className="py-3 px-3 font-medium text-right whitespace-nowrap">Nonprofit</th>
              <th className="py-3 px-3 font-medium text-right whitespace-nowrap">Recouped</th>
              <th className="py-3 px-3 font-medium text-right whitespace-nowrap">Disclosed capital</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => {
              const tracked = hasTrackedCoverage(p);
              // Sums sit side by side only where nearly every budget is public.
              const capital = hasFullCapitalCoverage(p) && p.season !== currentSeason;
              const current = p.season === currentSeason;
              return (
                <tr key={p.season} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-2.5 px-3 whitespace-nowrap sticky left-0 z-10 bg-surface-raised">
                    <Link href={`/biz/season/${p.season}`} className="text-brand hover:text-brand-hover font-medium">
                      {p.season}
                    </Link>
                    {current && <span className="block text-xs text-gray-500">so far + announced</span>}
                  </td>
                  <td className="py-2.5 px-3 text-right text-white font-semibold">{p.productions}</td>
                  <td className="py-2.5 px-3 text-right text-gray-300">
                    {pct(p.musicals, p.productions)}
                    <span className="block text-xs text-gray-500">{p.musicals}</span>
                  </td>
                  <td className="py-2.5 px-3 text-right text-gray-300">
                    {pct(p.revivals, p.revivalKnown)}
                    <span className="block text-xs text-gray-500">{p.revivals}</span>
                  </td>
                  <td className="py-2.5 px-3 text-right text-gray-300">{pct(p.musicalRevivals, p.musicalRevivalKnown)}</td>
                  <td className="py-2.5 px-3 text-right text-gray-300">{pct(p.playRevivals, p.playRevivalKnown)}</td>
                  <td className="py-2.5 px-3 text-right text-gray-300">{tracked ? pct(p.nonprofit, p.tracked) : '—'}</td>
                  <td className="py-2.5 px-3 text-right text-gray-300 whitespace-nowrap">
                    {tracked || current ? `${p.recouped} of ${p.commercial}` : '—'}
                  </td>
                  <td className="py-2.5 px-3 text-right text-gray-300 whitespace-nowrap">
                    {capital ? formatRowValue('money', p.capitalization.all.total) : '—'}
                    {(tracked || current) && p.capitalization.all.of > 0 && (
                      <span className="block text-xs text-gray-500">
                        {p.capitalization.all.known} of {p.capitalization.all.of} disclosed
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-gray-500">
        New Broadway productions by opening date (July 1 to June 30); 2020-21 had none and 2019-20 stopped in March 2020. Recouped counts commercial
        productions (nonprofit runs and tour stops have no investors to repay). &ldquo;—&rdquo; means we track too few of
        that season&apos;s productions to say; a capital sum shows only where at least 80% of budgets are disclosed. Recent seasons&apos; recoupment counts can still rise.
      </p>
    </div>
  );
}
