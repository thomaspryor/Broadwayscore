import { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';

export const metadata: Metadata = {
  title: 'Draft Your Team | Broadway Fantasy League',
  description: 'Pick up to 8 Broadway shows within a $100 budget. Earn points from critics, audiences, box office, and Tony Awards. Free, no account needed.',
  // Without this the root layout's homepage canonical applies here.
  alternates: { canonical: `${BASE_URL}/fantasy/draft` },
  openGraph: {
    title: 'Draft Your Team | Broadway Fantasy League',
    description: 'Pick your Broadway shows once and they score all season. The best team on Tony night wins.',
    url: `${BASE_URL}/fantasy/draft`,
    images: [{ url: `${BASE_URL}/og/fantasy.png`, width: 1200, height: 630 }],
  },
};

export default function FantasyDraftLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
