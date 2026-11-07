import type { Metadata } from 'next';
import { BASE_URL } from '@/lib/seo';
import { fantasySocial, FANTASY_SOCIAL_LINE } from '@/config/fantasy-social';

// Private league pages list players' team names and exist to be shared by
// link, never found by search: always noindex (this overrides the listing
// switch in src/app/fantasy/layout.tsx). They set their own canonical and
// link preview so a shared invite neither points search engines at the
// homepage nor previews as the homepage card (BRO-5483 review).
export async function generateMetadata({ params }: { params: Promise<{ code: string }> }): Promise<Metadata> {
  const { code } = await params;
  const path = `/fantasy/league/${encodeURIComponent(code)}`;
  return {
    title: 'Private League | Broadway Fantasy League',
    description: FANTASY_SOCIAL_LINE,
    robots: { index: false, follow: false },
    alternates: { canonical: `${BASE_URL}${path}` },
    ...fantasySocial('Join my Broadway Fantasy League', path),
  };
}

export default function FantasyLeagueLayout({ children }: { children: React.ReactNode }) {
  return children;
}
