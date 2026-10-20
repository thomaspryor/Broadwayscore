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
              <th className="py-3 px-2 sm:px-4 font-medium text-right sm:whitespace-nowrap">
                {shortSeason(season)}{inProgress ? ' so far' : ''}
              </th>
              <th className="py-3 px-2 sm:px-4 font-medium text-right sm:whitespace-nowrap">
                {lastSeason ? shortSeason(lastSeason) : 'Last season'}
              </th>
              <th className="py-3 px-2 sm:px-4 font-medium text-right sm:whitespace-nowrap">Prior seasons avg</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-b border-white/5">
                <td className="py-2.5 pl-3 pr-2 sm:px-4 text-gray-300">{row.label}</td>
                <td className="py-2.5 px-2 sm:px-4 text-right sm:whitespace-nowrap">
                  <span className="font-semibold text-white">{formatRowValue(row.format, row.current)}</span>
                  {row.currentDetail && <span className="block text-xs text-gray-500">{row.currentDetail}</span>}
                </td>
                <td className="py-2.5 px-2 sm:px-4 text-right text-gray-300 whitespace-nowrap">{formatRowValue(row.format, row.last)}</td>
                <td className="py-2.5 px-2 sm:px-4 text-right text-gray-300 whitespace-nowrap">
                  {formatRowValue(row.format, row.avg)}
                  {row.avg != null && row.avgSeasons < baselineSeasons && (
                    <span className="block text-xs text-gray-500">{row.avgSeasons} {row.avgSeasons === 1 ? 'season' : 'seasons'}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="px-4 py-3 text-xs text-gray-500 space-y-1">
        {avgLabel && (
          <p>
            Average: the {baselineSeasons} seasons {avgLabel}, leaving out the pandemic seasons 2019-20 and 2020-21.
            Shares are pooled across those seasons.
          </p>
        )}
        {inProgress && (
          <p>
            &ldquo;Opened so far&rdquo; compares the same point in each season. Other rows count the announced
            slate against whole seasons.{hasMoney && ' Budget averages for this season need most of its announced shows disclosed.'}
          </p>
        )}
        {lastDisrupted && lastSeason && <p>{shortSeason(lastSeason)} stopped in March 2020 when theaters closed.</p>}
        {recoupUnsettled && (
          <p>Recoupment marked &ldquo;so far&rdquo; and recent seasons&apos; rates can still rise while their shows run.</p>
        )}
        {partialAvg && (
          <p>
            Rows marked with a season count average fewer seasons: only those where we have most productions&apos;
            figures (recoupment: only seasons that ended over a year ago). Shares{hasMoney && ' and averages'} need at least 3 shows.
            {hasMoney && ' Money averages are per show with a disclosed figure, averaged across seasons. The capitalization sum is compared only between finished seasons where nearly every budget is public.'}
          </p>
        )}
        <p>
          Seasons run July 1 to June 30 by opening date.{hasMoney && ' Running costs and some capitalizations are estimates.'}
        </p>
      </div>
    </div>
  );
}
