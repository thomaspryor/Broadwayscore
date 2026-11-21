/**
 * /biz/biggest-flops (BRO-5865). Aggregates in investment-topics.ts.
 */

import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import ShowLinkListItem from '@/components/biz/ShowLinkListItem';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL } from '@/lib/seo';
import { bizOgImage } from '@/lib/biz-og';
import { getFlopsAndRecoups } from '@/lib/data-topic-pages';
import { formatMillions } from '@/lib/investment-topics';
import TopicPageShell from '@/components/biz/TopicPageShell';
import MoneyGate from '@/components/biz/MoneyGate';

const TITLE = "Broadway's Biggest Flops Since the Reopening";
const DESCRIPTION = "Commercial Broadway shows opened since September 2021 that finished in the red, ranked by the capital they raised.";

export const metadata: Metadata = {
  title: { absolute: `${TITLE} | Profitability Scorecard` },
  description: DESCRIPTION,
  alternates: { canonical: `${BASE_URL}/biz/biggest-flops` },
  openGraph: { images: [bizOgImage('biggest-flops', TITLE)], title: TITLE, description: DESCRIPTION, url: `${BASE_URL}/biz/biggest-flops` },
};

export default function Page() {
  if (!featureFlags.commercial) notFound();
  const data = getFlopsAndRecoups();

  return (
    <TopicPageShell title={TITLE} sharePath="/biz/biggest-flops" subtitle="Shows carrying a loss label (Fizzle, Flop or similar), ranked by capitalization.">
      <MoneyGate page="biz-biggest-flops">
      <ul className="space-y-2" data-testid="flop-list">
        {data.flops.map((r) => (
          <ShowLinkListItem key={r.slug} href={`/show/${r.slug}`} className="card rounded-xl px-4 py-3 flex items-center gap-3">
            <span className="w-6 shrink-0 text-center text-sm font-semibold text-fg-muted">{r.rank}</span>
            <div className="min-w-0 flex-1">
              <Link href={`/show/${r.slug}`} className="font-semibold text-white hover:text-brand break-words"><RowLinkArrow label={r.title} /></Link>
              <div className="text-xs text-fg-muted">{r.type === 'musical' ? 'Musical' : 'Play'} · opened {r.year} · {r.designation}</div>
            </div>
            <span className="text-lg font-bold text-white whitespace-nowrap">{formatMillions(r.capitalization)}</span>
          </ShowLinkListItem>
        ))}
      </ul>
      </MoneyGate>
      <p className="text-xs text-fg-muted mt-3">
        Capitalization is the capital raised, reported or estimated by the site. It is the money at stake, not a computed loss: a Fizzle returned some of it.
        {data.flopsWithoutCapitalization > 0 && ` ${data.flopsWithoutCapitalization} more loss-labelled shows have no capitalization on file and are not ranked.`}
      </p>
    </TopicPageShell>
  );
}
