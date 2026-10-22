import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getAllProducts, getProduct } from '@/lib/data';
import { getScoreTier } from '@/config/score-buckets';
import { TIER_WEIGHTS } from '@/config/scoring';
import { formatDate, formatPrice, releaseLabel } from '@/lib/format';
import { DeviceArt, MiniProductCard, OutletTierChip, ProductChips, ScoreBadge, ScoreBreakdownBar } from '@/components/product-cards';
import { ReviewList } from '@/components/ReviewRow';

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return getAllProducts().map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const p = getProduct((await params).slug);
  if (!p) return {};
  const score = p.criticScore != null ? ` ${Math.round(p.criticScore)}/100` : '';
  return { title: `${p.name} reviews:${score} critic score | Tech Scorecard`, description: p.criticsTake };
}

export default async function ProductPage({ params }: { params: Promise<Params> }) {
  const product = getProduct((await params).slug);
  if (!product) notFound();
  const tier = product.criticScore != null ? getScoreTier(product.criticScore) : null;
  const price = formatPrice(product.launchPrice);
  const byDate = [...product.reviews].sort((a, b) => b.date.localeCompare(a.date) || b.score - a.score);
  const others = getAllProducts().filter((p) => p.id !== product.id);

  return (
    <div className="mx-auto max-w-3xl px-4 pb-4 pt-6 sm:px-6">
      <nav aria-label="Breadcrumb" className="mb-4 text-sm text-ink-faint">
        <Link href="/" className="hover:text-ink">Home</Link>
        <span className="mx-2">/</span>
        <Link href="/" className="hover:text-ink">Phones</Link>
        <span className="mx-2">/</span>
        <span className="text-ink">{product.name}</span>
      </nav>

      {/* Hero card */}
      <section className="card p-4 sm:p-5">
        <div className="flex gap-4 sm:gap-6">
          <div className="w-28 shrink-0 overflow-hidden rounded-xl border border-line sm:w-44">
            <DeviceArt art={product.art} name={product.name} className="aspect-[3/4] h-full w-full" />
          </div>
          <div className="min-w-0 flex-1">
            <ProductChips category={product.category} releaseDate={product.releaseDate} />
            <h1 className="mt-2 text-2xl font-extrabold leading-tight sm:text-4xl">{product.name}</h1>
            <p className="mt-1.5 text-sm text-ink-muted sm:text-base">
              {product.brand}{price && <> · From {price}</>}
            </p>
            <p className="text-xs text-ink-faint sm:text-sm">{releaseLabel(product.releaseDate)}</p>
            <div className="mt-4 hidden items-center gap-4 sm:flex">
              <ScoreBadge score={product.criticScore} size="lg" />
              <ScoreSummary product={product} tier={tier} />
            </div>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-4 sm:hidden">
          <ScoreBadge score={product.criticScore} size="lg" />
          <ScoreSummary product={product} tier={tier} />
        </div>

        <div className="mt-5"><ScoreBreakdownBar breakdown={product.breakdown} /></div>

        <div className="mt-5">
          <h2 className="section-label">Critics&apos; Take</h2>
          <p className="mt-2 leading-relaxed text-ink">{product.criticsTake}</p>
        </div>

        {product.officialUrl && (
          <div className="mt-5 flex flex-wrap gap-2">
            <a href={product.officialUrl} target="_blank" rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-[#1a1a1a] hover:bg-brand-hover">
              From the manufacturer <span aria-hidden="true">→</span>
            </a>
          </div>
        )}
      </section>

      {/* Loved / gripes */}
      <section className="mt-6 grid gap-4 sm:grid-cols-2">
        <div className="card p-5">
          <h2 className="section-label text-score-great">What critics loved</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed">
            {product.loved.map((x) => <li key={x} className="flex gap-2"><span className="text-score-great" aria-hidden="true">+</span><span>{x}</span></li>)}
          </ul>
        </div>
        <div className="card p-5">
          <h2 className="section-label text-score-skip">Common gripes</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed">
            {product.gripes.map((x) => <li key={x} className="flex gap-2"><span className="text-score-skip" aria-hidden="true">−</span><span>{x}</span></li>)}
          </ul>
        </div>
      </section>

      {/* Critic Scorecard */}
      <section className="card mt-6 p-4 sm:p-6" aria-labelledby="scorecard">
        <div className="flex items-baseline justify-between">
          <h2 id="scorecard" className="section-label">Critic Scorecard</h2>
          <span className="text-xs text-ink-faint">{product.reviewCount} reviews</span>
        </div>
        <div className="sort-toggle relative mt-3" role="radiogroup" aria-label="Sort reviews">
          <input type="radio" name={`sort-${product.slug}`} id={`sort-score-${product.slug}`} className="by-score" defaultChecked />
          <input type="radio" name={`sort-${product.slug}`} id={`sort-date-${product.slug}`} className="by-date" />
          <div className="sort-labels flex items-center gap-3 text-sm">
            <span className="text-ink-faint">Sort:</span>
            <label htmlFor={`sort-score-${product.slug}`} className="lbl-score">By Score</label>
            <label htmlFor={`sort-date-${product.slug}`} className="lbl-date">By Date</label>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-ink-faint">
            <span>Weighted by outlet tier:</span>
            {([1, 2, 3, 4] as const).map((t) => (
              <span key={t} className="inline-flex items-center gap-1"><OutletTierChip tier={t} />{Math.round(TIER_WEIGHTS[t] * 100)}%</span>
            ))}
          </div>
          <div className="list-score mt-1"><ReviewList reviews={product.reviews} /></div>
          <div className="list-date mt-1"><ReviewList reviews={byDate} /></div>
        </div>
        <div className="mt-3 border-t border-line pt-3 text-xs">
          <Link href="/methodology/" className="text-ink-faint hover:text-ink">How this score works →</Link>
        </div>
      </section>

      {/* Quick facts */}
      <section className="card mt-6 p-4 sm:p-6" aria-labelledby="facts">
        <h2 id="facts" className="section-label">Quick Facts</h2>
        <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          {product.specs.map((s) => (
            <div key={s.label} className="min-w-0">
              <dt className="text-xs text-ink-faint">{s.label}</dt>
              <dd className="text-sm font-medium text-ink">{s.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section className="mt-10" aria-labelledby="more">
        <h2 id="more" className="mb-3 text-lg font-bold">Compare with</h2>
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
          {others.map((p) => <MiniProductCard key={p.id} product={p} />)}
        </div>
      </section>
    </div>
  );
}

function ScoreSummary({ product, tier }: { product: ReturnType<typeof getAllProducts>[number]; tier: ReturnType<typeof getScoreTier> | null }) {
  return (
    <div className="min-w-0">
      <p className={`text-xl font-bold sm:text-2xl ${tier?.textClass ?? 'text-ink-faint'}`}>{tier?.label ?? 'Not Yet Rated'}</p>
      <p className="text-sm text-ink-muted">Based on {product.reviewCount} Critic Reviews</p>
      <p className="text-xs text-ink-faint">
        {product.ratedCount} with a published score, {product.reviewCount - product.ratedCount} scored from text ·{' '}
        <Link href="/methodology/" className="underline underline-offset-2 hover:text-ink">How it works</Link>
      </p>
      {product.latestReviewDate && <p className="text-xs text-ink-faint">Latest review {formatDate(product.latestReviewDate)}</p>}
    </div>
  );
}
