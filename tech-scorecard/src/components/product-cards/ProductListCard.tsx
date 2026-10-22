import Link from 'next/link';
import type { ComputedProduct } from '@/lib/engine';
import { getScoreTier } from '@/config/score-buckets';
import { formatDate, formatPrice } from '@/lib/format';
import { DeviceArt } from './DeviceArt';
import { ProductChips } from './ProductChips';
import { ScoreBadge } from './ScoreBadge';

/** [Thumbnail] [Info] [Score], same three-column card as Broadway Scorecard's ShowListCard. */
export function ProductListCard({ product }: { product: ComputedProduct }) {
  const tier = product.criticScore != null ? getScoreTier(product.criticScore) : null;
  const price = formatPrice(product.launchPrice);
  return (
    <Link href={`/product/${product.slug}/`} className="card-interactive flex items-center gap-4 p-4 sm:gap-5 sm:p-5">
      <div className="h-[84px] w-[84px] shrink-0 overflow-hidden rounded-lg sm:h-28 sm:w-28">
        <DeviceArt art={product.art} name={product.name} className="h-full w-full" />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="line-clamp-2 text-lg font-bold leading-tight sm:text-xl">{product.name}</h3>
        <div className="mt-1.5"><ProductChips category={product.category} releaseDate={product.releaseDate} /></div>
        <p className="mt-2 text-sm text-ink-muted">
          {product.brand} · {formatDate(product.releaseDate)}
          {price && <span className="hidden sm:inline"> · From {price}</span>}
        </p>
      </div>
      <div className="flex w-20 shrink-0 flex-col items-center gap-1 text-center sm:w-24">
        {tier && <span className={`text-[10px] font-bold uppercase tracking-wide ${tier.textClass}`}>{tier.label}</span>}
        <ScoreBadge score={product.criticScore} />
        <span className="text-[11px] text-ink-faint">{product.reviewCount} reviews</span>
      </div>
    </Link>
  );
}
