import type { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { FANTASY_OG_IMAGE } from '@/config/fantasy-listing';

// The page is a client component, so its metadata lives here. Without a
// canonical the root layout's homepage canonical applied (BRO-5483 review).
export const metadata: Metadata = {
  title: 'Create a Private League | Broadway Fantasy League',
  description: 'Start a private Broadway Fantasy League for your friends and share the invite link.',
  alternates: { canonical: `${BASE_URL}/fantasy/create-league` },
  openGraph: {
    title: 'Create a Private League | Broadway Fantasy League',
    description: 'Start a private Broadway Fantasy League for your friends and share the invite link.',
    url: `${BASE_URL}/fantasy/create-league`,
    images: [{ url: `${BASE_URL}${FANTASY_OG_IMAGE}`, width: 1200, height: 630 }],
  },
};

export default function FantasyCreateLeagueLayout({ children }: { children: React.ReactNode }) {
  return children;
}
