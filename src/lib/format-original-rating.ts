// Implementation lives in scripts/lib so the mobile-feed generator
// (scripts/generate-mobile-show-details.js) shares it with the web UI.
import { formatOriginalRating as impl } from '../../scripts/lib/format-original-rating';

export const formatOriginalRating: (raw: unknown) => string | null = impl;
