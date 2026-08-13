'use client';

import Link from 'next/link';
import { featureFlags } from '@/config/feature-flags';
import { getMarketLabel } from '@/lib/market-utils';
import { getBroadwayDuration, getRunLength } from '@/lib/date-utils';
import { formatShowDate as formatDate } from '@/lib/show-date-line';
import { hasEnoughReviews } from '@/config/score-buckets';
import { hasEnoughAudienceReviews } from '@/lib/audience-grade-utils';
import VideoReviewsShelf from '@/components/VideoReviewsShelf';
import AudienceBuzzCard from '@/components/AudienceBuzzCard';
import AwardsCard from '@/components/AwardsCard';
import BoxOfficeStats from '@/components/BoxOfficeStats';
import BizBuzzCard from '@/components/BizBuzzCard';
import WhereItRanks from '@/components/show-page/WhereItRanks';
import ShowtimesCard from '@/components/ShowtimesCard';
import ShowFAQSection, { type ShowFAQ } from '@/components/show-page/ShowFAQSection';
import SocialPulseCard from '@/components/show-page/SocialPulseCard';
import TheaterScorecardCard from '@/components/TheaterScorecardCard';
import SeatingGuidanceCard from '@/components/SeatingGuidanceCard';
import LotteryRushCard from '@/components/LotteryRushCard';
import CastUpdatesCard from '@/components/CastUpdatesCard';
import CastSection from '@/components/CastSection';
import MiniShowCard from '@/components/show-cards/MiniShowCard';
import type { ShowCardShow } from '@/components/show-cards/types';
import RelatedShows from '@/components/RelatedShows';
import type { AudienceMarket } from '@/config/audience-sources';
import type {
  ComputedShowWithReviews,
  ShowAwards,
  ShowGrosses,
  ShowSchedule,
  ShowCastFile,
  Theater,
  ShowLotteryRush,
  ShowCastChanges,
  ShowCommercial,
  RecoupmentTrend,
  AudienceBuzzData,
} from '@/lib/data-types';
import type { VideoReview } from '@/lib/data-video-reviews';
import type { TicketLinkData } from '@/lib/ticket-utils';
import type { ShowRanks } from '@/lib/data-show-ranks';
import type { BoxOfficeHistoryStats } from '@/lib/data-grosses-history';
import type { ShowTonyInfo } from '@/lib/data-tony-noms';
import type { TodayTixShowtimeData } from '@/lib/data-showtimes';
import type { SocialPulsePayload } from '@/components/show-page/SocialPulseCard';

