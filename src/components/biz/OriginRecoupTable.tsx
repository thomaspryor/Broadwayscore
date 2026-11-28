/**
 * OriginRecoupTable - share of commercial new productions that recouped, by
 * route or source bucket, split into musicals and plays (show-origins.ts).
 * Public Path to Broadway page (BRO-5842): only shows that recouped are named.
 */

import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import ShowLinkListItem from '@/components/biz/ShowLinkListItem';
import { recoupRate, type RateCell, type RecoupRow } from '@/lib/show-origins';

/** Under this many shows a rate is shown, but dimmed, as a rough figure. */
export const SOLID_SAMPLE = 20;

function Cell({ cell }: { cell: RateCell }) {
  const r = recoupRate(cell);
  return (
    <td className="py-2.5 px-2 sm:px-4 text-center whitespace-nowrap align-top">
      <span className={`font-semibold ${cell.total >= SOLID_SAMPLE ? 'text-white' : 'text-gray-400'}`}>{r == null ? '—' : `${Math.round(r * 100)}%`}</span>
      <span className="block text-xs text-fg-muted">{cell.recouped} of {cell.total}</span>
    </td>
  );
}

export default function OriginRecoupTable<Id extends string>({
  rows,
  testId,
  noun,
}: {
  rows: Array<RecoupRow<Id>>;
  testId: string;
  /** Lower-case name for the summary line, e.g. "routes". */
  noun: string;
}) {
  rows = rows.filter((r) => r.all.total > 0);
  const maxRate = Math.max(...rows.map((r) => recoupRate(r.all) ?? 0), 0.01);
  const withNames = rows.filter((r) => r.all.recoupedShows.length > 0);
  return (
    <div className="card rounded-xl overflow-hidden" data-testid={testId}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-white/10">
              <th className="py-2 px-3 sm:px-4 font-medium"><span className="sr-only">Group</span></th>
              <th className="py-2 px-2 sm:px-4 font-medium text-center">All</th>
              <th className="py-2 px-2 sm:px-4 font-medium text-center">Musicals</th>
              <th className="py-2 px-2 sm:px-4 font-medium text-center">Plays</th>
              <th className="py-2 px-3 sm:px-4 font-medium w-1/4 hidden sm:table-cell"><span className="sr-only">Rate</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const rate = recoupRate(r.all);
              return (
                <tr key={r.id} className="border-b border-white/5 last:border-b-0">
                  <td className="py-2.5 px-3 sm:px-4 text-gray-300">{r.label}</td>
                  <Cell cell={r.all} />
                  <Cell cell={r.musicals} />
                  <Cell cell={r.plays} />
                  <td className="py-2.5 px-3 sm:px-4 hidden sm:table-cell">
                    <div className="h-2 rounded-full bg-white/5">
                      <div className="h-2 rounded-full bg-brand" style={{ width: `${((rate ?? 0) / maxRate) * 100}%` }} />
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {withNames.length > 0 && (
        <div className="px-4 py-3 space-y-1 text-sm border-t border-white/5">
          <p className="text-xs text-fg-muted mb-1">Shows that recouped, by {noun}:</p>
          {withNames.map((r) => (
            <details key={r.id}>
              <summary className="cursor-pointer text-brand hover:text-brand-hover">
                {r.label} ({r.all.recoupedShows.length})
              </summary>
              <ul className="mt-1 mb-2 ml-4 flex flex-wrap gap-x-4 gap-y-1">
                {r.all.recoupedShows.map((s) => (
                  <ShowLinkListItem key={s.slug} href={`/show/${s.slug}`}>
                    <Link href={`/show/${s.slug}`} className="text-gray-300 hover:text-white underline decoration-white/25 underline-offset-2 hover:decoration-white"><RowLinkArrow label={s.title} /></Link>
                    <span className="text-fg-muted"> ({s.year})</span>
                  </ShowLinkListItem>
                ))}
              </ul>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
