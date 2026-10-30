import Link from 'next/link';
import type { HealthTier, WeeklyShow } from '../../scripts/lib/commercial-weekly';
import type { getCommercialWeeklySnapshot } from '@/lib/data-commercial';
import { formatCurrency, formatDataDate } from '@/lib/biz-format';
import { DataStalenessBanner } from '@/components/show-cards';
import ShowLinkListItem from '@/components/biz/ShowLinkListItem';

const HEALTH_COLOR: Record<HealthTier, string> = {
  Blockbuster: 'text-status-open',
  Healthy: 'text-status-open',
  Holding: 'text-score-tepid',
  Struggling: 'text-score-skip',
  Critical: 'text-score-skip',
};

function MoversList({ title, shows }: { title: 'Movers' | 'Fallers'; shows: WeeklyShow[] }) {
  const rising = title === 'Movers';
  return (
    <div className="min-w-0">
      <h3 className="text-base font-semibold text-white mb-3">{title}</h3>
      {shows.length ? (
        <ol className="space-y-3">
          {shows.map((show) => (
            <ShowLinkListItem key={show.slug} href={`/show/${show.slug}`} className="card p-4">
              <Link href={`/show/${show.slug}`} className="font-semibold text-white group-hover:text-brand focus-visible:underline">
                {show.title}
              </Link>
              <p className={`mt-2 text-lg font-bold tabular-nums ${rising ? 'text-status-open' : 'text-score-skip'}`}>
                {rising ? '+' : '−'}{formatCurrency(Math.abs(show.change!))}
                <span className="ml-2 text-sm font-normal">({show.changePct! > 0 ? '+' : ''}{show.changePct!.toFixed(1)}%)</span>
              </p>
              <p className="text-xs text-fg-muted mt-1">Weekly gross {formatCurrency(show.gross)}</p>
              <dl className="mt-3 space-y-1 text-sm">
                <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                  <dt className="text-fg-muted">Current health</dt>
                  <dd className={show.health ? HEALTH_COLOR[show.health] : 'text-fg-muted'}>{show.health ?? show.healthReason}</dd>
                </div>
                <div className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                  <dt className="text-fg-muted">Run outcome</dt>
                  <dd className={show.outcome.textClass} title={show.outcome.description}>
                    {show.outcome.label === 'TBD' ? 'Still running' : show.outcome.label}
                  </dd>
                </div>
              </dl>
            </ShowLinkListItem>
          ))}
        </ol>
      ) : <p className="text-sm text-fg-muted">No {rising ? 'increases' : 'decreases'} among shows with comparable weeks.</p>}
    </div>
  );
}

export default function CommercialScorecard({ snapshot }: { snapshot: ReturnType<typeof getCommercialWeeklySnapshot> }) {
  return (
    <section className="mb-8" aria-labelledby="weekly-commercial-heading" data-testid="commercial-scorecard">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 mb-3">
        <h2 id="weekly-commercial-heading" className="text-xl font-bold text-white">This Week on Broadway</h2>
        {snapshot.weekEnding && <p className="text-sm text-fg-muted">Week ending {formatDataDate(snapshot.weekEnding)}</p>}
      </div>
      <DataStalenessBanner kind="grosses" lastUpdated={snapshot.weekEnding} />
      {snapshot.unavailableReason ? (
        <p className="card p-5 text-sm text-fg-muted">{snapshot.unavailableReason}</p>
      ) : (
        <>
          <div className="card p-5 sm:p-6 mb-5" data-testid="market-health">
            <h3 className="text-base font-semibold text-white">Broadway Market Health Index</h3>
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 my-3">
              <p className="text-5xl font-bold text-white tabular-nums">{snapshot.index ?? 'N/A'}</p>
              {snapshot.index !== null && <span className="text-sm text-fg-muted">/ 100</span>}
            </div>
            <p className="text-sm text-gray-300">
              {snapshot.ratedCount ? `${snapshot.healthyCount} of ${snapshot.ratedCount} rated shows are Healthy or Blockbuster.` : 'Not enough data to rate market health yet.'}
            </p>
            <p className="text-xs text-fg-muted mt-2">Coverage: {snapshot.ratedCount} rated of {snapshot.reportingCount} reporting Broadway shows. Each rated show counts equally.</p>
          </div>
          <h3 className="text-lg font-semibold text-white mb-1">Weekly Movers &amp; Fallers</h3>
          <p className="text-sm text-fg-muted mb-4">
            Largest dollar changes in gross{snapshot.previousWeekEnding ? ` since the week ending ${formatDataDate(snapshot.previousWeekEnding)}` : ''}.
            {' '}Actual weekly totals; changes in the number of performances can affect the ranking.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <MoversList title="Movers" shows={snapshot.movers} />
            <MoversList title="Fallers" shows={snapshot.fallers} />
          </div>
          <details className="mt-4 text-sm text-fg-muted">
            <summary className="cursor-pointer text-brand hover:text-brand-hover">How current health is measured</summary>
            <p className="mt-2">Current health compares the average gross over four consecutive weeks with estimated weekly break-even: Blockbuster at 150% or more, Healthy at 110% to under 150%, Holding at 90% to under 110%, Struggling at 70% to under 90%, and Critical below 70%.</p>
            <p className="mt-2">A rating needs a cost estimate and at least seven performances in each of those weeks. The index is the percentage of rated shows in the top two tiers, rounded to a whole number. Unrated shows are excluded. Run outcome describes the production&apos;s overall financial result and is separate from current health.</p>
          </details>
        </>
      )}
    </section>
  );
}
