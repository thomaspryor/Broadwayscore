import type { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { fantasySocial } from '@/config/fantasy-social';

// The page is a client component, so its metadata lives here. Without a
// canonical the root layout's homepage canonical applied (BRO-5483 review).
const description = 'Start a private Broadway Fantasy League for your friends and share the invite link.';

export const metadata: Metadata = {
  title: 'Create a Private League | Broadway Fantasy League',
  description,
  alternates: { canonical: `${BASE_URL}/fantasy/create-league` },
  ...fantasySocial('Create a Private League | Broadway Fantasy League', '/fantasy/create-league', description),
};

export default function FantasyCreateLeagueLayout({ children }: { children: React.ReactNode }) {
  return children;
}
