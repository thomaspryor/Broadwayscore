import { Metadata } from 'next';
import { BASE_URL, SITE_OG_IMAGE } from '@/lib/seo';
import BrandPageClient from './BrandPageClient';

export const metadata: Metadata = {
  title: 'Brand Kit',
  alternates: { canonical: `${BASE_URL}/brand` },
  description: 'Broadway Scorecard colors, typography, and brand assets. Copy-paste hex values, download the palette for Canva, or fetch brand-tokens.json for programmatic use.',
  openGraph: {
    images: [SITE_OG_IMAGE],
    title: 'Broadway Scorecard Brand Kit',
    description: 'Colors, fonts, and downloads for designers and developers.',
    url: 'https://broadwayscorecard.com/brand',
  },
};

export default function BrandPage() {
  return <BrandPageClient />;
}
