/**
 * /biz/biggest-flops (BRO-5865). Aggregates in investment-topics.ts.
 */

import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL, SITE_OG_IMAGE } from '@/lib/seo';
import { getFlopsAndRecoups } from '@/lib/data-topic-pages';
import { formatMillions } from '@/lib/investment-topics';
import TopicPageShell from '@/components/biz/TopicPageShell';

const TITLE = "Broadway's Biggest Flops Since the Reopening";
const DESCRIPTION = "Commercial Broadway shows opened since September 2021 that finished in the red, ranked by the capital they raised.";

export const metadata: Metadata = {
  title: `${TITLE} | Money Scorecard`,
  description: DESCRIPTION,
  alternates: { canonical: `${BASE_URL}/biz/biggest-flops` },
  openGraph: { images: [SITE_OG_IMAGE], title: TITLE, description: DESCRIPTION, url: `${BASE_URL}/biz/biggest-flops` },
};

export default function Page() {
  if (!featureFlags.commercial) notFound();
  const data = getFlopsAndRecoups();

  return (
    <TopicPageShell title={TITLE} subtitle="Shows carrying a loss label (Fizzle, Flop or similar), ranked by capitalization.">
      <ul className="space-y-2" data-testid="flop-list">
        {data.flops.map((r) => (
          <li key={r.slug} className="card rounded-xl px-4 py-3 flex items-center gap-3">
            <span className="w-6 shrink-0 text-center text-sm font-semibold text-gray-500">{r.rank}</span>
            <div className="min-w-0 flex-1">
              <Link href={`/show/${r.slug}`} className="font-semibold text-white hover:text-brand break-words">{r.title}</Link>
              <div className="text-xs text-gray-500">{r.type === 'musical' ? 'Musical' : 'Play'} · opened {r.year} · {r.designation}</div>
            </div>
            <span className="text-lg font-bold text-white whitespace-nowrap">{formatMillions(r.capitalization)}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-gray-500 mt-3">
        Capitalization is the capital raised, reported or estimated by the site. It is the money at stake, not a computed loss: a Fizzle returned some of it.
        {data.flopsWithoutCapitalization > 0 && ` ${data.flopsWithoutCapitalization} more loss-labelled shows have no capitalization on file and are not ranked.`}
      </p>
    </TopicPageShell>
  );
}
