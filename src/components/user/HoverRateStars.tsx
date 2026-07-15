'use client';

import { useRouter } from 'next/navigation';
import { useAuth } from '@/contexts/AuthContext';
import { useMyRating } from '@/hooks/useMyRating';
import StarRating from './StarRating';
import { featureFlags } from '@/config/feature-flags';

interface HoverRateStarsProps {
  showId: string;
  /** Show page URL — the click deep-links to `?rate=1&stars=N`. */
  showHref: string;
  /** 'xs' (default) for card thumbnails; 'sm' for the large show-page poster. */
  starSize?: 'xs' | 'sm';
  /** Already ON the show page? Handle the pick directly instead of deep-linking —
   *  the page's ?rate=1 params are read once at mount, so a same-page push is a no-op. */
  onPick?: (stars: number) => void;
  /** Extra classes on the strip (e.g. rounded-b-xl to follow a poster's corners). */
  className?: string;
}

/**
 * Empty five-star strip that appears over the BOTTOM of a poster/thumbnail on
 * card hover — click-to-rate straight from browse (owner request, 2026-07-13).
 *
 * Reuses the To-Be-Rated deep-link flow (`?rate=1&stars=N`) rather than saving
 * inline: the show page's RatingEditor owns sanitising, auth-gating for anon
 * users, and watchlist-removal side effects. Hidden when the user already
 * rated the show (the ★ chip owns that state) and on mobile (no hover).
 *
 * Place inside a `relative` container that carries the card's `group` class.
 */
export default function HoverRateStars({ showId, showHref, starSize = 'xs', className = '', onPick }: HoverRateStarsProps) {
  const router = useRouter();
  const { user } = useAuth();
  const myRating = useMyRating(user?.id || null, showId);

  if (!featureFlags.userAccounts) return null;
  if (myRating !== null) return null;

  return (
    <div
      // focus-within is load-bearing for a11y: the five star buttons are
      // tabbable, so keyboard focus must reveal the strip — otherwise the
      // focus ring lands on an invisible (opacity-0) control.
      className={`absolute inset-x-0 bottom-0 z-[2] hidden sm:flex justify-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity bg-gradient-to-t from-black/85 to-transparent pt-4 ${starSize === 'sm' ? 'pb-2' : 'pb-1'} ${className}`}
      // A star click must deep-link, not follow the wrapping card <Link>:
      // the child's router.push runs first, then this bubble-phase
      // preventDefault cancels the anchor's default navigation.
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      <StarRating
        rating={null}
        onRatingChange={(rating) => onPick ? onPick(rating) : router.push(`${showHref}?rate=1&stars=${rating}`)}
        size={starSize}
        expandHitTarget
        hideLabel
      />
    </div>
  );
}
