import productsJson from '../../data/products.json';
import reviewsJson from '../../data/reviews.json';
import outletsJson from '../../data/outlets.json';
import { computeProduct, type ComputedProduct } from './engine';
import type { Outlet, Product, Review } from './data-types';

const outlets: Record<string, Outlet> = Object.fromEntries((outletsJson as Outlet[]).map((o) => [o.id, o]));

let cache: ComputedProduct[] | null = null;

export function getAllProducts(): ComputedProduct[] {
  if (!cache) {
    cache = (productsJson as Product[])
      .map((p) => computeProduct(p, reviewsJson as Review[], outlets))
      .sort((a, b) => (b.criticScore ?? -1) - (a.criticScore ?? -1));
  }
  return cache;
}

export function getProduct(slug: string): ComputedProduct | undefined {
  return getAllProducts().find((p) => p.slug === slug);
}

export function getTotals() {
  const products = getAllProducts();
  return {
    products: products.length,
    reviews: products.reduce((n, p) => n + p.reviewCount, 0),
    outlets: new Set(products.flatMap((p) => p.reviews.map((r) => r.outletId))).size,
  };
}
