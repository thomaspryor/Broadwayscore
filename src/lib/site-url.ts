/**
 * The public site origin, safe to import from client components (no other
 * imports). Use it for links people share: building them from
 * `window.location.origin` mints demo.broadwayscorecard.com links when the
 * owner shares from the demo site (BRO-4481). The demo build also resolves
 * this to https://broadwayscorecard.com (its canonical URLs already do).
 */
export const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';
