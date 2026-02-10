import type { Metadata } from 'next';
import UnsubscribeClient from './UnsubscribeClient';
import { Suspense } from 'react';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Unsubscribe',
  description: 'Unsubscribe from Broadway Scorecard opening night email alerts.',
  alternates: {
    canonical: `${BASE_URL}/unsubscribe`,
  },
  robots: { index: false, follow: false },
};

export default function UnsubscribePage() {
  return (
    <div className="max-w-lg mx-auto px-4 py-16 sm:py-24">
      <Suspense fallback={
        <div className="text-center text-gray-400">Loading...</div>
      }>
        <UnsubscribeClient />
      </Suspense>
    </div>
  );
}
