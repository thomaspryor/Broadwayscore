/**
 * OriginMixTable - share of new Broadway productions in each route or source
 * bucket, one column per era (show-origins.ts). Public Path to Broadway page
 * (BRO-5842): counts only, no money figures.
 */

import { ERAS, type MixRow } from '@/lib/show-origins';

/** Below this many shows the current-season column is dimmed: early in a season one show swings it. */
const SOLID_SEASON = 10;

export default function OriginMixTable<Id extends string>({
  rows,
  totals,
  current,
  testId,
}: {
  rows: Array<MixRow<Id>>;
  totals: number[];
  /** Extra far-right column for the season under way; omitted when no show has opened in it yet. */
  current?: { label: string; total: number } | null;
  testId: string;
}) {
  const share = (n: number, d: number) => (d > 0 ? n / d : 0);
  return (
    <div className="card rounded-xl overflow-x-auto" data-testid={testId}>
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-gray-400 border-b border-white/10">
            <th className="py-2 px-2 sm:px-4 font-medium"><span className="sr-only">Group</span></th>
            {ERAS.map((e, i) => (
              <th key={e.id} className="py-2 px-1 sm:px-4 font-medium text-center">
                <span className="block text-white">{e.id}</span>
                <span className="block text-[11px] leading-tight font-normal text-fg-muted">{e.short}</span>
                <span className="block text-xs font-normal text-fg-muted">{totals[i]} {totals[i] === 1 ? 'show' : 'shows'}</span>
              </th>
            ))}
            {current && (
              <th className="py-2 px-1 sm:px-4 font-medium text-center border-l border-white/10">
                <span className="block text-white whitespace-nowrap">{current.label}</span>
                <span className="block text-[11px] leading-tight font-normal text-fg-muted">opened + announced</span>
                <span className="block text-xs font-normal text-fg-muted">{current.total} {current.total === 1 ? 'show' : 'shows'}</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-white/5 last:border-b-0">
              <td className="py-2.5 px-2 sm:px-4 text-gray-300 text-xs sm:text-sm">{r.label}</td>
              {r.counts.map((n, i) => {
                const s = share(n, totals[i]);
                return (
                  <td key={ERAS[i].id} className="py-2.5 px-1 sm:px-4 text-center align-top">
                    <span className="font-semibold text-white">{totals[i] ? `${Math.round(s * 100)}%` : '—'}</span>
                    <span className="block text-xs text-fg-muted">{n}</span>
                    <div className="mt-1 h-1.5 rounded-full bg-white/5 mx-auto max-w-[6rem]">
                      <div className="h-1.5 rounded-full bg-brand" style={{ width: `${s * 100}%` }} />
                    </div>
                  </td>
                );
              })}
              {current && (
                <td className="py-2.5 px-1 sm:px-4 text-center align-top border-l border-white/10">
                  <span className={`font-semibold ${current.total >= SOLID_SEASON ? 'text-white' : 'text-gray-400'}`}>{current.total ? `${Math.round(share(r.current, current.total) * 100)}%` : '—'}</span>
                  <span className="block text-xs text-fg-muted">{r.current}</span>
                  <div className="mt-1 h-1.5 rounded-full bg-white/5 mx-auto max-w-[6rem]">
                    <div className="h-1.5 rounded-full bg-brand" style={{ width: `${share(r.current, current.total) * 100}%` }} />
                  </div>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
