import Link from 'next/link';
import { Metadata } from 'next';
import { getAllShows, getAllBrowseSlugs, getBrowseList } from '@/lib/data';
import { generateBreadcrumbSchema, BASE_URL } from '@/lib/seo';
import { BROWSE_PAGES } from '@/config/browse-pages';

export const metadata: Metadata = {
  title: 'Find the Best Broadway Shows - Rankings & Lists',
  description: 'Browse Broadway shows by category: best for kids, date night, tourists, by genre, discount tickets, and more. Data-driven rankings to find your perfect show.',
  alternates: {
    canonical: `${BASE_URL}/rankings`,
  },
  openGraph: {
    title: 'Find the Best Broadway Shows',
    description: 'Browse all Broadway rankings: by audience, genre, discount tickets, timing, and data scorecards.',
    url: `${BASE_URL}/rankings`,
    type: 'article',
  },
};

// Icons for each category
function AudienceIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
    </svg>
  );
}

function GenreIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 4v16M17 4v16M3 8h4m10 0h4M3 12h18M3 16h4m10 0h4M4 20h16a1 1 0 001-1V5a1 1 0 00-1-1H4a1 1 0 00-1 1v14a1 1 0 001 1z" />
    </svg>
  );
}

function TicketIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 5v2m0 4v2m0 4v2M5 5a2 2 0 00-2 2v3a2 2 0 110 4v3a2 2 0 002 2h14a2 2 0 002-2v-3a2 2 0 110-4V7a2 2 0 00-2-2H5z" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

function ClockIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function ChartIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  );
}

function TrophyIcon() {
  return (
    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 3v4M3 5h4M6 17v4m-2-2h4m5-16l2.286 6.857L21 12l-5.714 2.143L13 21l-2.286-6.857L5 12l5.714-2.143L13 3z" />
    </svg>
  );
}

interface RankingCardProps {
  href: string;
  title: string;
  description: string;
  showCount?: number;
  icon: React.ReactNode;
  color?: string;
}

function RankingCard({ href, title, description, showCount, icon, color = 'text-brand' }: RankingCardProps) {
  return (
    <Link
      href={href}
      className="group card-interactive p-5 flex items-start gap-4 hover:border-brand/30 transition-all"
    >
      <div className={`flex-shrink-0 w-10 h-10 rounded-lg bg-surface-overlay flex items-center justify-center ${color} group-hover:scale-110 transition-transform`}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <h3 className="font-semibold text-white group-hover:text-brand transition-colors flex items-center gap-2">
          {title}
          <svg className="w-4 h-4 text-gray-500 group-hover:text-brand group-hover:translate-x-1 transition-all" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </h3>
        <p className="text-sm text-gray-400 mt-1">{description}</p>
        {showCount !== undefined && (
          <p className="text-xs text-gray-500 mt-1">{showCount} shows</p>
        )}
      </div>
    </Link>
  );
}

