import Link from 'next/link';
import type { ComputedProduct } from '@/lib/engine';
import { DeviceArt } from './DeviceArt';
import { ScoreBadge } from './ScoreBadge';

/** Poster tile with corner score, like Broadway Scorecard's MiniShowCard. */
export function MiniProductCard({ product }: { product: ComputedProduct }) {
  return (
    <Link href={`/product/${product.slug}/`} className="group block w-full">
      <div className="relative aspect-[3/4] overflow-hidden rounded-xl border border-line shadow-card transition-transform duration-200 group-hover:-translate-y-0.5">
        <DeviceArt art={product.art} name={product.name} className="h-full w-full" />
        <div className="absolute bottom-2 right-2"><ScoreBadge score={product.criticScore} size="sm" /></div>
      </div>
      <p className="mt-2 line-clamp-2 text-sm font-semibold leading-snug">{product.name}</p>
      <p className="text-xs text-ink-faint">{product.brand}</p>
    </Link>
  );
}
