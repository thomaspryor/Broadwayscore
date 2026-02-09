import type { Metadata } from 'next';
import UnfollowClient from './UnfollowClient';
import { Suspense } from 'react';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export const metadata: Metadata = {
  title: 'Unfollow Show',
  description: 'Unfollow a Broadway show to stop receiving update emails.',
  alternates: {
    canonical: `${BASE_URL}/unfollow`,
  },
  robots: { index: false, follow: false },
};

export default function UnfollowPage() {
  return (
    <div className="max-w-lg mx-auto px-4 py-16 sm:py-24">
      <Suspense fallback={
        <div className="text-center text-gray-400">Loading...</div>
      }>
        <UnfollowClient />
      </Suspense>
    </div>
  );
}
