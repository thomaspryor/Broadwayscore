/**
 * /biz/tony-winners (BRO-5865). Aggregates in investment-topics.ts.
 */

import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import ShowLinkListItem from '@/components/biz/ShowLinkListItem';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL } from '@/lib/seo';
import { bizOgImage } from '@/lib/biz-og';
import { getTonyWinners } from '@/lib/data-topic-pages';
import { formatMillions, type MusicalOutcome } from '@/lib/investment-topics';
import { StatGrid } from '@/components/show-cards';

const OUTCOME: Record<MusicalOutcome, { label: string; className: string }> = {
  recouped: { label: 'Recouped', className: 'text-status-open' },
  lost: { label: 'In the red', className: 'text-score-skip' },
  running: { label: 'Still running', className: 'text-gray-300' },
  unknown: { label: 'Closed with no verdict', className: 'text-fg-muted' },
};
import TopicPageShell from '@/components/biz/TopicPageShell';
import MoneyGate from '@/components/biz/MoneyGate';

const TITLE = "What Happened to the Tony Winners' Investors";
const DESCRIPTION = "Best Musical and Best Play winners since the 2021-22 season, and whether each recouped.";

export const metadata: Metadata = {
  title: { absolute: `${TITLE} | Profitability Scorecard` },
  description: DESCRIPTION,
  alternates: { canonical: `${BASE_URL}/biz/tony-winners` },
  openGraph: { images: [bizOgImage('tony-winners', TITLE)], title: TITLE, description: DESCRIPTION, url: `${BASE_URL}/biz/tony-winners` },
};

export default function Page() {
  if (!featureFlags.commercial) notFound();
  const data = getTonyWinners();

  return (
    <TopicPageShell title={TITLE} sharePath="/biz/tony-winners" subtitle="Best Musical and Best Play winners since 2021-22 (commercial productions), and how the money turned out.">
      <StatGrid
        className="mb-6"
        stats={[
          { label: 'Winners recouped', value: `${data.recouped} of ${data.decided}`, subValue: 'with a verdict so far' },
          { label: 'Winners listed', value: data.rows.length },
        ]}
      />
      <MoneyGate page="biz-tony-winners">
      <ul className="space-y-2" data-testid="tony-winner-list">
        {data.rows.map((r) => (
          <ShowLinkListItem key={r.slug} href={`/show/${r.slug}`} className="card rounded-xl px-4 py-3">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <Link href={`/show/${r.slug}`} className="font-semibold text-white hover:text-brand"><RowLinkArrow label={r.title} /></Link>
              <span className={`text-sm font-semibold ${OUTCOME[r.outcome].className}`}>{OUTCOME[r.outcome].label}</span>
            </div>
            <div className="text-xs text-fg-muted mt-1">
              {r.award}, {r.season}
              {r.monthsToRecoup != null && ` · recouped in about ${r.monthsToRecoup} months`}
              {r.capitalization != null && ` · ${formatMillions(r.capitalization)} capitalization`}
            </div>
          </ShowLinkListItem>
        ))}
      </ul>
      </MoneyGate>
      <p className="text-xs text-fg-muted mt-3">
        In the red means a loss label (Fizzle, Flop or similar). Closed with no verdict means the show has no final label yet. Nonprofit productions with no investors are left out.
      </p>
    </TopicPageShell>
  );
}
