import Link from 'next/link';
import { getShowById, getTourStops } from '@/lib/data-core';
import type { ComputedShow } from '@/lib/data-core';
import { featureFlags } from '@/config/feature-flags';
import { hasReachedStage, isLondonMarket, isUkRegionalShow } from '@/lib/market-utils';
import { getTourParentLabel } from '@/lib/tour-display';

/**
 * Owner decision 2026-11-10 (BRO-7259): a Broadway page's top card carries no
 * "On tour" / "National tour" line. It was never approved on its own; the tour
 * reaches Broadway readers through Other Productions and the tours browse page.
 *
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

      {/* Regional trust line — keyed on category (renders even if the market flag is off,
          since the detail page is reachable directly). Explains why a non-Broadway show
          lives on Broadway Scorecard so first-time search arrivals don't bounce.
          When the tryout has a linked Broadway transfer (transferredTo), say so. */}
      {isRegional && isUkRegionalShow(show) && (() => {
        // A UK house's production can transfer too (detect-regional-transfers.js sets
        // transferredTo): link it, naming the market it went to (BRO-5103 retro).
        const transfer = show.transferredTo ? getShowById(show.transferredTo) : null;
        const where = !transfer ? ''
          : transfer.category === 'off-west-end' ? 'Off-West End'
          : isLondonMarket(transfer.category) ? 'the West End'
          : transfer.category === 'off-broadway' ? 'Off-Broadway'
          : 'Broadway';
        return (
          <p className="text-xs sm:text-sm mb-1 leading-relaxed text-emerald-300/90" data-testid="regional-trust-line">
            <span className="font-semibold">UK regional production</span>
            {transfer ? (
              <span className="text-gray-400">
                {hasReachedStage(transfer.status) ? `: this production transferred to ${where}. ` : `: this production is transferring to ${where}. `}
                <Link href={`/show/${transfer.slug}`} className="text-emerald-300 underline decoration-emerald-300/40 underline-offset-2 hover:text-emerald-200" data-testid="transfer-link">
                  See the {where.replace(/^the /, '')} production →
                </Link>
              </span>
            ) : (
              <span className="text-gray-400">: a major house outside London, tracked alongside the West End.</span>
            )}
          </p>
        );
      })()}

      {isRegional && !isUkRegionalShow(show) && (() => {
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
                  ? ': this tryout transferred to Broadway. '
                  : ': this tryout is transferring to Broadway. '}
                <Link href={`/show/${transfer.slug}`} className="text-emerald-300 underline decoration-emerald-300/40 underline-offset-2 hover:text-emerald-200" data-testid="transfer-link">
                  See the Broadway production →
                </Link>
              </span>
            ) : (
              <span className="text-gray-400">: tracked as a buzzy, well-reviewed show that could transfer to Broadway.</span>
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
              {': '}see how this show landed across all its pre-Broadway stops.{' '}
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
              {' '}–{' '}
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
    </>
  );
}
