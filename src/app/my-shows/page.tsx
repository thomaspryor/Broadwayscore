import type { Metadata } from 'next';
import MyShowsClient from './MyShowsClient';

export const metadata: Metadata = {
  title: 'My Shows',
  description: 'Your personal theater diary and watchlist on Broadway Scorecard.',
  robots: { index: false, follow: false },
};

export default function MyShowsPage() {
  return <MyShowsClient />;
}
