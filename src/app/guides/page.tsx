import Link from 'next/link';
import { Metadata } from 'next';
import { GUIDE_PAGES } from '@/config/guide-pages';
import { getGuideList } from '@/lib/data-guides';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import Breadcrumb from '@/components/Breadcrumb';

export const metadata: Metadata = {
  title: 'Broadway Guides - Expert-Curated Show Recommendations',
  description: 'Expert guides to Broadway shows: best musicals, plays, family-friendly picks, discount tickets, and more. Updated monthly with CriticScore ratings and editorial insights.',
  alternates: { canonical: `${BASE_URL}/guides` },
  openGraph: {
    title: 'Broadway Guides - Expert-Curated Show Recommendations',
    description: 'Expert guides to Broadway shows: best musicals, plays, family-friendly picks, discount tickets, and more.',
    url: `${BASE_URL}/guides`,
    type: 'website',
    images: [{ url: `${BASE_URL}/og/home.png`, width: 1200, height: 630, alt: 'Broadway Guides' }],
  },
};

export default function GuidesIndexPage() {
  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Guides', url: `${BASE_URL}/guides` },
  ]);

  const guides = Object.values(GUIDE_PAGES).map(config => {
    const guideList = getGuideList(config.slug);
    return {
      slug: config.slug,
      title: config.title,
      showCount: guideList?.shows.length ?? 0,
      topShow: guideList?.shows[0]?.title,
      topScore: guideList?.shows[0]?.criticScore?.score
        ? Math.round(guideList.shows[0].criticScore.score)
        : null,
    };
  });

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify([breadcrumbSchema]) }}
      />

      <div className="max-w-3xl mx-auto px-4 sm:px-6 py-8">
        {/* Breadcrumb */}
        <Breadcrumb className="mb-4" items={[
          { label: 'Home', href: '/' },
          { label: 'Guides' },
        ]} />

        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-6 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          Home
        </Link>

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold text-white mb-4">Broadway Guides</h1>
          <p className="text-gray-300 leading-relaxed text-base sm:text-lg">
            Expert-curated guides to help you find the perfect Broadway show. Each guide features CriticScore ratings, editorial insights, and ticket information updated monthly.
          </p>
        </div>

        {/* Guide Cards */}
        <div className="space-y-4">
          {guides.map(guide => (
            <Link
              key={guide.slug}
              href={`/guides/${guide.slug}`}
              className="card p-4 sm:p-5 block hover:bg-surface-raised/80 transition-colors group"
            >
              <h2 className="font-bold text-white text-base sm:text-lg group-hover:text-brand transition-colors">
                {guide.title}
              </h2>
              <div className="flex items-center gap-3 mt-2 text-sm text-gray-400">
                <span>{guide.showCount} {guide.showCount === 1 ? 'show' : 'shows'}</span>
                {guide.topShow && (
                  <>
                    <span className="text-gray-600">|</span>
                    <span>
                      Top pick: {guide.topShow}
                      {guide.topScore !== null && (
                        <span className="text-brand ml-1">({guide.topScore})</span>
                      )}
                    </span>
                  </>
                )}
              </div>
            </Link>
          ))}
        </div>

        {/* Browse Pages */}
        <div className="mt-10 pt-8 border-t border-white/5">
          <h2 className="text-xl font-bold text-white mb-4">Browse by Category</h2>
          <div className="flex flex-wrap gap-2">
            {[
              { href: '/browse/best-recent-shows', label: 'New Shows' },
              { href: '/browse/best-recent-musicals', label: 'New Musicals' },
              { href: '/browse/best-recent-plays', label: 'New Plays' },
              { href: '/browse/broadway-show-runtimes', label: 'Show Runtimes' },
              { href: '/browse/broadway-age-guide', label: 'Age Guide' },
              { href: '/browse/broadway-ticket-prices', label: 'Ticket Prices' },
              { href: '/browse/most-divisive-broadway-shows', label: 'Most Divisive' },
              { href: '/browse/longest-running-broadway-shows', label: 'Longest-Running' },
              { href: '/browse/broadway-shows-closing-soon', label: 'Closing Soon' },
              { href: '/browse/best-broadway-show-right-now', label: '#1 Show Right Now' },
            ].map(({ href, label }) => (
              <Link
                key={href}
                href={href}
                className="px-4 py-2.5 sm:py-2 rounded-full bg-surface-overlay hover:bg-surface-raised text-sm text-gray-300 hover:text-white transition-colors min-h-[44px] sm:min-h-0 flex items-center"
              >
                {label}
              </Link>
            ))}
          </div>
        </div>

        {/* Static Guides */}
        <div className="mt-8 pt-6 border-t border-white/5">
          <h2 className="text-xl font-bold text-white mb-4">Planning Guides</h2>
          <div className="grid gap-3">
            {[
              { href: '/guides/what-to-wear-to-broadway', title: 'What to Wear to Broadway', desc: 'Dress code tips for every occasion' },
              { href: '/guides/broadway-first-timer-guide', title: 'First-Timer Guide', desc: 'Everything you need to know for your first show' },
              { href: '/guides/off-broadway-vs-broadway', title: 'Off-Broadway vs Broadway', desc: 'What\'s the difference and which is right for you?' },
              { href: '/guides/cheap-broadway-tickets', title: 'How to Get Cheap Tickets', desc: 'Lotteries, rush tickets, TKTS, and more' },
            ].map(({ href, title, desc }) => (
              <Link
                key={href}
                href={href}
                className="card p-4 hover:bg-surface-raised transition-colors group"
              >
                <h3 className="font-bold text-white text-sm group-hover:text-brand transition-colors">{title}</h3>
                <p className="text-gray-400 text-xs mt-1">{desc}</p>
              </Link>
            ))}
          </div>
        </div>

        {/* Methodology Link */}
        <div className="mt-8 text-sm text-gray-500 border-t border-white/5 pt-6">
          <Link href="/methodology" className="text-brand hover:text-brand-hover transition-colors">
            How are scores calculated? →
          </Link>
        </div>
      </div>
    </>
  );
}
