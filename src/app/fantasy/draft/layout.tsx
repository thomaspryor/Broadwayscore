import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Draft Your Team | Broadway Fantasy League',
  description: 'Pick 8 Broadway shows within a $100 budget. Earn points from critics, audiences, box office, and Tony Awards. Free, no account needed.',
};

export default function FantasyDraftLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
