import type { Metadata } from 'next';
import { TIER_DESCRIPTIONS, TIER_WEIGHTS, MIN_REVIEWS_FOR_SCORE } from '@/config/scoring';
import { SCORE_TIERS, GOLD_MIN, RECOMMENDED_MIN, WORTH_IT_MIN, MIXED_MIN } from '@/config/score-buckets';
import { OutletTierChip } from '@/components/product-cards';

export const metadata: Metadata = { title: 'How Tech Scorecard scores work' };

const RANGES = [
  ['gold', `${GOLD_MIN}-100`],
  ['recommended', `${RECOMMENDED_MIN}-${GOLD_MIN - 1}`],
  ['worthIt', `${WORTH_IT_MIN}-${RECOMMENDED_MIN - 1}`],
  ['mixed', `${MIXED_MIN}-${WORTH_IT_MIN - 1}`],
  ['miss', `0-${MIXED_MIN - 1}`],
] as const;

export default function MethodologyPage() {
  return (
    <div className="mx-auto max-w-3xl px-4 pt-10 sm:px-6">
      <h1 className="text-3xl font-extrabold sm:text-4xl">How scores work</h1>
      <p className="mt-3 max-w-[65ch] leading-relaxed text-ink-muted">
        Every product gets one critic score from 0 to 100: a weighted average of professional reviews.
        It uses the same method as Broadway Scorecard, adapted for tech outlets.
      </p>

      <section className="card mt-8 p-5 sm:p-6">
        <h2 className="section-label">1. Each review becomes a number</h2>
        <p className="mt-3 max-w-[65ch] text-sm leading-relaxed">
          When an outlet publishes a score we convert it straight to 100 points: 4.5/5 is 90, 8/10 is 80.
          When an outlet publishes no score, we read the verdict and score the text, and the review is labeled
          &ldquo;Unrated, scored from text&rdquo; so you can tell the difference.
        </p>
      </section>

      <section className="card mt-4 p-5 sm:p-6">
        <h2 className="section-label">2. Bigger outlets count for more</h2>
        <ul className="mt-3 space-y-3 text-sm">
          {([1, 2, 3, 4] as const).map((t) => (
            <li key={t} className="flex items-start gap-3">
              <OutletTierChip tier={t} />
              <span className="w-10 shrink-0 font-semibold tabular-nums">{Math.round(TIER_WEIGHTS[t] * 100)}%</span>
              <span className="min-w-0 text-ink-muted">{TIER_DESCRIPTIONS[t]}</span>
            </li>
          ))}
        </ul>
        <p className="mt-4 text-sm text-ink-muted">A product needs at least {MIN_REVIEWS_FOR_SCORE} reviews before it gets a score.</p>
      </section>

      <section className="card mt-4 p-5 sm:p-6">
        <h2 className="section-label">3. The score sets the label</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {RANGES.map(([key, range]) => (
            <li key={key} className="flex items-center gap-3">
              <span className={`score-badge ${SCORE_TIERS[key].badgeClass} h-8 w-8 rounded-md text-xs`}>{range.split('-')[0]}</span>
              <span className="w-28 shrink-0 font-semibold">{SCORE_TIERS[key].label}</span>
              <span className="w-16 shrink-0 tabular-nums text-ink-faint">{range}</span>
              <span className="min-w-0 text-ink-muted">{SCORE_TIERS[key].blurb}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
