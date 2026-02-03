import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'NVP Portfolio | BroadwayScorecard',
  description: 'Broadway shows invested in by Nothing Ventured Productions',
  robots: 'noindex, nofollow',
};

export default function NVPLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
