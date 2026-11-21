/**
 * WhoRecoupsCard - recoupment rate by show type, and how critic scores line
 * up with recouping (buildRecoupFindings in season-profile.ts). Public Season
 * Report (BRO-5777): no money figures, and only shows that recouped are named.
 */

import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import ShowLinkListItem from '@/components/biz/ShowLinkListItem';
import { HIGH_SCORE, LOW_SCORE, MIN_AVERAGE_SAMPLE, type RecoupFindings } from '@/lib/season-profile';

function shortSeason(season: string): string {
  return `${season.slice(0, 4)}-${season.slice(7)}`;
}

function rate(n: number, d: number): number | null {
  return d >= MIN_AVERAGE_SAMPLE ? n / d : null;
}

export default function WhoRecoupsCard({ findings }: { findings: RecoupFindings }) {
  const { range, buckets, under60, atLeast80 } = findings;
  if (!range) return null;
  const maxRate = Math.max(...buckets.map((b) => rate(b.recouped, b.total) ?? 0), 0.01);
  const lowRate = rate(under60.recouped, under60.total);
  const highRate = rate(atLeast80.recouped, atLeast80.total);

  return (
    <div className="card rounded-xl overflow-hidden" data-testid="who-recoups">
      <div className="px-4 pt-4 text-sm text-gray-400">
        Commercial productions that opened from {shortSeason(range[0])} to {shortSeason(range[1])}
      </div>
      <table className="w-full text-sm mt-2">
        <thead>
          <tr className="text-left text-gray-400 border-b border-white/10">
            <th className="py-2 px-4 font-medium">Show type</th>
            <th className="py-2 px-4 font-medium text-center whitespace-nowrap">Recouped</th>
            <th className="py-2 px-4 font-medium w-2/5"><span className="sr-only">Rate</span></th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => {
            const r = rate(b.recouped, b.total);
            return (
              <tr key={b.label} className="border-b border-white/5">
                <td className="py-2.5 px-4 text-gray-300">{b.label}</td>
                <td className="py-2.5 px-4 text-center whitespace-nowrap">
                  <span className="font-semibold text-white">{r == null ? '—' : `${Math.round(r * 100)}%`}</span>
                  <span className="block text-xs text-fg-muted">{b.recouped} of {b.total}</span>
                </td>
                <td className="py-2.5 px-4">
                  <div className="h-2 rounded-full bg-white/5">
                    <div className="h-2 rounded-full bg-brand" style={{ width: `${((r ?? 0) / maxRate) * 100}%` }} />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="px-4 py-4 space-y-2 text-sm text-gray-300">
        {lowRate != null && highRate != null && (
          <div>
            <p className="text-white font-semibold mb-2">Critic scores and recoupment</p>
            <div className="space-y-2" data-testid="critic-bands">
              {[
                { label: `Critic score ${HIGH_SCORE}+`, r: highRate, band: atLeast80 },
                { label: `Critic score under ${LOW_SCORE}`, r: lowRate, band: under60 },
              ].map((row) => (
                <div key={row.label} className="grid grid-cols-[8.5rem_1fr_auto] sm:grid-cols-[11rem_1fr_auto] items-center gap-3">
                  <span className="text-gray-300">{row.label}</span>
                  <div className="h-2 rounded-full bg-white/5">
                    <div className="h-2 rounded-full bg-brand" style={{ width: `${row.r * 100}%` }} />
                  </div>
                  <span className="text-right whitespace-nowrap">
                    <span className="font-semibold text-white">{Math.round(row.r * 100)}%</span>{' '}
                    <span className="text-xs text-fg-muted">{row.band.recouped} of {row.band.total}</span>
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-fg-muted">Share that recouped, counting shows that have closed or recouped.</p>
          </div>
        )}
        {findings.recoupedAvgScore != null && findings.closedUnrecoupedAvgScore != null && (
          <p>
            Shows that recouped averaged a critic score of {Math.round(findings.recoupedAvgScore)}. Shows that closed
            with no recoupment announced averaged {Math.round(findings.closedUnrecoupedAvgScore)}.
          </p>
        )}
      </div>
      {buckets.some((b) => b.recoupedShows.length > 0) && (
        <div className="px-4 pb-4 space-y-1 text-sm" data-testid="recouped-shows">
          {buckets.filter((b) => b.recoupedShows.length > 0).map((b) => (
            <details key={b.label}>
              <summary className="cursor-pointer text-brand hover:text-brand-hover">
                {b.label} that recouped ({b.recoupedShows.length})
              </summary>
              <ul className="mt-1 mb-2 ml-4 flex flex-wrap gap-x-4 gap-y-1">
                {b.recoupedShows.map((s) => (
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
      <p className="px-4 pb-4 text-xs text-fg-muted">
        Leaves out nonprofit-only runs and tour stops, which have no investors to repay. Shows still running count as
        not recouped yet, so the rates by show type can only go up. The critic rows count shows with a critic score
        that have recouped or closed, and show a correlation only. Recoupment comes from producer announcements and
        trade press. Critic scores are Broadway Scorecard&apos;s.
      </p>
    </div>
  );
}
