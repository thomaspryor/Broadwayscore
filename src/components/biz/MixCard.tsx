/**
 * MixCard - a season's production mix as the 2x2 of musicals/plays by
 * original/revival (owner, 2026-10-20), set beside last season and the
 * prior-seasons average: a 100% stacked bar per column, the 2x2 counts, and
 * the within-group shares (compareSeason rows). Server-rendered, CSS only.
 */

import { formatRowValue, type ComparisonRow, type MixBreakdown } from '@/lib/season-profile';

const SEGMENTS = [
  { key: 'originalMusicals', id: 'original-musicals', label: 'Original musicals', short: 'OM', className: 'bg-brand', textClassName: 'text-surface' },
  { key: 'musicalRevivals', id: 'musical-revivals', label: 'Musical revivals', short: 'MR', className: 'bg-brand/55', textClassName: 'text-white' },
  { key: 'originalPlays', id: 'original-plays', label: 'Original plays', short: 'OP', className: 'bg-accent-purple', textClassName: 'text-surface' },
  { key: 'playRevivals', id: 'play-revivals', label: 'Play revivals', short: 'PR', className: 'bg-accent-purple/55', textClassName: 'text-white' },
] as const;

export interface MixColumn {
  /** Column heading, e.g. "2026-27 so far". */
  label: string;
  /** Under the heading, e.g. "28 productions" or "10 seasons pooled". */
  note: string;
  mix: MixBreakdown;
  /** Seasons pooled in `mix`; counts are shown per season (1 for a single season). */
  seasons: number;
  /** Which compareSeason value fills this column in the within-group rows. */
  value: 'current' | 'last' | 'avg';
}

function share(n: number, total: number): number | null {
  return total > 0 ? n / total : null;
}

const DETAIL = { current: 'currentDetail', last: 'lastDetail', avg: 'avgDetail' } as const;

function perSeason(n: number, seasons: number): string {
  const v = n / seasons;
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}

/** Segment shares (% of the bar) below which the label drops to the acronym, and below which it is left off. */
const FULL_LABEL_MIN_PCT = 13;
const SHORT_LABEL_MIN_PCT = 11;

function StackedBar({ m }: { m: MixBreakdown }) {
  return (
    <div className="flex h-8 w-full overflow-hidden rounded-full bg-white/5" aria-hidden="true">
      {SEGMENTS.map((s) => {
        const pct = (share(m[s.key], m.total) ?? 0) * 100;
        if (pct <= 0) return null;
        // Wide segments carry the full name from xl up; narrower ones (and phones) the acronym; slivers nothing.
        // A divider between segments keeps the lighter revival shades distinct from their solid neighbours.
        return (
          <div
            key={s.key}
            title={s.label}
            className={`${s.className} ${s.textClassName} flex items-center justify-center overflow-hidden whitespace-nowrap text-[10px] tracking-tight sm:tracking-normal sm:text-xs font-semibold border-r-2 border-surface-raised last:border-r-0 px-0 sm:px-1 first:pl-1.5 sm:first:pl-3 last:pr-1.5 sm:last:pr-3`}
            style={{ width: `${pct}%` }}
          >
            {pct >= SHORT_LABEL_MIN_PCT && (
              <>
                <span className={pct >= FULL_LABEL_MIN_PCT ? 'xl:hidden' : ''}>{s.short}</span>
                {pct >= FULL_LABEL_MIN_PCT && <span className="hidden xl:inline">{s.label}</span>}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** True when some bar shows an acronym on desktop (a segment between the two cutoffs), so the key must stay visible there. */
function needsDesktopKey(columns: MixColumn[]): boolean {
  return columns.some((c) =>
    SEGMENTS.some((s) => {
      const pct = (share(c.mix[s.key], c.mix.total) ?? 0) * 100;
      return pct >= SHORT_LABEL_MIN_PCT && pct < FULL_LABEL_MIN_PCT;
    }),
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
              {r[DETAIL[c.value]] && <span className="block text-xs text-fg-muted">{r[DETAIL[c.value]]}</span>}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  );
}

/** `linkGroups`: groups whose names link to the page's show list (#original-musicals...); only groups that have one. */
export default function MixCard({ columns, overallRows, withinRows, linkGroups }: { columns: MixColumn[]; overallRows: ComparisonRow[]; withinRows: ComparisonRow[]; linkGroups?: ReadonlySet<string> }) {
  return (
    <div className="card rounded-xl overflow-hidden" data-testid="mix-card">
      <div className="p-4 space-y-3">
        {columns.map((c) => (
          <div key={c.label} className="grid grid-cols-[7.5rem_1fr] sm:grid-cols-[11rem_1fr] items-center gap-3">
            <div className="text-sm">
              <div className="text-white font-medium">{c.label}</div>
              <div className="text-xs text-fg-muted">{c.note}</div>
            </div>
            <StackedBar m={c.mix} />
          </div>
        ))}
        {/* Wide segments name themselves from xl up; elsewhere bars show acronyms, so spell them out here. */}
        <ul className={`${needsDesktopKey(columns) ? '' : 'xl:hidden'} flex flex-wrap gap-x-3 gap-y-1 pt-1 text-xs text-gray-400`}>
          {SEGMENTS.map((s) => (
            <li key={s.key}>
              <strong className="font-semibold text-gray-300">{s.short}</strong> {s.label}
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
                  {linkGroups?.has(s.id) ? <a href={`#${s.id}`} className="text-brand hover:text-brand-hover">{s.label}</a> : s.label}
                </td>
                {columns.map((c, i) => (
                  <td key={c.label} className="py-2 px-2 sm:px-4 text-center whitespace-nowrap">
                    <span className={i === 0 ? 'font-semibold text-white' : 'text-gray-300'}>
                      {formatRowValue('pct', share(c.mix[s.key], c.mix.total))}
                    </span>
                    <span className="block text-xs text-fg-muted">{perSeason(c.mix[s.key], c.seasons)} of {perSeason(c.mix.total, c.seasons)}</span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          <GroupRows title="Of all productions" rows={overallRows} columns={columns} />
          <GroupRows title="Within each group" rows={withinRows} columns={columns} />
        </table>
      </div>
      <p className="px-4 py-3 text-xs text-fg-muted">
        The average pools every production from the prior seasons (skipping 2019-20 and 2020-21), and its counts are
        per season. Specials (magic and holiday shows, for example) and any show we haven&apos;t classed as original or
        revival fill the rest of each bar. This season includes shows announced but not yet open.
      </p>
    </div>
  );
}
