import type { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { FANTASY_OG_IMAGE } from '@/config/fantasy-listing';

// Private league pages list players' team names and exist to be shared by
// link, never found by search: always noindex (this overrides the listing
// switch in src/app/fantasy/layout.tsx). They set their own canonical and
// link preview so a shared invite neither points search engines at the
// homepage nor previews as the homepage card (BRO-5483 review).
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  const url = `${BASE_URL}/fantasy/league/${encodeURIComponent(code)}`;
  const title = 'Join my Broadway Fantasy League';
  const description = 'Pick your Broadway shows once and they score all season. The best team on Tony night wins.';
  return {
    title: 'Private League | Broadway Fantasy League',
    description,
    robots: { index: false, follow: false },
    alternates: { canonical: url },
    openGraph: { title, description, url, images: [{ url: `${BASE_URL}${FANTASY_OG_IMAGE}`, width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', title, description },
  };
}

export default function FantasyLeagueLayout({ children }: { children: React.ReactNode }) {
  return children;
}