export interface ShowPageBelowFoldProps {
  // Narrowed to drop criticScore.reviews — this chunk (and WhereItRanks, which it
  // renders) only reads criticScore.{score,reviewCount,tier1Count,tier2Count}.
  // ReviewsList is the only consumer of the show's own review objects; passing
  // them here too tripled that array's serialized size in the RSC payload
  // (measured 117 review objects inlined on /show/hamilton for 39 real reviews).
  // Card #962, sibling of the #419 Theater Pick<> fix.
  show: ComputedShowWithReviews<never>;
  videoReviews: VideoReview[];
  audienceBuzz: AudienceBuzzData | undefined;
  audienceShowScoreUrl: string | undefined;
  audiencePlatformUrls: Record<string, string>;
  awards: ShowAwards | null;
  tonyNamesByCategory: Record<string, string[]> | null;
  grosses: ShowGrosses | null;
  weekEnding: string | null;
  boxOfficeHistory: BoxOfficeHistoryStats | null;
  commercial: ShowCommercial | undefined;
  recoupmentTrend: RecoupmentTrend;
  ranks: ShowRanks | null;
  ranksByFormat: ShowRanks | null;
  showSchedule: ShowSchedule | null;
  currentMonday: string;
  showtimeIds: TodayTixShowtimeData | undefined;
  sortedTicketLinks: TicketLinkData[];
  socialPulse: SocialPulsePayload | null;
  // Narrowed to the fields the two theater cards actually render. The full
  // Theater carries `allShows: ComputedShow[]` — every production ever staged at
  // the venue, each with its own criticScore.reviews — which this client boundary
  // would inline into the RSC payload (~135KB on /show/hamilton for the Richard
  // Rodgers' back catalogue, none of it rendered). Card #419.
  theater: Pick<Theater, 'name' | 'slug' | 'venueScores' | 'accessibility' | 'externalLinks' | 'structuredTips'> | undefined;
  lotteryRush: ShowLotteryRush | undefined;
  castChangesData: ShowCastChanges | undefined;
  castFile: ShowCastFile | null;
  castActorSlugs: Record<string, string>;
  castTonyMap: Record<string, ShowTonyInfo>;
  creativePrincipals: Array<{ name: string; role: string; link: string | null }>;
  // Card-shaped, not full ComputedShow: these cross the 'use client' boundary and
  // get serialized into the inlined RSC payload, so page.tsx runs them through
  // serializeShowForClient(). Widening these back to ComputedShow re-inlines every
  // related show's entire criticScore.reviews array (645KB on /show/hamilton, #419).
  otherProductions: ShowCardShow[];
  relatedShowsOpen: ShowCardShow[];
  relatedShowsClosed: ShowCardShow[];
  comparisons: { slug: string; otherSlug: string }[];
  venueSlug: string | null;
  isWestEnd: boolean;
  isOffBroadway: boolean;
  isOffWestEnd: boolean;
  isOpera: boolean;
  isRegional: boolean;
  isCuratedHistoricalShow: boolean;
  lastUpdated: string | null;
  score: number | undefined;
  /** Computed server-side by getShowFAQs() in page.tsx and passed down so the
      Q&A block can sit below Showtimes while staying 1:1 with faqSchema. */
  faqs: ShowFAQ[];
}

function getGoogleMapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function MapPinIcon() {
  return (
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

export default function ShowPageBelowFold({
  show,
  videoReviews,
  audienceBuzz,
  audienceShowScoreUrl,
  audiencePlatformUrls,
  awards,
  tonyNamesByCategory,
  grosses,
  weekEnding,
  boxOfficeHistory,
  commercial,
  recoupmentTrend,
  ranks,
  ranksByFormat,
  showSchedule,
  currentMonday,
  showtimeIds,
  sortedTicketLinks,
  socialPulse,
  theater,
  lotteryRush,
  castChangesData,
  castFile,
  castActorSlugs,
  castTonyMap,
  creativePrincipals,
  otherProductions,
  relatedShowsOpen,
  relatedShowsClosed,
  comparisons,
  venueSlug,
  isWestEnd,
  isOffBroadway,
  isOffWestEnd,
  isOpera,
  isRegional,
  isCuratedHistoricalShow,
  lastUpdated,
  score,
  faqs,
}: ShowPageBelowFoldProps) {
  return (
    <>
      {/* Video Reviews */}
      <div id="video-reviews" className="scroll-mt-20" />
      {featureFlags.videoReviews && videoReviews.length > 0 && (
        <VideoReviewsShelf reviews={videoReviews} />
      )}

      {/* Audience Scorecard */}
      <div id="audience" className="scroll-mt-20" />
      {/* Match the main show page's audience gate exactly (same helper) — a card
          built on <15 reviews (e.g. "100/Loving" from a single review) is
          misleading, so hide it rather than display a low-confidence grade. */}
      {audienceBuzz && audienceBuzz.combinedScore != null && hasEnoughAudienceReviews(audienceBuzz) ? (() => {
        const sourceCount = Object.values(audienceBuzz.sources || {}).filter(Boolean).length;
        const showYear = show.openingDate ? parseInt(show.openingDate.substring(0, 4)) : null;
        const isHistorical = show.status === 'closed' && showYear !== null && showYear < 2015;
        return (
          <AudienceBuzzCard
            buzz={audienceBuzz}
            showScoreUrl={audienceShowScoreUrl}
            limitedSources={isHistorical && sourceCount <= 1}
            market={(show.category as AudienceMarket) || 'broadway'}
            platformUrls={audiencePlatformUrls}
            ranks={ranks}
          />
        );
      })() : show.status === 'previews' || show.status === 'upcoming' ? (
        <section className="card p-5 sm:p-6 mb-6">
          <h2 className="text-lg font-bold text-white mb-3">Audience Grade</h2>
          <p className="text-gray-400 text-sm">Audience data will be added once the show opens and reviews come in.</p>
        </section>
      ) : show.status === 'closed' && (() => {
        const showYear = show.openingDate ? parseInt(show.openingDate.substring(0, 4)) : null;
        const isPreDigital = showYear !== null && showYear < 2015;
        return isPreDigital ? (
          <section className="card p-5 sm:p-6 mb-6">
            <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-3">Audience Grade</h2>
            <p className="text-sm text-gray-500">This show predates most audience rating platforms. Critic reviews only.</p>
          </section>
        ) : null;
      })()}

      {/* Awards Scorecard */}
      <div id="awards" className="scroll-mt-20" />
      {awards && <AwardsCard showId={show.id} awards={awards} openingDate={show.openingDate} tonyNamesByCategory={tonyNamesByCategory ?? undefined} />}

      {/* Box Office Scorecard — Broadway only (no public OB/WE gross data).
          NOTE: the approved mockup showed BO + Commercial side by side on
          desktop; tried and reverted — the show page's max-w-3xl (768px)
          column crushes both cards' stat tiles at 3/5 + 2/5 widths. Cards
          stay stacked, mockup order preserved (facts first, then model). */}
      <div id="box-office" className="scroll-mt-20" />
      {featureFlags.boxOffice && !isWestEnd && !isOffBroadway && (
        grosses && ((show.status !== 'previews' && show.status !== 'upcoming') || grosses.thisWeek) ? (
          <BoxOfficeStats grosses={grosses} weekEnding={weekEnding ?? ''} history={boxOfficeHistory} />
        ) : show.status === 'previews' || show.status === 'upcoming' ? (
          <section className="card p-5 sm:p-6 mb-6">
            <h2 className="text-lg font-bold text-white mb-3">Box Office</h2>
            <p className="text-gray-400 text-sm">Box office data starts one week after previews begin.</p>
          </section>
        ) : null
      )}

      {/* Commercial Scorecard — Broadway only */}
      <div id="commercial" className="scroll-mt-20" />
      {featureFlags.commercial && !isWestEnd && !isOffBroadway && (
        commercial ? (
          <BizBuzzCard
            commercial={commercial}
            showTitle={show.title}
            trend={recoupmentTrend}
            weeklyGross={grosses?.thisWeek?.gross}
            showStatus={show.status as 'open' | 'closed' | 'previews' | 'upcoming'}
            allTimeGross={grosses?.allTime?.gross}
          />
        ) : show.status === 'previews' || show.status === 'upcoming' ? (
          <section className="card p-5 sm:p-6 mb-6">
            <h2 className="text-lg font-bold text-white mb-3">Commercial Performance</h2>
            <p className="text-gray-400 text-sm">Financial data not available yet.</p>
          </section>
        ) : null
      )}

      {/* Where it ranks */}
      <div id="where-it-ranks" className="scroll-mt-20" />
      {featureFlags.showRanks && (ranks || ranksByFormat) && (
        <WhereItRanks ranks={ranks} ranksByFormat={ranksByFormat} show={show} />
      )}

      {/* Showtimes — all markets (Broadway via bwayrush, WE/OB via TodayTix) */}
      <div id="showtimes" className="scroll-mt-20" />
      {showSchedule &&
        (show.status === 'open' || show.status === 'previews' || show.status === 'upcoming') && (
        <ShowtimesCard
          schedule={showSchedule}
          currentMonday={currentMonday}
          showStatus={show.status}
          ticketLinks={sortedTicketLinks}
          todaytixShowtimes={showtimeIds}
          showName={show.title}
          showId={show.id}
          showSlug={show.slug}
          market={show.category}
          venue={show.venue}
        />
      )}

      {/* PAA-style Q&A block — sits below Showtimes per owner, 2026-08-02 (it
          used to render directly under the Critic Scorecard, which pushed the
          actual scorecards down the page). Component lives in its own module so
          the loader's ErrorBoundary can render it standalone when this chunk
          fails — see ShowFAQSection.tsx for why that matters. */}
      <ShowFAQSection faqs={faqs} />

      {/* Socials Scorecard — weekly X+TikTok+Instagram mention tiering */}
      <div id="social-buzz" className="scroll-mt-20" />
      <SocialPulseCard sp={socialPulse} />

      {/* Theater Scorecard */}
      <div id="theater-scorecard" className="scroll-mt-20" />
      {theater?.venueScores && (
        <TheaterScorecardCard
          venueScores={theater.venueScores}
          accessibility={theater.accessibility}
          externalLinks={theater.externalLinks}
          theaterName={theater.name}
          theaterSlug={theater.slug}
        />
      )}

      {/* Seating Scorecard — directly under Theater Scorecard */}
      <div id="seating-scorecard" className="scroll-mt-20" />
      {theater && (
        <SeatingGuidanceCard
          sections={theater.structuredTips?.seating?.sections}
          bestSeats={theater.structuredTips?.seating?.bestSeats}
          variant="show"
        />
      )}

      {/* Discount Tickets (Lottery / Rush / Standing Room) */}
      <div id="discount-tickets" className="scroll-mt-20" />
      {featureFlags.discountTickets && lotteryRush && (() => {
        if (show.previewsStartDate) {
          const previewsStart = new Date(show.previewsStartDate);
          const today = new Date();
          if (today < previewsStart) return null;
        }
        return <LotteryRushCard data={lotteryRush} showId={show.id} showName={show.title} showStatus={show.status} showCategory={show.category} showVenue={show.venue} />;
      })()}

      {/* Cast Updates */}
      <div id="cast-updates" className="scroll-mt-20" />
      {featureFlags.castChanges && castChangesData && (
        <CastUpdatesCard castChanges={castChangesData} showStatus={show.status} />
      )}

      {/* Cast — OBC and current cast from IBDB. Also renders an empty-state
          placeholder for open shows with no cast data (mostly OB/WE, which
          IBDB doesn't index) so the absence is explicit rather than silent.
          castFile is null when the manifest has no entries for the show. */}
      <div id="cast" className="scroll-mt-20" />
      {featureFlags.castPages && (() => {
        const isOpen = show.status === 'open' || show.status === 'previews' || show.status === 'upcoming';
        const hasAnyCast = !!castFile && (
          castFile.openingNightCast.length > 0 ||
          (castFile.currentCast && castFile.currentCast.length > 0) ||
          (castFile.replacements && castFile.replacements.length > 0)
        );
        if (!hasAnyCast && !isOpen) return null;
        return (
          <CastSection
            openingNightCast={castFile?.openingNightCast || []}
            currentCast={castFile?.currentCast}
            currentCastUpdatedAt={castFile?.currentCastUpdatedAt || null}
            replacements={castFile?.replacements}
            showStatus={show.status}
            openingDate={show.openingDate}
            category={show.category}
            actorSlugs={castActorSlugs}
            tonyMap={castTonyMap}
          />
        );
      })()}

      {/* Creative Team — principal roles only */}
      <div id="creative-team" className="scroll-mt-20" />
      {featureFlags.creativePages && creativePrincipals.length > 0 && (
        <div className="mb-8">
          <div className="card p-5 sm:p-6">
            <h2 className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0 mb-4">Creative Team</h2>
            <ul className="space-y-2.5 sm:space-y-2">
              {creativePrincipals.map((member, i) => (
                <li key={i} className="flex flex-col sm:flex-row sm:items-baseline text-sm gap-0.5 sm:gap-0">
                  {member.link ? (
                    <Link href={member.link} className="text-white font-medium hover:text-brand transition-colors">{member.name}</Link>
                  ) : (
                    <span className="text-white font-medium">{member.name}</span>
                  )}
                  <span className="text-gray-500 text-xs sm:text-sm sm:before:content-['·'] sm:before:mx-2 sm:before:text-gray-600">{member.role}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {/* Quick Facts - Structured data for users and AI systems */}
      <section className="card p-5 sm:p-6 mb-8" aria-labelledby="quick-facts-heading">
        <header className="mb-4">
          <h2 id="quick-facts-heading" className="text-[11px] font-bold uppercase tracking-[0.12em] text-gray-400 leading-none m-0">Quick Facts</h2>
        </header>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4 text-sm">
          {score && show.criticScore && hasEnoughReviews(show.criticScore.reviewCount, show.category, (show.criticScore.tier1Count || 0) + (show.criticScore.tier2Count || 0), isCuratedHistoricalShow) && (
            <div>
              <dt className="text-gray-500">CriticScore</dt>
              <dd className="text-white mt-0.5 font-semibold">{Math.round(score)}/100 <span className="font-normal text-gray-400">({show.criticScore.reviewCount} {show.criticScore.reviewCount === 1 ? 'review' : 'reviews'})</span></dd>
            </div>
          )}
          <div>
            <dt className="text-gray-500">Status</dt>
            <dd className="text-white mt-0.5">
              {show.status === 'open' ? 'Now Playing' : show.status === 'previews' ? 'In Previews' : show.status === 'upcoming' ? 'Upcoming' : 'Closed'}
            </dd>
          </div>
          <div>
            <dt className="text-gray-500">{show.status === 'previews' || show.status === 'upcoming' ? 'Opens' : 'Opened'}</dt>
            <dd className="text-white mt-0.5">{formatDate(show.openingDate)}</dd>
          </div>
          {show.previewsStartDate && (show.status === 'previews' || show.status === 'upcoming') && (
            <div>
              <dt className="text-gray-500">Previews Start</dt>
              <dd className="text-white mt-0.5">{formatDate(show.previewsStartDate)}</dd>
            </div>
          )}
          {show.closingDate && (
            <div>
              <dt className="text-gray-500">{show.status === 'closed' ? 'Closed' : 'Closes'}</dt>
              <dd className="text-white mt-0.5">{formatDate(show.closingDate)}</dd>
            </div>
          )}
          {show.status === 'closed' && (() => {
            const runLen = getRunLength(show.openingDate, show.closingDate, 'precise');
            return runLen ? (
              <div>
                <dt className="text-gray-500">Run Length</dt>
                <dd className="text-white mt-0.5">{runLen}</dd>
              </div>
            ) : null;
          })()}
          {show.status === 'open' && (() => {
            const durationSuffix = isOpera ? 'at the Met' : isOffWestEnd ? 'Off-West End' : isWestEnd ? 'in the West End' : isOffBroadway ? 'Off-Broadway' : isRegional ? 'in its regional run' : 'on Broadway';
            const dur = getBroadwayDuration(show.openingDate, durationSuffix);
            return dur ? (
              <div>
                <dt className="text-gray-500">Running</dt>
                <dd className="text-white mt-0.5">{dur}</dd>
              </div>
            ) : null;
          })()}
          <div>
            <dt className="text-gray-500">Runtime</dt>
            <dd className="text-white mt-0.5">{show.runtime}</dd>
          </div>
          {show.intermissions !== undefined && show.intermissions !== null && (
            <div>
              <dt className="text-gray-500">Intermissions</dt>
              <dd className="text-white mt-0.5">{show.intermissions}</dd>
            </div>
          )}
          {show.ageRecommendation && (
            <div>
              <dt className="text-gray-500">Age</dt>
              <dd className="text-white mt-0.5">{show.ageRecommendation}</dd>
            </div>
          )}
          <div className="sm:col-span-2">
            <dt className="text-gray-500">{isWestEnd ? 'Theatre' : 'Theater'}</dt>
            <dd className="text-white mt-0.5">
              {isWestEnd ? (
                <Link href={`/west-end/theater/${venueSlug}`} className="hover:text-brand transition-colors">{show.venue}</Link>
              ) : isOffBroadway ? (
                <span>{show.venue}</span>
              ) : (
                <Link href={`/theater/${venueSlug}`} className="hover:text-brand transition-colors">{show.venue}</Link>
              )}
              {show.theaterAddress && (
                <>
                  {' — '}
                  <a
                    href={getGoogleMapsUrl(show.theaterAddress)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-gray-400 hover:text-brand transition-colors"
                  >
                    <MapPinIcon />
                    {show.theaterAddress}
                  </a>
                </>
              )}
            </dd>
          </div>
          {show.synopsis && (
            <div className="sm:col-span-2 pt-2 mt-2 border-t border-white/5">
              <dt className="text-gray-500">Synopsis</dt>
              <dd className="text-gray-300 mt-1 leading-relaxed">{show.synopsis}</dd>
            </div>
          )}
          {lastUpdated && (
            <div className="sm:col-span-2 pt-2 mt-2 border-t border-white/5">
              <dt className="text-gray-500">Data Last Updated</dt>
              <dd className="text-gray-400 mt-0.5 text-xs">
                {new Date(lastUpdated).toLocaleDateString('en-US', {
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric'
                })}
              </dd>
            </div>
          )}
        </dl>
      </section>

      {/* Other Productions of the same show */}
      {otherProductions.length > 0 && (
        <section className="mt-8 pt-6 border-t border-white/5">
          <h2 className="text-base font-bold text-white mb-3">Other Productions of {show.title}</h2>
          <div className="flex gap-3 overflow-x-auto pb-3 -mx-4 px-4 sm:mx-0 sm:px-0 scrollbar-hide">
            {otherProductions.map(prod => {
              const openYear = prod.openingDate ? new Date(prod.openingDate + 'T12:00:00').getFullYear() : null;
              const closeYear = prod.closingDate ? new Date(prod.closingDate + 'T12:00:00').getFullYear() : null;
              const yearRange = openYear
                ? closeYear && closeYear !== openYear
                  ? `${openYear}–${String(closeYear).slice(-2)}`
                  : String(openYear)
                : null;
              const market = getMarketLabel(prod.category ?? 'broadway');
              const subtitle = [market, yearRange].filter(Boolean).join(' · ');
              const subtitleColor = prod.status === 'open' || prod.status === 'previews' ? 'text-emerald-400' : 'text-gray-400';
              return (
                <MiniShowCard
                  key={prod.id}
                  show={{ ...prod, subtitle, subtitleColor }}
                />
              );
            })}
          </div>
        </section>
      )}

      {/* Related Shows */}
      <RelatedShows shows={relatedShowsOpen} title="Open Shows You Might Like" />
      {!isWestEnd && (
        <RelatedShows shows={relatedShowsClosed} title="Closed Shows You Might Like" />
      )}

      {/* Compare This Show */}
      {comparisons.length > 0 && (
        <div className="mt-4 text-sm text-gray-400">
          <span className="text-gray-500">Compare: </span>
          {comparisons.slice(0, 6).map((comp, i) => (
            <span key={comp.slug}>
              {i > 0 && <span className="text-gray-600"> · </span>}
              <Link href={`/compare/${comp.slug}`} className="text-gray-400 hover:text-white transition-colors">
                vs {comp.otherSlug.replace(/-\d{4}$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}
              </Link>
            </span>
          ))}
        </div>
      )}

      {/* Page-bottom methodology link */}
      <p className="mt-8 text-center text-xs text-gray-500">
        <Link href="/methodology" className="hover:text-brand-hover transition-colors">
          Learn how our scores work →
        </Link>
      </p>
    </>
  );
}
