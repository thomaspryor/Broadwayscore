/**
 * SeasonHistoryTable - every covered Broadway season side by side: mix
 * (musicals, revivals within each bucket), nonprofit share, recoupment and
 * disclosed and estimated capitalization (buildSeasonProfiles in
 * season-profile.ts), with an average row under it (seasonHistoryAverage).
 * Recoupment and money cells read "—" where we track too few of a season's
 * productions to state them.
 */

import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import {
  formatSeasonMoney,
  hasEstimatedCapital,
  hasFullCapitalCoverage,
  returnedCapitalText,
  hasTrackedCoverage,
  seasonHistoryAverage,
  type SeasonProfile,
} from '@/lib/season-profile';

function pct(n: number, d: number): string {
  return d > 0 ? `${Math.round((n / d) * 100)}%` : '—';
}

function sharePct(share: number | null): string {
  return share == null ? '—' : `${Math.round(share * 100)}%`;
}

/** Under a season's estimated capital total: how much is estimated, and how many productions it leaves out. */
function estimateNotes(p: SeasonProfile): string[] {
  const e = p.estimatedCapital;
  const out = e.missing + e.nonprofitOut + (p.productions - p.tracked);
  return [e.estimated > 0 ? `${e.estimated} estimated` : 'all disclosed', ...(out > 0 ? [`${out} left out`] : [])];
}

/** "4 seasons" under an average that rests on fewer seasons than the row. */
function seasonsNote(n: number, of: number): string | null {
  return n > 0 && n < of ? `${n} season${n === 1 ? '' : 's'}` : null;
}

interface SeasonHistoryTableProps {
  profiles: SeasonProfile[];
  /** Seasons the average row rests on (selectSeasonAverageBase); default: all rows. */
  averageProfiles?: SeasonProfile[];
  currentSeason: string | null;
  /** Market date (YYYY-MM-DD): which seasons' recoupment has settled for the average row. */
  asOf: string;
  /** Disclosed and estimated capital columns (the held /biz page only). */
  showCapital?: boolean;
  /** Link each season to /biz/season/[season] (the held /biz page only). */
  linkSeasons?: boolean;
}

