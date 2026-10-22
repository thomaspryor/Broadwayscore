import { getAllProducts, getTotals } from '@/lib/data';
import { MiniProductCard, ProductListCard } from '@/components/product-cards';
import { Logo } from '@/components/Header';

export default function HomePage() {
  const products = getAllProducts();
  const totals = getTotals();
  const newest = [...products].sort((a, b) => b.releaseDate.localeCompare(a.releaseDate));
  return (
    <div className="mx-auto max-w-3xl px-4 sm:px-6">
      <section className="pb-8 pt-12 sm:pt-16">
        <h1><Logo className="text-5xl sm:text-7xl" /></h1>
        <p className="mt-4 text-xl text-ink-muted sm:text-2xl">Every gadget. Every review. One score.</p>
        <p className="mt-1 text-base text-ink-faint sm:text-lg">
          {totals.products} products. {totals.reviews} critic reviews from {totals.outlets} outlets. And counting.
        </p>
      </section>

      <section aria-labelledby="newest" className="pb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="newest" className="text-lg font-bold">Newest Releases</h2>
          <span className="text-sm text-ink-faint">Phones · 2026</span>
        </div>
        <div className="grid grid-cols-3 gap-3 sm:gap-5">
          {newest.map((p) => <MiniProductCard key={p.id} product={p} />)}
        </div>
      </section>

      <section aria-labelledby="all">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 id="all" className="text-lg font-bold">All Phones</h2>
          <span className="section-label">Sorted by critic score</span>
        </div>
        <div className="flex flex-col gap-3">
          {products.map((p) => <ProductListCard key={p.id} product={p} />)}
        </div>
      </section>
    </div>
  );
}
