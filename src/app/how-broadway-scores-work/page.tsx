import { redirect } from 'next/navigation';
import { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Redirecting to Methodology...',
  robots: {
    index: false,
    follow: true,
  },
};

export default function HowBroadwayScoresWorkPage() {
  redirect('/methodology');
}
