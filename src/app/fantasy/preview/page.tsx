/**
 * BFL BTC-style redesign preview — NOT shipped to production nav.
 * Navigate directly to /fantasy/preview to demo the screen-based mobile-first flow.
 */
import type { Metadata } from 'next';
import { getFantasyShowsSorted } from '@/lib/data-fantasy';
import { FantasyPreviewClient } from './FantasyPreviewClient';

export const metadata: Metadata = {
  title: 'BFL preview — BTC-style draft flow',
  robots: 'noindex, nofollow',
};

export default function FantasyPreviewPage() {
  const shows = getFantasyShowsSorted().map(s => ({
    id: s.id,
    title: s.title,
    price: s.price,
    type: s.type,
    category: s.category,
    status: s.status,
    image: s.image ?? null,
    criticScore: s.criticScore ?? null,
    audienceGrade: s.audienceGrade ?? null,
  }));

  return <FantasyPreviewClient shows={shows} />;
}
