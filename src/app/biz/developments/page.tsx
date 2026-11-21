/**
 * /biz/developments - every recoupment and closing of the last two years,
 * announced closings and shows at risk now (owner, 2026-10-26: the short list
 * on /biz needed a page of its own). Built by biz-developments.ts, the same
 * builder as the /biz list.
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL } from '@/lib/seo';
import { bizOgImage } from '@/lib/biz-og';
import { buildDevelopments } from '@/lib/biz-developments';
import TopicPageShell from '@/components/biz/TopicPageShell';
import MoneyGate from '@/components/biz/MoneyGate';
import RecentDevelopmentsList from '@/components/biz/RecentDevelopmentsList';

const TITLE = 'Broadway Recoupments and Closings';
const DESCRIPTION = 'Every Broadway recoupment and closing of the last two years, plus announced closings and shows grossing below break-even now.';

export const metadata: Metadata = {
  title: { absolute: `${TITLE} | Profitability Scorecard` },
  description: DESCRIPTION,
  alternates: { canonical: `${BASE_URL}/biz/developments` },
  openGraph: { images: [bizOgImage('home', TITLE)], title: TITLE, description: DESCRIPTION, url: `${BASE_URL}/biz/developments` },
};

export default function DevelopmentsPage() {
  if (!featureFlags.commercial) notFound();
  const items = buildDevelopments('full');

  return (
    <TopicPageShell title={TITLE} sharePath="/biz/developments" subtitle="Shows at risk now, announced closings, then every recoupment and closing of the last two years, newest first.">
      <MoneyGate page="biz-developments">
        <RecentDevelopmentsList items={items} maxItems={items.length} />
      </MoneyGate>
    </TopicPageShell>
  );
}