export default function SeasonHistoryTable({ profiles, averageProfiles, currentSeason, asOf, showCapital = true, linkSeasons = true }: SeasonHistoryTableProps) {
  const avg = seasonHistoryAverage(averageProfiles ?? profiles, currentSeason, asOf);
  const cellNote = (note: string | null) => note && <span className="block text-xs text-fg-muted">{note}</span>;
  return (
    <div className="card rounded-xl overflow-hidden" data-testid="season-history">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-white/10 bg-surface-overlay leading-tight">
              <th className="py-3 px-3 font-medium whitespace-nowrap sticky left-0 z-10 bg-surface-overlay">Season</th>
              <th className="py-3 px-3 font-medium text-center whitespace-nowrap">Productions</th>
              <th className="py-3 px-3 font-medium text-center whitespace-nowrap">Recouped</th>
              {showCapital && <th className="py-3 px-3 font-medium text-center whitespace-nowrap">Disclosed<br />capital</th>}
              {showCapital && <th className="py-3 px-3 font-medium text-center whitespace-nowrap">Est. total<br />capital</th>}
              {showCapital && <th className="py-3 px-3 font-medium text-center whitespace-nowrap">Est. money<br />back so far</th>}
              <th className="py-3 px-3 font-medium text-center whitespace-nowrap">Musicals</th>
              <th className="py-3 px-3 font-medium text-center whitespace-nowrap">Revivals</th>
              <th className="hidden md:table-cell py-3 px-3 font-medium text-center whitespace-nowrap">Revivals among<br />musicals</th>
              <th className="hidden md:table-cell py-3 px-3 font-medium text-center whitespace-nowrap">Revivals among<br />plays</th>
              <th className="hidden md:table-cell py-3 px-3 font-medium text-center whitespace-nowrap">Nonprofit</th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => {
              const tracked = hasTrackedCoverage(p);
              // Sums sit side by side only where nearly every budget is public.
              const capital = hasFullCapitalCoverage(p) && p.season !== currentSeason;
              const current = p.season === currentSeason;
              const back = returnedCapitalText(p);
              return (
                <tr key={p.season} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td className="py-2.5 px-3 whitespace-nowrap sticky left-0 z-10 bg-surface-raised">
                    {linkSeasons && p.tracked > 0 ? (
                      <Link href={`/biz/season/${p.season}`} className="group text-brand hover:text-brand-hover font-medium">
                        <RowLinkArrow label={p.season} />
                      </Link>
                    ) : (
                      <span className="text-white font-medium">{p.season}</span>
                    )}
                    {current && <span className="block text-xs text-fg-muted">so far + announced</span>}
                  </td>
                  <td className="py-2.5 px-3 text-center text-white font-semibold">{p.productions}</td>
                  <td className="py-2.5 px-3 text-center text-gray-300 whitespace-nowrap">
                    {(tracked || current) && p.outcomeKnown > 0 ? `${p.recouped} of ${p.outcomeKnown}` : '—'}
                    {(tracked || current) && p.commercial > p.outcomeKnown && (
                      <span className="block text-xs text-fg-muted">{p.commercial - p.outcomeKnown} unconfirmed left out</span>
                    )}
                  </td>
                  {showCapital && (
                    <td className="py-2.5 px-3 text-center text-gray-300 whitespace-nowrap">
                      {capital ? formatSeasonMoney(p.capitalization.all.total) : '—'}
                      {(tracked || current) && p.capitalization.all.of > 0 && (
                        <span className="block text-xs text-fg-muted">
                          {p.capitalization.all.known} of {p.capitalization.all.of} disclosed
                        </span>
                      )}
                    </td>
                  )}
                  {showCapital && (
                    <td className="py-2.5 px-3 text-center text-gray-300 whitespace-nowrap">
                      {hasEstimatedCapital(p) && !current ? formatSeasonMoney(p.estimatedCapital.total) : '—'}
                      {hasEstimatedCapital(p) && !current && estimateNotes(p).map((n) => <span key={n} className="block text-xs text-fg-muted">{n}</span>)}
                    </td>
                  )}
                  {showCapital && (
                    <td className="py-2.5 px-3 text-center text-gray-300 whitespace-nowrap" data-testid="season-money-back">
                      {back ? `~${formatSeasonMoney(p.returnedCapital.mid)} back` : '—'}
                      {back && <span className="block text-xs text-fg-muted">of {formatSeasonMoney(p.returnedCapital.capital)} in</span>}
                      {back && <span className="block text-xs text-fg-muted">{back.range}</span>}
                    </td>
                  )}
                  <td className="py-2.5 px-3 text-center text-gray-300">
                    {pct(p.musicals, p.productions)}
                    <span className="block text-xs text-fg-muted">{p.musicals}</span>
                  </td>
                  <td className="py-2.5 px-3 text-center text-gray-300">
                    {pct(p.revivals, p.revivalKnown)}
                    <span className="block text-xs text-fg-muted">{p.revivals}</span>
                  </td>
                  <td className="hidden md:table-cell py-2.5 px-3 text-center text-gray-300">{pct(p.musicalRevivals, p.musicalRevivalKnown)}</td>
                  <td className="hidden md:table-cell py-2.5 px-3 text-center text-gray-300">{pct(p.playRevivals, p.playRevivalKnown)}</td>
                  <td className="hidden md:table-cell py-2.5 px-3 text-center text-gray-300">{tracked ? pct(p.nonprofit, p.tracked) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
          {avg.seasons > 0 && (
            <tfoot>
              <tr className="border-t border-white/10 bg-surface-overlay font-medium" data-testid="season-history-average">
                <th scope="row" className="py-2.5 px-3 text-left font-medium whitespace-nowrap sticky left-0 z-10 bg-surface-overlay text-white">
                  Average
                  <span className="block text-xs text-fg-muted font-normal">of {avg.seasons} completed seasons</span>
                </th>
                <td className="py-2.5 px-3 text-center text-white">{avg.productions == null ? '—' : Math.round(avg.productions)}</td>
                <td className="py-2.5 px-3 text-center text-gray-300 whitespace-nowrap">
                  {avg.recouped ? `${Math.round(avg.recouped.recouped)} of ${Math.round(avg.recouped.commercial)}` : '—'}
                  {avg.recouped && cellNote(seasonsNote(avg.recouped.seasons, avg.seasons))}
                </td>
                {showCapital && (
                  <td className="py-2.5 px-3 text-center text-gray-300 whitespace-nowrap">
                    {formatSeasonMoney(avg.disclosedCapital.avg)}
                    {cellNote(seasonsNote(avg.disclosedCapital.seasons, avg.seasons))}
                  </td>
                )}
                {showCapital && (
                  <td className="py-2.5 px-3 text-center text-gray-300 whitespace-nowrap">
                    {formatSeasonMoney(avg.estimatedCapital.avg)}
                    {cellNote(seasonsNote(avg.estimatedCapital.seasons, avg.seasons))}
                  </td>
                )}
                {showCapital && <td className="py-2.5 px-3 text-center text-fg-muted">—</td>}
                <td className="py-2.5 px-3 text-center text-gray-300 whitespace-nowrap">
                  {sharePct(avg.musicals.share)}
                  {cellNote(avg.musicals.count == null ? null : `${Math.round(avg.musicals.count)} a season`)}
                </td>
                <td className="py-2.5 px-3 text-center text-gray-300 whitespace-nowrap">
                  {sharePct(avg.revivals.share)}
                  {cellNote(avg.revivals.count == null ? null : `${Math.round(avg.revivals.count)} a season`)}
                </td>
                <td className="hidden md:table-cell py-2.5 px-3 text-center text-gray-300">{sharePct(avg.musicalRevivals)}</td>
                <td className="hidden md:table-cell py-2.5 px-3 text-center text-gray-300">{sharePct(avg.playRevivals)}</td>
                <td className="hidden md:table-cell py-2.5 px-3 text-center text-gray-300">{sharePct(avg.nonprofit)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-fg-muted">
        New Broadway productions by opening date (July 1 to June 30); 2020-21 had none and 2019-20 stopped in March 2020. Recouped counts commercial
        productions with a known outcome (nonprofit runs and tour stops have no investors to repay; closed shows with no confirmed recoupment status, only our own estimate, are left out of the count and noted in the cell). &ldquo;—&rdquo; means we track too few of
        that season&apos;s productions to say{showCapital && '; a disclosed capital sum shows only where at least 80% of budgets are disclosed'}. Recent seasons&apos;
        recoupment counts can still rise.
        {showCapital && ' Est. total capital adds, for each tracked commercial production with no public figure, our own estimate of its budget where we have one (never counted as disclosed), else the median disclosed capitalization of similar shows (same type and original or revival, opening within two seasons, else four, else the same type within four); left out are nonprofit-presented runs with no public figure and productions we do not track (the cell counts them). Disclosed figures include SEC filing maximums, so both capital columns can run high. Est. money back so far is our estimate of how much of the capital in those shows has come back to investors (recouped shows at their reported return, otherwise an estimate: our model from weekly grosses and costs, or an outside estimate, never above 99% for a show not yet recouped), with the range below it; it counts only shows we can estimate and rises as running shows pay back.'}
        {' '}The average row covers finished seasons, leaving out the season under way and the pandemic seasons; recoupment averages only seasons that ended over a year ago.
      </p>
    </div>
  );
}
