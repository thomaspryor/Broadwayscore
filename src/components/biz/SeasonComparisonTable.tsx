/**
 * SeasonComparisonTable - one season's mix, capital and recoupment next to
 * last season and the 10-season average (compareSeason in season-profile.ts).
 */

import { formatRowValue, type SeasonComparison } from '@/lib/season-profile';

function shortSeason(season: string): string {
  return `${season.slice(0, 4)}-${season.slice(7)}`;
}

export default function SeasonComparisonTable({ comparison }: { comparison: SeasonComparison }) {
  const { season, lastSeason, baselineRange, baselineSeasons, inProgress, lastDisrupted, recoupUnsettled, rows } = comparison;
  const avgLabel = baselineRange ? `${shortSeason(baselineRange[0])} to ${shortSeason(baselineRange[1])}` : null;
  const partialAvg = rows.some((r) => r.avg != null && r.avgSeasons < baselineSeasons);
  const hasMoney = rows.some((r) => r.format === 'money');

  return (
    <div className="card rounded-xl overflow-hidden" data-testid="season-comparison">
      <div className="overflow-x-auto">
        <table className="w-full text-xs sm:text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-white/10 bg-surface-overlay">
              <th className="py-3 pl-3 pr-2 sm:px-4 font-medium"><span className="sr-only">Measure</span></th>
              <th className="py-3 px-2 sm:px-4 font-medium text-center sm:whitespace-nowrap">
                {shortSeason(season)}{inProgress ? ' so far' : ''}
              </th>
              <th className="py-3 px-2 sm:px-4 font-medium text-center sm:whitespace-nowrap bg-white/[0.03]">
                {lastSeason ? shortSeason(lastSeason) : 'Last season'}
              </th>
              <th className="py-3 px-2 sm:px-4 font-medium text-center sm:whitespace-nowrap bg-white/[0.03]">Prior seasons avg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const partial = row.avg != null && row.avgSeasons < baselineSeasons;
              return (
                <tr key={row.label} className="border-b border-white/5">
                  <td className="py-2.5 pl-3 pr-2 sm:px-4 text-gray-300">{row.label}</td>
                  <td className="py-2.5 px-2 sm:px-4 text-center sm:whitespace-nowrap">
                    <span className="font-semibold text-white">{formatRowValue(row.format, row.current)}</span>
                    {row.currentDetail && <span className="block text-xs text-gray-500">{row.currentDetail}</span>}
                  </td>
                  <td className="py-2.5 px-2 sm:px-4 text-center text-gray-300 sm:whitespace-nowrap bg-white/[0.03]">
                    {formatRowValue(row.format, row.last)}
                    {row.lastDetail && <span className="block text-xs text-gray-500">{row.lastDetail}</span>}
                  </td>
                  <td className="py-2.5 px-2 sm:px-4 text-center text-gray-300 sm:whitespace-nowrap bg-white/[0.03]">
                    {formatRowValue(row.format, row.avg)}{partial && '*'}
                    {row.avgDetail && <span className="block text-xs text-gray-500">{row.avgDetail}</span>}
                    {partial && (
                      <span className="block text-xs text-gray-500">{row.avgSeasons} {row.avgSeasons === 1 ? 'season' : 'seasons'}</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-3 text-xs text-gray-500 space-y-1">
        {avgLabel && (
          <p>
            Prior seasons avg covers {avgLabel} ({baselineSeasons} seasons, skipping 2019-20 and 2020-21). Counts under
            it are per season.
          </p>
        )}
        {inProgress && (
          <p>
            &ldquo;Opened so far&rdquo; compares the same date in each season. The other rows count every show opened
            or announced for this season.
          </p>
        )}
        {lastDisrupted && lastSeason && <p>{shortSeason(lastSeason)} stopped in March 2020 when theaters closed.</p>}
        {recoupUnsettled && <p>Shows still running can recoup later, so recent seasons&apos; recoupment rates can still rise.</p>}
        {partialAvg && <p>* Averages only the seasons where we have the figures (for recoupment, seasons that ended over a year ago).</p>}
        {hasMoney && (
          <p>
            Money figures cover only the budgets and running costs made public, so each sum is a floor. Some are
            estimates.
          </p>
        )}
        <p>Seasons run July 1 to June 30 by opening night.</p>
      </div>
    </div>
  );
}
