/**
 * WhoRecoupsCard - recoupment rate by show type, and how critic scores line
 * up with recouping (buildRecoupFindings in season-profile.ts). Public Season
 * Report (BRO-5777): aggregates only, no show names or money figures.
 */

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
        Commercial productions that opened {shortSeason(range[0])} to {shortSeason(range[1])}
      </div>
      <table className="w-full text-sm mt-2">
        <thead>
          <tr className="text-left text-gray-400 border-b border-white/10">
            <th className="py-2 px-4 font-medium">Show type</th>
            <th className="py-2 px-4 font-medium text-right whitespace-nowrap">Recouped</th>
            <th className="py-2 px-4 font-medium w-2/5"><span className="sr-only">Rate</span></th>
          </tr>
        </thead>
        <tbody>
          {buckets.map((b) => {
            const r = rate(b.recouped, b.total);
            return (
              <tr key={b.label} className="border-b border-white/5">
                <td className="py-2.5 px-4 text-gray-300">{b.label}</td>
                <td className="py-2.5 px-4 text-right whitespace-nowrap">
                  <span className="font-semibold text-white">{r == null ? '—' : `${Math.round(r * 100)}%`}</span>
                  <span className="block text-xs text-gray-500">{b.recouped} of {b.total}</span>
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
            <p className="text-white font-semibold mb-2">Reviews and recoupment line up</p>
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
                    <span className="text-xs text-gray-500">{row.band.recouped} of {row.band.total}</span>
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs text-gray-500">Share that recouped, among shows that have closed or recouped.</p>
          </div>
        )}
        {findings.recoupedAvgScore != null && findings.closedUnrecoupedAvgScore != null && (
          <p>
            Shows that recouped averaged a critic score of {Math.round(findings.recoupedAvgScore)}; shows that closed
            with no recoupment announced averaged {Math.round(findings.closedUnrecoupedAvgScore)}.
          </p>
        )}
      </div>
      <p className="px-4 pb-4 text-xs text-gray-500">
        Nonprofit-only runs and tour stops are left out (no investors to repay). Shows still running count as not yet
        recouped, so rates are floors. Critic figures count only shows with a critic score that have recouped or closed;
        they show a pattern, not that reviews caused the outcome. Recoupment from
        producer announcements and trade press; critic scores are Broadway Scorecard&apos;s.
      </p>
    </div>
  );
}
