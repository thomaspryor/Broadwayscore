/**
 * Phone "Tap to rate" star row on the show page hero (BRO-7074).
 *
 * 'hidden'  - no row, and the Rate it button stays as it was.
 * 'pending' - the row's space is reserved but invisible and untappable, because
 *             we do not yet know whether this viewer has already rated the show.
 *             Without it, a signed-in viewer who already rated saw the row flash
 *             in and vanish when their ratings loaded, and a tap in that window
 *             opened a "new rating" editor.
 * 'visible' - tappable row; the Rate it button yields to it on phones.
 */
export type MobileStarRowState = 'hidden' | 'pending' | 'visible';

export interface MobileStarRowInput {
  /** The show could have been seen by this viewer, or they already rated it. */
  showRateButton: boolean;
  /** The signed-in viewer has at least one saved rating for this show. */
  hasRating: boolean;
  /** A signed-out viewer has a rating saved on this device for this show. */
  hasLocalRating: boolean;
  /** Auth has settled and, when signed in, the viewer's ratings have loaded. */
  ratingStateKnown: boolean;
}

export function getMobileStarRowState(input: MobileStarRowInput): MobileStarRowState {
  if (!input.showRateButton) return 'hidden';
  if (!input.ratingStateKnown) return 'pending';
  if (input.hasRating || input.hasLocalRating) return 'hidden';
  return 'visible';
}
