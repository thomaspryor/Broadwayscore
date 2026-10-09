import Link from 'next/link';
import { getShowById, getTourStops, getToursOf } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/data-core';
import { featureFlags } from '@/config/feature-flags';
import { hasReachedStage } from '@/lib/market-utils';
import { getTourParentLabel, describeTourScores } from '@/lib/tour-display';
import { isTourScored } from '@/lib/tour-listing';
import { hasEnoughReviews, applyCoverageFloor } from '@/config/score-buckets';

/**
 * The lines under a show's header that say how it relates to other
 * productions: a national tour and its Broadway parent, a regional tryout and
 * its Broadway transfer, a multi-city tour and its stops. Server component.
 *
 * Rendered by both show-page headers (the legacy card in
 * src/app/show/[slug]/page.tsx and ShowHeroRedesign, which receives it as a
 * prop), so turning the redesign on does not drop these links (BRO-4525).
 */
export default function ShowTrustLines({ show }: { show: ComputedShow }) {
  const isRegional = show.category === 'regional';
  const isTour = show.category === 'tour';

  return (
    <>
      {/* National tour (BRO-4211): scored apart from the run it tours. The parent
          can be Broadway, Off-Broadway, a regional house or the West End, and a
          standalone tour has none (BRO-4931), so the wording follows its category. */}
      {isTour && (() => {
        const parent = show.tourOf ? getShowById(show.tourOf) : null;
        const parentMarket = parent ? getTourParentLabel(parent.category) : null;
        return (
          <p className="text-xs sm:text-sm mb-1 leading-relaxed text-sky-300/90" data-testid="tour-trust-line">
            <span className="text-gray-400">
              {parentMarket
                ? `Reviewed by critics in each city on the tour, scored separately from the ${parentMarket} run.`
                : 'Reviewed by critics in each city on the tour.'}
              {parent && (
                <>
                  {' '}
                  <Link href={`/show/${parent.slug}`} className="text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-200" data-testid="tour-of-link">
                    See the {parentMarket} production →
                  </Link>
                </>
              )}
            </span>
          </p>
        );
      })()}

      {/* Parent side (any market): its national tour(s). Empty while the tour flag is off. */}
      {!isTour && (() => {
        const tours = getToursOf(show);
        if (tours.length === 0) return null;
        return (
          <p className="text-xs sm:text-sm mb-1 leading-relaxed text-sky-300/90" data-testid="on-tour-line">
            {/* "On tour" only while one is running; a finished tour is "National tour". */}
            <span className="font-semibold">{tours.some(t => t.status === 'open' || t.status === 'previews') ? 'On tour' : 'National tour'}</span>
            <span className="text-gray-400">
              {(() => {
                // Same TBD gate as the tryout line: never show a score the tour's own page hides.
                const t = tours.length === 1 ? tours[0] : null;
                const tCount = t?.criticScore?.reviewCount || 0;
                const tT12 = (t?.criticScore?.tier1Count || 0) + (t?.criticScore?.tier2Count || 0);
                const tourHidden = !t || applyCoverageFloor(
                  !hasEnoughReviews(tCount, t.category, tT12, false) || t.status === 'previews' || t.status === 'upcoming',
                  { scorePublicSince: t.scorePublicSince, coverageState: t.cov?.state, coverageAcked: t.coverageAcked },
                );
                const tourScore = (!tourHidden && t?.criticScore?.score) ? Math.round(t.criticScore.score) : null;
                if (tourScore) {
                  return <>{' '}— critics {t?.status === 'open' || t?.status === 'previews' ? 'score' : 'scored'} the tour <span className="text-sky-300 font-semibold">{tourScore}/100</span>.{' '}</>;
                }
                // No tour has a score yet: its page exists for the dates, so
                // say reviews are on the way rather than promising a score.
                if (!tours.some(isTourScored)) {
                  return <>{' '}— {tours.length > 1 ? 'the national tours are' : 'the national tour is'} {tours.every(x => x.status === 'upcoming') ? 'announced' : 'on the road'}, with critic reviews coming in.{' '}</>;
                }
                return <>{' '}— {describeTourScores(tours.filter(isTourScored).length, tours.length)}.{' '}</>;
              })()}
              {tours.map((tour, i) => (
                <span key={tour.id}>
                  <Link href={`/show/${tour.slug}`} className="text-sky-300 underline decoration-sky-300/40 underline-offset-2 hover:text-sky-200" data-testid="on-tour-link">
                    {/* Descriptive anchor text for the tour page (BRO-4601 SEO). */}
                    {tours.length > 1 ? `${(tour.openingDate || tour.id.match(/(\d{4})$/)?.[1] || '').slice(0, 4)} national tour reviews →` : `${show.title} national tour reviews →`}
                  </Link>
                  {i < tours.length - 1 ? ' ' : ''}
                </span>
              ))}
            </span>
          </p>
        );
      })()}

      {/* Regional trust line — keyed on category (renders even if the market flag is off,
          since the detail page is reachable directly). Explains why a non-Broadway show
          lives on Broadway Scorecard so first-time search arrivals don't bounce.
          When the tryout has a linked Broadway transfer (transferredTo), say so. */}
      {isRegional && (() => {
        // A leg of a multi-venue tour doesn't carry transferredTo itself
        // (only the aggregate does) — fall back to the parent's link so
        // this line stays accurate instead of reading as untransferred.
        const parent = show.tourParent ? getShowById(show.tourParent) : null;
        const transferTargetId = show.transferredTo || parent?.transferredTo;
        const transfer = (featureFlags.regional && transferTargetId) ? getShowById(transferTargetId) : null;
        return (
          <p className="text-xs sm:text-sm mb-1 leading-relaxed text-emerald-300/90" data-testid="regional-trust-line">
            <span className="font-semibold">Regional production</span>
            {transfer ? (
              <span className="text-gray-400">
                {hasReachedStage(transfer.status)
                  ? ' — this tryout transferred to Broadway. '
                  : ' — this tryout is transferring to Broadway. '}
                <Link href={`/show/${transfer.slug}`} className="text-emerald-300 underline decoration-emerald-300/40 underline-offset-2 hover:text-emerald-200" data-testid="transfer-link">
                  See the Broadway production →
                </Link>
              </span>
            ) : (
              <span className="text-gray-400"> — tracked as a buzzy, well-reviewed show that could transfer to Broadway.</span>
            )}
          </p>
        );
      })()}

      {/* Leg of a multi-venue tour: point at the aggregate show that
          rolls this leg's reviews (and its siblings') into one score. */}
      {isRegional && show.tourParent && (() => {
        const tour = getShowById(show.tourParent);
        if (!tour) return null;
        return (
          <p className="text-xs sm:text-sm mb-1 leading-relaxed text-emerald-300/90" data-testid="tour-parent-line">
            <span className="font-semibold">Part of a national tour</span>
            <span className="text-gray-400">
              {' '}— see how this show landed across all its pre-Broadway stops.{' '}
              <Link href={`/show/${tour.slug}`} className="text-emerald-300 underline decoration-emerald-300/40 underline-offset-2 hover:text-emerald-200" data-testid="tour-parent-link">
                See the combined tour reviews →
              </Link>
            </span>
          </p>
        );
      })()}

      {/* Aggregate tour show: list the individual per-city legs whose
          reviews were rolled up into this combined score. */}
      {isRegional && !show.tourParent && (() => {
        const stops = getTourStops(show.id);
        if (stops.length === 0) return null;
        return (
          <p className="text-xs sm:text-sm mb-1 leading-relaxed text-emerald-300/90" data-testid="tour-stops-line">
            <span className="font-semibold">Tour stops</span>
            <span className="text-gray-400">
              {' '}—{' '}
              {stops.map((stop, i) => (
                <span key={stop.id}>
                  <Link href={`/show/${stop.slug}`} className="text-emerald-300 underline decoration-emerald-300/40 underline-offset-2 hover:text-emerald-200" data-testid="tour-stop-link">
                    {(stop.venue || '').split(',')[0]}
                  </Link>
                  {i < stops.length - 1 ? ', ' : '.'}
                </span>
              ))}
            </span>
          </p>
        );
      })()}

      {/* Broadway side of a regional→Broadway transfer pair: surface the
          tryout's critic score (often the only pre-Broadway signal). */}
      {!isRegional && featureFlags.regional && show.transferOf && (() => {
        const tryout = getShowById(show.transferOf);
        if (!tryout) return null;
        // A tryout can itself be an aggregate rolling up several
        // per-city legs (a national tour) — venue is a summary phrase
        // in that case, not a single theater, so don't truncate it
        // at the first comma the way a single-venue tryout's is.
        const tourStopCount = getTourStops(tryout.id).length;
        const tryoutVenue = tourStopCount > 0
          ? `its ${tourStopCount}-city national tour`
          : (tryout.venue || '').split(',')[0];
        // Same TBD gate as everywhere else — never broadcast a score the
        // tryout's own page would show as TBD. (ship-check P2)
        const tCount = tryout.criticScore?.reviewCount || 0;
        const tT12 = (tryout.criticScore?.tier1Count || 0) + (tryout.criticScore?.tier2Count || 0);
        const tryoutScore = (tryout.criticScore?.score && hasEnoughReviews(tCount, tryout.category, tT12, false))
          ? Math.round(tryout.criticScore.score) : null;
        return (
          <p className="text-xs sm:text-sm mb-1 leading-relaxed text-emerald-300/90" data-testid="tryout-link-line">
            <span className="font-semibold">Pre-Broadway tryout</span>
            <span className="text-gray-400">
              {' '}— critics first reviewed this show at {tryoutVenue}{tryoutScore ? <> (scored <span className="text-emerald-300 font-semibold">{tryoutScore}/100</span>)</> : null}.{' '}
              <Link href={`/show/${tryout.slug}`} className="text-emerald-300 underline decoration-emerald-300/40 underline-offset-2 hover:text-emerald-200" data-testid="transfer-link">
                See the tryout reviews →
              </Link>
            </span>
          </p>
        );
      })()}
    </>
  );
}
