/**
 * SeasonPaybackCard - about how much of a season's invested capital has come
 * back so far, with a low-high range and how it has moved (returnedCapital in
 * season-profile.ts; history from record-season-payback.ts). An estimate from
 * our model and the figures on each show's page, labeled as one (BRO-6335).
 */

import { formatRowValue, type SeasonProfile } from '@/lib/season-profile';

interface Props {
  profile: SeasonProfile;
  trend: { fromDate: string; change: number } | null;
}

function shortDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

export default function SeasonPaybackCard({ profile, trend }: Props) {
  const r = profile.returnedCapital;
  const backShare = r.capital > 0 ? Math.min(1, r.mid / r.capital) : 0;
  const money = (n: number) => formatRowValue('money', n);
  return (
    <section className="card rounded-xl p-4 sm:p-5 mb-8" data-testid="season-payback">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-2xl sm:text-3xl font-bold text-emerald-400">About {money(r.mid)} back</span>
        <span className="text-gray-300">of {money(r.capital)} invested</span>
      </div>
      <div
        className="mt-3 h-2 rounded-full bg-surface-overlay overflow-hidden"
        role="img"
        aria-label={`About ${Math.round(backShare * 100)} percent of the money invested has come back`}
      >
        <div className="h-full bg-emerald-500" style={{ width: `${Math.round(backShare * 100)}%` }} />
      </div>
      <p className="text-sm text-gray-400 mt-3">
        Estimated range {money(r.low)} to {money(r.high)}.
        {r.missing > 0 && ` Leaves out ${r.missing} show${r.missing === 1 ? '' : 's'} we have no reading for.`}
      </p>
      {trend && trend.change !== 0 && (
        <p className="text-sm text-gray-400 mt-1" data-testid="season-payback-trend">
          {trend.change > 0 ? 'Up' : 'Down'} about {money(Math.abs(trend.change))} since {shortDate(trend.fromDate)}.
        </p>
      )}
      <p className="text-xs text-gray-500 mt-2">
        Our estimate, not a reported result. Counts money returned to investors in shows that recouped, and our estimate of what has come back from the rest. It changes as running shows pay back more.
      </p>
    </section>
  );
}
