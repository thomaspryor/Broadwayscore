/**
 * /biz/fastest-recoups (BRO-5865). Aggregates in investment-topics.ts.
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

const TITLE = "Broadway's Fastest Recoupments";
const DESCRIPTION = "Commercial Broadway shows opened since September 2021 that paid back their investors fastest, ranked by weeks from opening to recoupment.";

export const metadata: Metadata = {
  title: { absolute: `${TITLE} | Profitability Scorecard` },
  description: DESCRIPTION,
  alternates: { canonical: `${BASE_URL}/biz/fastest-recoups` },
  openGraph: { images: [bizOgImage('fastest-recoups', TITLE)], title: TITLE, description: DESCRIPTION, url: `${BASE_URL}/biz/fastest-recoups` },
};

export default function Page() {
  if (!featureFlags.commercial) notFound();
  const data = getFlopsAndRecoups();

  return (
    <TopicPageShell title={TITLE} sharePath="/biz/fastest-recoups" subtitle="Weeks from opening to recoupment, fastest first.">
      <MoneyGate page="biz-fastest-recoups">
      <ul className="space-y-2" data-testid="recoup-list">
        {data.recoups.map((r) => (
          <ShowLinkListItem key={r.slug} href={`/show/${r.slug}`} className="card rounded-xl px-4 py-3 flex items-center gap-3">
            <span className="w-6 shrink-0 text-center text-sm font-semibold text-fg-muted">{r.rank}</span>
            <div className="min-w-0 flex-1">
              <Link href={`/show/${r.slug}`} className="font-semibold text-white hover:text-brand break-words"><RowLinkArrow label={r.title} /></Link>
              <div className="text-xs text-fg-muted">
                {r.type === 'musical' ? 'Musical' : 'Play'} · opened {r.year}{r.capitalization != null && ` · ${formatMillions(r.capitalization)} capitalization`}
              </div>
            </div>
            <span className="text-lg font-bold text-status-open whitespace-nowrap">{r.weeksToRecoup} wks</span>
          </ShowLinkListItem>
        ))}
      </ul>
      </MoneyGate>
      <p className="text-xs text-fg-muted mt-3">
        Weeks run from opening night to the month the recoupment was reported, so they are approximate.
        {data.recoupsWithoutDate > 0 && ` ${data.recoupsWithoutDate} recouped shows without a usable recoup date (none reported, or reported after closing) are not ranked.`}
      </p>
    </TopicPageShell>
  );
}
