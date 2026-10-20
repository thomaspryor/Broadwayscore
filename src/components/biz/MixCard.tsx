/**
 * MixCard - a season's production mix as the 2x2 of musicals/plays by
 * original/revival (owner, 2026-10-20), set beside last season and the
 * prior-seasons average: a 100% stacked bar per column, the 2x2 counts, and
 * the within-group shares (compareSeason rows). Server-rendered, CSS only.
 */

import { formatRowValue, type ComparisonRow, type MixBreakdown } from '@/lib/season-profile';

const SEGMENTS = [
  { key: 'originalMusicals', label: 'Original musicals', className: 'bg-brand' },
  { key: 'musicalRevivals', label: 'Musical revivals', className: 'bg-brand/55' },
  { key: 'originalPlays', label: 'Original plays', className: 'bg-accent-purple' },
  { key: 'playRevivals', label: 'Play revivals', className: 'bg-accent-purple/55' },
] as const;

export interface MixColumn {
  /** Column heading, e.g. "2026-27 so far". */
  label: string;
  /** Under the heading, e.g. "28 productions" or "10 seasons pooled". */
  note: string;
  mix: MixBreakdown;
  /** Show the counts (a single season) or only shares (a pooled average). */
  showCounts: boolean;
  /** Which compareSeason value fills this column in the within-group rows. */
  value: 'current' | 'last' | 'avg';
}

function share(n: number, total: number): number | null {
  return total > 0 ? n / total : null;
}

function StackedBar({ m }: { m: MixBreakdown }) {
  return (
    <div className="flex h-4 w-full overflow-hidden rounded-full bg-white/5" aria-hidden="true">
      {SEGMENTS.map((s) => {
        const pct = (share(m[s.key], m.total) ?? 0) * 100;
        // A divider between segments keeps the lighter revival shades distinct from their solid neighbours.
        return pct > 0 ? <div key={s.key} className={`${s.className} border-r-2 border-surface-raised last:border-r-0`} style={{ width: `${pct}%` }} /> : null;
      })}
    </div>
  );
}

function GroupRows({ title, rows, columns }: { title: string; rows: ComparisonRow[]; columns: MixColumn[] }) {
  if (!rows.length) return null;
  return (
    <tbody>
      <tr className="text-left text-gray-400 border-b border-white/10 bg-surface-overlay">
        <th className="py-2.5 pl-3 pr-2 sm:px-4 font-medium" colSpan={columns.length + 1}>{title}</th>
      </tr>
      {rows.map((r) => (
        <tr key={r.label} className="border-b border-white/5">
          <td className="py-2 pl-3 pr-2 sm:px-4 text-gray-300">{r.label}</td>
          {columns.map((c) => (
            <td key={c.label} className="py-2 px-2 sm:px-4 text-center whitespace-nowrap">
              <span className={c.value === 'current' ? 'font-semibold text-white' : 'text-gray-300'}>{formatRowValue(r.format, r[c.value])}</span>
              {c.value === 'current' && r.currentDetail && <span className="block text-xs text-gray-500">{r.currentDetail}</span>}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

export default function MixCard({ columns, overallRows, withinRows }: { columns: MixColumn[]; overallRows: ComparisonRow[]; withinRows: ComparisonRow[] }) {
  return (
    <div className="card rounded-xl overflow-hidden" data-testid="mix-card">
      <div className="p-4 space-y-3">
        {columns.map((c) => (
          <div key={c.label} className="grid grid-cols-[7.5rem_1fr] sm:grid-cols-[11rem_1fr] items-center gap-3">
            <div className="text-sm">
              <div className="text-white font-medium">{c.label}</div>
              <div className="text-xs text-gray-500">{c.note}</div>
            </div>
            <StackedBar m={c.mix} />
          </div>
        ))}
        <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-gray-400">
          {SEGMENTS.map((s) => (
            <li key={s.key} className="inline-flex items-center gap-1.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-sm ${s.className}`} />
              {s.label}
            </li>
          ))}
        </ul>
      </div>

      <div className="overflow-x-auto border-t border-white/10">
        <table className="w-full text-xs sm:text-sm">
          <thead>
            <tr className="text-left text-gray-400 border-b border-white/10 bg-surface-overlay">
              <th className="py-2.5 pl-3 pr-2 sm:px-4 font-medium">Share of productions</th>
              {columns.map((c) => (
                <th key={c.label} className="py-2.5 px-2 sm:px-4 font-medium text-center">{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {SEGMENTS.map((s) => (
              <tr key={s.key} className="border-b border-white/5">
                <td className="py-2 pl-3 pr-2 sm:px-4 text-gray-300">
                  <span className={`mr-2 inline-block h-2.5 w-2.5 rounded-sm ${s.className}`} aria-hidden="true" />
                  {s.label}
                </td>
                {columns.map((c, i) => (
                  <td key={c.label} className="py-2 px-2 sm:px-4 text-center whitespace-nowrap">
                    <span className={i === 0 ? 'font-semibold text-white' : 'text-gray-300'}>
                      {formatRowValue('pct', share(c.mix[s.key], c.mix.total))}
                    </span>
                    {c.showCounts && <span className="block text-xs text-gray-500">{c.mix[s.key]}</span>}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <GroupRows title="Of all productions" rows={overallRows} columns={columns} />
          <GroupRows title="Within each group" rows={withinRows} columns={columns} />
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-gray-500">
        The average pools the prior seasons&apos; productions (pandemic seasons 2019-20 and 2020-21 left out), so bigger
        seasons count for more. Specials and other shows that are neither musicals nor plays, and any show we have not
        classed as original or revival, fill the rest of each bar. This season&apos;s column includes announced shows.
      </p>
    </div>
  );
}
