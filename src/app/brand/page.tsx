import { Metadata } from 'next';
import BrandPageClient from './BrandPageClient';

export const metadata: Metadata = {
  title: 'Brand Kit',
  description: 'Broadway Scorecard colors, typography, and brand assets. Copy-paste hex values, download the palette for Canva, or fetch brand-tokens.json for programmatic use.',
  openGraph: {
    title: 'Broadway Scorecard Brand Kit',
    description: 'Colors, fonts, and downloads for designers and developers.',
    url: 'https://broadwayscorecard.com/brand',
  },
  robots: {
    index: true,
    follow: true,
  },
};

export default function BrandPage() {
  return <BrandPageClient />;
}
