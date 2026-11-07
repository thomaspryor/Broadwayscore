import { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { fantasySocial } from '@/config/fantasy-social';

export const metadata: Metadata = {
  title: 'Draft Your Team | Broadway Fantasy League',
  description: 'Pick up to 8 Broadway shows within a $100 budget. Earn points from critics, audiences, box office, and Tony Awards. Free, no account needed.',
  // Without this the root layout's homepage canonical applies here.
  alternates: { canonical: `${BASE_URL}/fantasy/draft` },
  ...fantasySocial('Draft Your Team | Broadway Fantasy League', '/fantasy/draft'),
};

export default function FantasyDraftLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
