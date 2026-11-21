/**
 * /biz/musicals-since-reopening - every commercial Broadway musical opened since
 * September 2021 and what happened to its investors (BRO-5865). Aggregates in
 * investment-topics.ts; no model figures for musicals (BRO-5849), only the
 * analyst's range on running shows.
 */

import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import ShowLinkListItem from '@/components/biz/ShowLinkListItem';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL } from '@/lib/seo';
import { bizOgImage } from '@/lib/biz-og';
import { getMusicalsSinceReopening } from '@/lib/data-topic-pages';
import { MUSICAL_KIND_LABELS, MUSICAL_KIND_SHORT, type MusicalOutcome } from '@/lib/investment-topics';
import { StatGrid } from '@/components/show-cards';
import TopicPageShell from '@/components/biz/TopicPageShell';
import MoneyGate from '@/components/biz/MoneyGate';

const TITLE = 'Broadway Musicals Since the Reopening';
const DESCRIPTION = 'Every commercial Broadway musical that opened since September 2021: which recouped, which finished in the red, and which are still running.';

export const metadata: Metadata = {
  title: { absolute: `${TITLE} | Profitability Scorecard` },
  description: DESCRIPTION,
  alternates: { canonical: `${BASE_URL}/biz/musicals-since-reopening` },
  openGraph: { images: [bizOgImage('musicals-since-reopening', TITLE)], title: TITLE, description: DESCRIPTION, url: `${BASE_URL}/biz/musicals-since-reopening` },
};

const OUTCOME: Record<MusicalOutcome, { label: string; className: string }> = {
  recouped: { label: 'Recouped', className: 'text-status-open' },
  lost: { label: 'In the red', className: 'text-score-skip' },
  running: { label: 'Still running', className: 'text-gray-300' },
  unknown: { label: 'No verdict', className: 'text-fg-muted' },
};

const month = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

export default function MusicalsSinceReopeningPage() {
  if (!featureFlags.commercial) notFound();
  const data = getMusicalsSinceReopening();
  const revival = data.summaries.find((s) => s.kind === 'revival')!;

  return (
    <TopicPageShell title={TITLE} sharePath="/biz/musicals-since-reopening" subtitle="Commercial musicals opened September 2021 to today, and what happened to the money.">
      <StatGrid
        className="mb-8"
        stats={[
          { label: 'Musicals opened', value: data.total },
          { label: 'Originals recouped', value: `${data.originals.recouped} of ${data.originals.total}`, subValue: 'of those opened, incl. pop-catalog and running shows' },
          { label: 'Revivals recouped', value: `${revival.recouped} of ${revival.total}`, subValue: 'of those opened, incl. running shows' },
          { label: 'Median months to recoup', value: data.medianMonthsToRecoup == null ? '–' : Math.round(data.medianMonthsToRecoup), subValue: `${data.medianSample} recouped shows with a known date` },
        ]}
      />

      <section className="mb-8">
        <h2 className="text-xl font-bold text-white mb-1">By Kind</h2>
        <p className="text-sm text-gray-400 mb-3">Originals, pop-catalog shows (built on an existing pop or rock songbook) and revivals.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4" data-testid="kind-summaries">
          {data.summaries.map((s) => (
            <div key={s.kind} className="card rounded-xl p-4">
              <div className="text-sm text-gray-400">{MUSICAL_KIND_LABELS[s.kind]}</div>
              <div className="text-2xl font-bold text-white">{s.recouped} <span className="text-sm font-normal text-gray-400">of {s.total} opened recouped</span></div>
              <div className="text-xs text-fg-muted mt-1">{s.lost} in the red · {s.running} still running · {s.unknown} closed with no verdict</div>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h2 className="text-xl font-bold text-white mb-3">Every Musical</h2>
        <MoneyGate page="biz-musicals-since-reopening">
        <ul className="space-y-2" data-testid="musical-list">
          {data.rows.map((r) => (
            <ShowLinkListItem key={r.slug} href={`/show/${r.slug}`} className="card rounded-xl px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <Link href={`/show/${r.slug}`} className="font-semibold text-white hover:text-brand"><RowLinkArrow label={r.title} /></Link>
                <span className={`text-sm font-semibold ${OUTCOME[r.outcome].className}`}>{OUTCOME[r.outcome].label}</span>
              </div>
              <div className="text-xs text-fg-muted mt-1">
                {MUSICAL_KIND_SHORT[r.kind]} · opened {month(r.openingDate)}
                {r.monthsToRecoup != null && ` · recouped in about ${r.monthsToRecoup} months`}
                {r.analystRange && ` · ${r.rangeIsOurs ? 'our' : 'analyst'} estimate: ${r.analystRange[0]}% to ${r.analystRange[1]}% of capital returned`}
              </div>
            </ShowLinkListItem>
          ))}
        </ul>
        </MoneyGate>
        <p className="text-xs text-fg-muted mt-3">
          In the red means a loss label (Fizzle, Flop or similar). Closed with no verdict covers shows still labelled TBD and nonprofit enhancement deals. Counts of shows recouped are out of every show opened, running shows included.
        </p>
      </section>
    </TopicPageShell>
  );
}
