'use client';

import Link from 'next/link';
import { useCurrentMarket } from '@/hooks/useCurrentMarket';
import HeaderSubscribeButton from '@/components/HeaderSubscribeButton';

interface FooterMarketContentProps {
  totalReviews: number;
  featureFlags: {
    discountTickets: boolean;
    tonyPredictions: boolean;
    tonyPeople: boolean;
    goldLists: boolean;
    boxOffice: boolean;
    commercial: boolean;
    criticPages: boolean;
    creativePages: boolean;
    castPages: boolean;
  };
}

export default function FooterMarketContent({ totalReviews, featureFlags }: FooterMarketContentProps) {
  const marketId = useCurrentMarket();
  const isLondon = marketId === 'west-end' || marketId === 'off-west-end';

  const siteName = isLondon ? 'West End Scorecard' : 'Broadway Scorecard';
  const logoPrefix = isLondon ? 'West End' : 'Broadway';

  return (
    <>
      {/* Browse Categories */}
      {isLondon ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-8 mb-8 pb-8 border-b border-white/5">
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">By Category</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/west-end" className="hover:text-white transition-colors">All West End Shows</Link></li>
              <li><Link href="/browse/best-west-end-musicals" className="hover:text-white transition-colors">Best Musicals</Link></li>
              <li><Link href="/browse/best-west-end-plays" className="hover:text-white transition-colors">Best Plays</Link></li>
              <li><Link href="/browse/longest-running-west-end-shows" className="hover:text-white transition-colors">Longest-Running</Link></li>
              <li><Link href="/browse/upcoming-west-end-shows" className="hover:text-white transition-colors">Upcoming Shows</Link></li>
              <li><Link href="/browse/new-west-end-shows-2026" className="hover:text-white transition-colors">New in 2026</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">By Audience</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/browse/west-end-shows-for-kids" className="hover:text-white transition-colors">Shows for Kids</Link></li>
              <li><Link href="/west-end/trending" className="hover:text-white transition-colors">Trending Shows</Link></li>
              <li><Link href="/west-end/audience-buzz" className="hover:text-white transition-colors">Audience Buzz</Link></li>
              <li><Link href="/west-end/theater" className="hover:text-white transition-colors">West End Theatres</Link></li>
              <li><Link href="/west-end/discount-tickets" className="hover:text-white transition-colors">Discount Tickets</Link></li>
              <li><Link href="/west-end/best-value" className="hover:text-white transition-colors">Best Value</Link></li>
              <li><Link href="/west-end/lotteries" className="hover:text-white transition-colors">Lotteries</Link></li>
              <li><Link href="/west-end/rush" className="hover:text-white transition-colors">Rush &amp; Day Seats</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">Off-West End</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/off-west-end" className="hover:text-white transition-colors">All Off-West End</Link></li>
              <li><Link href="/browse/best-off-west-end-shows" className="hover:text-white transition-colors">Best Off-West End</Link></li>
              <li><Link href="/browse/best-off-west-end-musicals" className="hover:text-white transition-colors">Best OWE Musicals</Link></li>
              <li><Link href="/browse/best-off-west-end-plays" className="hover:text-white transition-colors">Best OWE Plays</Link></li>
              <li><Link href="/browse/upcoming-off-west-end-shows" className="hover:text-white transition-colors">Upcoming OWE</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">More</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/reviews" className="hover:text-white transition-colors">Reviews</Link></li>
              {featureFlags.criticPages && <li><Link href="/critics" className="hover:text-white transition-colors">Critics</Link></li>}
              {featureFlags.criticPages && <li><Link href="/critics/outlets" className="hover:text-white transition-colors">Outlets</Link></li>}
              <li><Link href="/olivier-awards" className="hover:text-white transition-colors">Olivier Awards</Link></li>
              <li><Link href="/west-end/methodology" className="hover:text-white transition-colors">How It Works</Link></li>
              <li><Link href="/" className="hover:text-white transition-colors">Broadway Shows</Link></li>
              <li><Link href="/about" className="hover:text-white transition-colors">About</Link></li>
              <li><Link href="/feedback" className="hover:text-white transition-colors">Feedback</Link></li>
            </ul>
          </div>
        </div>
      ) : (
        <div className={`grid grid-cols-2 ${featureFlags.discountTickets ? 'md:grid-cols-4' : 'md:grid-cols-3'} gap-8 mb-8 pb-8 border-b border-white/5`}>
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">By Category</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/browse/best-broadway-musicals" className="hover:text-white transition-colors">Best Musicals</Link></li>
              <li><Link href="/browse/best-broadway-dramas" className="hover:text-white transition-colors">Best Dramas</Link></li>
              <li><Link href="/browse/best-broadway-comedies" className="hover:text-white transition-colors">Comedies</Link></li>
              <li><Link href="/browse/best-broadway-revivals" className="hover:text-white transition-colors">Revivals</Link></li>
              <li><Link href="/browse/tony-winners-on-broadway" className="hover:text-white transition-colors">Tony Winning Shows</Link></li>
              <li><Link href="/browse/jukebox-musicals-on-broadway" className="hover:text-white transition-colors">Jukebox Musicals</Link></li>
              <li><Link href="/browse/best-recent-musicals" className="hover:text-white transition-colors">New Musicals</Link></li>
              <li><Link href="/browse/longest-running-broadway-shows" className="hover:text-white transition-colors">Longest-Running</Link></li>
            </ul>
          </div>
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">By Audience</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/browse/broadway-shows-for-kids" className="hover:text-white transition-colors">Shows for Kids</Link></li>
              <li><Link href="/browse/broadway-age-guide" className="hover:text-white transition-colors">Age Guide</Link></li>
              <li><Link href="/browse/broadway-shows-for-date-night" className="hover:text-white transition-colors">Date Night</Link></li>
              <li><Link href="/browse/broadway-shows-for-tourists" className="hover:text-white transition-colors">For Tourists</Link></li>
              <li><Link href="/browse/first-time-broadway" className="hover:text-white transition-colors">First-Timers</Link></li>
              <li><Link href="/browse/broadway-show-runtimes" className="hover:text-white transition-colors">Show Runtimes</Link></li>
              {!featureFlags.discountTickets && (
                <li><Link href="/browse/broadway-shows-closing-soon" className="hover:text-white transition-colors">Closing Soon</Link></li>
              )}
            </ul>
          </div>
          {featureFlags.discountTickets && (
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">Deals & Tickets</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/discount-tickets" className="hover:text-white transition-colors">All Discount Tickets</Link></li>
              <li><Link href="/best-value" className="hover:text-white transition-colors">Best Value Tickets</Link></li>
              <li><Link href="/lotteries" className="hover:text-white transition-colors">Lottery Tickets</Link></li>
              <li><Link href="/rush" className="hover:text-white transition-colors">Rush Tickets</Link></li>
              <li><Link href="/standing-room" className="hover:text-white transition-colors">Standing Room</Link></li>
              <li><Link href="/browse/broadway-shows-closing-soon" className="hover:text-white transition-colors">Closing Soon</Link></li>
            </ul>
          </div>
          )}
          <div>
            <h4 className="text-sm font-semibold text-white uppercase tracking-wide mb-3">More</h4>
            <ul className="space-y-2 text-sm text-gray-400">
              <li><Link href="/beat-the-critics" className="hover:text-white transition-colors">Beat the Critics</Link></li>
              {(featureFlags.tonyPredictions || featureFlags.tonyPeople) && <li><Link href="/tony-awards" className="hover:text-white transition-colors">Tony Awards</Link></li>}
              {featureFlags.goldLists && <li><Link href="/lists" className="hover:text-white transition-colors">Gold Lists</Link></li>}
              {featureFlags.boxOffice && <li><Link href="/box-office" className="hover:text-white transition-colors">Box Office Scorecard</Link></li>}
              {featureFlags.commercial && <li><Link href="/biz-buzz" className="hover:text-white transition-colors">Commercial Scorecard</Link></li>}
              <li><Link href="/trending" className="hover:text-white transition-colors">Trending Shows</Link></li>
              <li><Link href="/audience-buzz" className="hover:text-white transition-colors">AudienceGrade</Link></li>
              <li><Link href="/broadway-theaters-map" className="hover:text-white transition-colors">Theater Map</Link></li>
              <li><Link href="/reviews" className="hover:text-white transition-colors">Reviews</Link></li>
              <li><Link href="/guides" className="hover:text-white transition-colors">Guides</Link></li>
              {featureFlags.criticPages && <li><Link href="/critics" className="hover:text-white transition-colors">Critics</Link></li>}
              {featureFlags.criticPages && <li><Link href="/critics/outlets" className="hover:text-white transition-colors">Outlets</Link></li>}
              {featureFlags.creativePages && <li><Link href="/directors" className="hover:text-white transition-colors">Directors</Link></li>}
              {featureFlags.creativePages && <li><Link href="/playwrights" className="hover:text-white transition-colors">Playwrights</Link></li>}
              {featureFlags.creativePages && <li><Link href="/composers" className="hover:text-white transition-colors">Composers</Link></li>}
              {featureFlags.creativePages && <li><Link href="/lyricists" className="hover:text-white transition-colors">Lyricists</Link></li>}
              {featureFlags.castPages && <li><Link href="/cast" className="hover:text-white transition-colors">Cast</Link></li>}
              <li><Link href="/cast-changes" className="hover:text-white transition-colors">Cast Changes</Link></li>
              <li><Link href="/methodology" className="hover:text-white transition-colors">How It Works</Link></li>
            </ul>
          </div>
        </div>
      )}

      {/* Community Links */}
      <div className="mb-8 pb-8 border-b border-white/5 text-center">
        <p className="text-sm font-semibold text-white mb-3">Help improve {siteName}™</p>
        <div className="flex items-center justify-center gap-3">
          <Link
            href="/submit-review"
            className="px-5 py-2.5 text-sm font-semibold text-white border border-white/15 rounded-lg hover:bg-white/5 transition-colors"
          >
            Submit a Review
          </Link>
          <Link
            href="/feedback"
            className="px-5 py-2.5 text-sm font-semibold text-white border border-white/15 rounded-lg hover:bg-white/5 transition-colors"
          >
            Give Feedback
          </Link>
        </div>
      </div>
    </>
  );
}
