/**
 * /biz/reviews-and-money - critic, audience and Tony results against recoupment,
 * one panel per bucket (new musicals, musical revivals, new plays, play revivals) (BRO-5865). Aggregates in
 * investment-topics.ts.
 */

import Link from 'next/link';
import RowLinkArrow from '@/components/biz/RowLinkArrow';
import ShowLinkListItem from '@/components/biz/ShowLinkListItem';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { featureFlags } from '@/config/feature-flags';
import { BASE_URL } from '@/lib/seo';
import { bizOgImage } from '@/lib/biz-og';
import { getWhatPredictsTheMoney } from '@/lib/data-topic-pages';
import { SCORE_BAND_LABELS, BAND_LOW, TONY_NOMS_HIGH, MIN_RATE_SAMPLE, type BandCount, type MoneyCallout } from '@/lib/investment-topics';
import { ScoreBadge } from '@/components/show-cards';
import TopicPageShell from '@/components/biz/TopicPageShell';
import MoneyGate from '@/components/biz/MoneyGate';

const TITLE = 'What Predicts the Money?';
const DESCRIPTION = 'Critic scores, audience scores and Tony results against recoupment for Broadway shows since the reopening, with new musicals, musical revivals, new plays and play revivals counted separately.';

export const metadata: Metadata = {
  title: { absolute: `${TITLE} | Profitability Scorecard` },
  description: DESCRIPTION,
  alternates: { canonical: `${BASE_URL}/biz/reviews-and-money` },
  openGraph: { images: [bizOgImage('reviews-and-money', TITLE)], title: TITLE, description: DESCRIPTION, url: `${BASE_URL}/biz/reviews-and-money` },
};

function RateRow({ label, count }: { label: string; count: BandCount }) {
  const r = count.total > 0 ? count.recouped / count.total : null;
  return (
    <div className="grid grid-cols-[8.5rem_1fr_auto] sm:grid-cols-[11rem_1fr_auto] items-center gap-3 text-sm">
      <span className="text-gray-300">{label}</span>
      <div className="h-2 rounded-full bg-white/5">
        <div className="h-2 rounded-full bg-brand" style={{ width: `${count.total < MIN_RATE_SAMPLE ? 0 : (r ?? 0) * 100}%` }} />
      </div>
      <span className="text-right whitespace-nowrap">
        <span className="font-semibold text-white">{r == null || count.total < MIN_RATE_SAMPLE ? '–' : `${Math.round(r * 100)}%`}</span>{' '}
        <span className="text-xs text-fg-muted">{count.recouped} of {count.total}</span>
      </span>
    </div>
  );
}

function Callouts({ items, testId }: { items: MoneyCallout[]; testId: string }) {
  return (
    <ul className="space-y-2" data-testid={testId}>
      {items.map((c) => (
        <ShowLinkListItem key={c.slug} href={`/show/${c.slug}`} className="card rounded-xl px-4 py-3 flex items-center gap-3">
          <div className="shrink-0"><ScoreBadge score={c.score} size="sm" /></div>
          <div className="min-w-0">
            <Link href={`/show/${c.slug}`} className="font-semibold text-white hover:text-brand break-words"><RowLinkArrow label={c.title} /></Link>
            <div className="text-xs text-fg-muted">
              {c.year}{c.weeksToRecoup != null && ` · recouped in about ${c.weeksToRecoup} weeks`}
            </div>
          </div>
        </ShowLinkListItem>
      ))}
    </ul>
  );
}

export default function ReviewsAndMoneyPage() {
  if (!featureFlags.commercial) notFound();
  const data = getWhatPredictsTheMoney();
  const bandIds = ['high', 'mid', 'low'] as const;

  return (
    <TopicPageShell title={TITLE} sharePath="/biz/reviews-and-money" subtitle="Share of Broadway shows that recouped, by critic score, audience score and Tony results, for shows opened since September 2021. Only shows with a final verdict (recouped or lost) are counted, so these totals are smaller than the show counts on the other pages. Each kind of show is counted on its own.">
      <section className="mb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4" data-testid="bucket-panels">
          {data.buckets.map((b) => (
            <div key={b.id} className="card rounded-xl p-4 space-y-3" data-testid={`bucket-${b.id}`}>
              <div className="text-white font-semibold">
                {b.label} <span className="text-xs font-normal text-fg-muted">{b.recouped} of {b.decided} recouped</span>
              </div>
              <div className="text-xs uppercase tracking-wide text-fg-muted">Critic score</div>
              {bandIds.map((id) => <RateRow key={id} label={SCORE_BAND_LABELS[id]} count={b.critic[id]} />)}
              <div className="text-xs uppercase tracking-wide text-fg-muted pt-1">Audience score</div>
              <RateRow label={`Audience under ${BAND_LOW}`} count={b.audienceUnder70} />
              <RateRow label={`Audience ${BAND_LOW}+`} count={b.audienceAtLeast70} />
              <div className="text-xs uppercase tracking-wide text-fg-muted pt-1">Tony Awards</div>
              <RateRow label={`${TONY_NOMS_HIGH}+ nominations`} count={b.tonyNoms.high} />
              <RateRow label={`Under ${TONY_NOMS_HIGH} nominations`} count={b.tonyNoms.low} />
              <RateRow label="Won a Tony" count={b.tonyWin.won} />
              <RateRow label="No Tony win" count={b.tonyWin.none} />
              <RateRow label="Won top category" count={b.tonyTop.won} />
              <RateRow label="Top category nominee" count={b.tonyTop.nominatedOnly} />
              <RateRow label="No top category nod" count={b.tonyTop.none} />
            </div>
          ))}
        </div>
        <p className="text-xs text-fg-muted mt-2">
          Counts shows that recouped or closed with a loss label (Fizzle, Flop or similar). Running shows, and closed shows with no verdict, are left out.
          Shows without a score, with too few audience reviews, or without a Tony record drop out of that row. A dash instead of a percentage means fewer than {MIN_RATE_SAMPLE} shows, too few to give a rate. Small groups swing a lot, so read the counts beside each percentage.
          Top category means Best Musical, Best Play or Best Revival.
        </p>
      </section>

      <MoneyGate page="biz-reviews-and-money">
      <section className="mb-8 grid grid-cols-1 md:grid-cols-2 gap-6">
        <div>
          <h2 className="text-xl font-bold text-white mb-1">Low Scores, Still Recouped</h2>
          <p className="text-sm text-gray-400 mb-3">Lowest critic scores among shows that recouped.</p>
          <Callouts items={data.lowScoreRecouped} testId="low-score-recouped" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-white mb-1">Acclaimed, Still in the Red</h2>
          <p className="text-sm text-gray-400 mb-3">Highest critic scores among shows carrying a loss label.</p>
          <Callouts items={data.acclaimedLosers} testId="acclaimed-losers" />
        </div>
      </section>
      </MoneyGate>
    </TopicPageShell>
  );
}