export default function RankingsPage() {
  const allShows = getAllShows();
  const openShows = allShows.filter(s => s.status === 'open');

  // Get show counts for browse pages
  const getShowCount = (slug: string): number => {
    const list = getBrowseList(slug);
    return list?.shows.length || 0;
  };

  const breadcrumbSchema = generateBreadcrumbSchema([
    { name: 'Home', url: BASE_URL },
    { name: 'Rankings', url: `${BASE_URL}/rankings` },
  ]);

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbSchema) }}
      />

      <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
        {/* Back Link */}
        <Link href="/" className="inline-flex items-center gap-1.5 text-brand hover:text-brand-hover text-sm font-medium mb-4 transition-colors">
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          All Shows
        </Link>

        {/* Header */}
        <div className="text-center mb-12">
          <h1 className="text-4xl sm:text-5xl font-bold text-white">Find the Best</h1>
          <p className="text-xl text-gray-400 mt-3">
            {openShows.length} shows. Ranked by what actually matters.
          </p>
          <p className="text-gray-500 mt-2">
            Pick a category to see how the shows stack up.
          </p>
        </div>

        {/* By Audience */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <AudienceIcon />
            <h2 className="text-lg font-bold text-white">By Audience</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <RankingCard
              href="/browse/broadway-shows-for-kids"
              title="Best for Kids"
              description="Family-friendly shows for young theatergoers"
              showCount={getShowCount('broadway-shows-for-kids')}
              icon={<span className="text-lg">👨‍👩‍👧</span>}
            />
            <RankingCard
              href="/browse/broadway-shows-for-date-night"
              title="Best for Date Night"
              description="Romantic shows for couples"
              showCount={getShowCount('broadway-shows-for-date-night')}
              icon={<span className="text-lg">💑</span>}
            />
            <RankingCard
              href="/browse/broadway-shows-for-tourists"
              title="Must-See for Tourists"
              description="Iconic shows for NYC visitors"
              showCount={getShowCount('broadway-shows-for-tourists')}
              icon={<span className="text-lg">🗽</span>}
            />
            <RankingCard
              href="/browse/first-time-broadway"
              title="Best for First-Timers"
              description="Perfect introductions to Broadway"
              showCount={getShowCount('first-time-broadway')}
              icon={<span className="text-lg">🌟</span>}
            />
          </div>
        </section>

        {/* By Genre */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <GenreIcon />
            <h2 className="text-lg font-bold text-white">By Genre</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <RankingCard
              href="/browse/best-broadway-musicals"
              title="Best Musicals"
              description="Highest-rated musicals playing now"
              showCount={getShowCount('best-broadway-musicals')}
              icon={<span className="text-lg">🎵</span>}
            />
            <RankingCard
              href="/browse/best-broadway-plays"
              title="Best Plays"
              description="Top-rated dramatic productions"
              showCount={getShowCount('best-broadway-plays')}
              icon={<span className="text-lg">🎭</span>}
            />
            <RankingCard
              href="/browse/best-broadway-comedies"
              title="Funniest Shows"
              description="Broadway's best laughs"
              showCount={getShowCount('best-broadway-comedies')}
              icon={<span className="text-lg">😂</span>}
            />
            <RankingCard
              href="/browse/best-broadway-dramas"
              title="Best Dramas"
              description="Powerful dramatic theater"
              showCount={getShowCount('best-broadway-dramas')}
              icon={<span className="text-lg">💔</span>}
            />
            <RankingCard
              href="/browse/best-broadway-revivals"
              title="Best Revivals"
              description="Classic shows reimagined"
              showCount={getShowCount('best-broadway-revivals')}
              icon={<span className="text-lg">🔄</span>}
            />
            <RankingCard
              href="/browse/jukebox-musicals-on-broadway"
              title="Jukebox Musicals"
              description="Songs you already know"
              showCount={getShowCount('jukebox-musicals-on-broadway')}
              icon={<span className="text-lg">🎤</span>}
            />
          </div>
        </section>

        {/* Discount Tickets */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <TicketIcon />
            <h2 className="text-lg font-bold text-white">Discount Tickets</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <RankingCard
              href="/best-value"
              title="Best Value"
              description="All discount options, cheapest first"
              icon={<span className="text-lg">💰</span>}
              color="text-emerald-400"
            />
            <RankingCard
              href="/lotteries"
              title="Lottery Tickets"
              description="Digital lotteries for $10-60 seats"
              icon={<span className="text-lg">🎰</span>}
              color="text-purple-400"
            />
            <RankingCard
              href="/rush"
              title="Rush Tickets"
              description="Same-day discounted tickets"
              icon={<span className="text-lg">⚡</span>}
              color="text-blue-400"
            />
            <RankingCard
              href="/standing-room"
              title="Standing Room"
              description="Last resort for sold-out shows"
              icon={<span className="text-lg">🧍</span>}
              color="text-gray-400"
            />
          </div>
        </section>

        {/* By Timing */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <CalendarIcon />
            <h2 className="text-lg font-bold text-white">By Timing</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <RankingCard
              href="/browse/broadway-shows-closing-soon"
              title="Closing Soon"
              description="Last chance to see these shows"
              showCount={getShowCount('broadway-shows-closing-soon')}
              icon={<span className="text-lg">⏰</span>}
              color="text-red-400"
            />
            <RankingCard
              href="/browse/new-broadway-shows-2025"
              title="New in 2025"
              description="Fresh productions this year"
              showCount={getShowCount('new-broadway-shows-2025')}
              icon={<span className="text-lg">✨</span>}
            />
            <RankingCard
              href="/browse/upcoming-broadway-shows"
              title="Coming Soon"
              description="Shows in previews"
              showCount={getShowCount('upcoming-broadway-shows')}
              icon={<span className="text-lg">🔜</span>}
            />
            <RankingCard
              href="/browse/longest-running-broadway-shows"
              title="Longest Running"
              description="Legends of the Great White Way"
              showCount={getShowCount('longest-running-broadway-shows')}
              icon={<span className="text-lg">🏆</span>}
            />
          </div>
        </section>

        {/* By Duration */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <ClockIcon />
            <h2 className="text-lg font-bold text-white">By Duration</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <RankingCard
              href="/browse/short-broadway-shows"
              title="Short Shows"
              description="Under 90 minutes"
              showCount={getShowCount('short-broadway-shows')}
              icon={<span className="text-lg">⚡</span>}
            />
            <RankingCard
              href="/browse/broadway-shows-no-intermission"
              title="No Intermission"
              description="Straight through experiences"
              showCount={getShowCount('broadway-shows-no-intermission')}
              icon={<span className="text-lg">▶️</span>}
            />
          </div>
        </section>

        {/* Awards */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <TrophyIcon />
            <h2 className="text-lg font-bold text-white">Awards</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <RankingCard
              href="/browse/tony-winners-on-broadway"
              title="Tony Winners"
              description="Award-winning productions"
              showCount={getShowCount('tony-winners-on-broadway')}
              icon={<span className="text-lg">🏆</span>}
              color="text-yellow-400"
            />
            <RankingCard
              href="/browse/tony-nominated-2025"
              title="2025 Tony Nominees"
              description="This year's celebrated shows"
              showCount={getShowCount('tony-nominated-2025')}
              icon={<span className="text-lg">🎖️</span>}
              color="text-yellow-400"
            />
            <RankingCard
              href="/browse/best-broadway-show-right-now"
              title="The #1 Show"
              description="The single best show playing today"
              showCount={1}
              icon={<span className="text-lg">👑</span>}
              color="text-amber-400"
            />
          </div>
        </section>

        {/* Data & Scorecards */}
        <section className="mb-10">
          <div className="flex items-center gap-2 mb-4">
            <ChartIcon />
            <h2 className="text-lg font-bold text-white">Data & Scorecards</h2>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <RankingCard
              href="/box-office"
              title="Box Office Scorecard"
              description="Weekly grosses and all-time stats"
              icon={<span className="text-lg">💵</span>}
              color="text-green-400"
            />
            <RankingCard
              href="/biz-buzz"
              title="Commercial Scorecard"
              description="Which shows make money"
              icon={<span className="text-lg">📊</span>}
              color="text-blue-400"
            />
            <RankingCard
              href="/audience-buzz"
              title="Audience Scorecard"
              description="What real theatergoers think"
              icon={<span className="text-lg">❤️</span>}
              color="text-red-400"
            />
          </div>
        </section>

        {/* Footer note */}
        <div className="text-center text-sm text-gray-500 border-t border-white/5 pt-8 mt-8">
          <p>
            Data from {openShows.length} Broadway shows. Rankings update as we add new reviews.
          </p>
        </div>
      </div>
    </>
  );
}
