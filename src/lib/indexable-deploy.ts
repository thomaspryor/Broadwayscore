// Whether this build is the production site, the only host search engines may
// index. Preview and demo builds (VERCEL_ENV=preview) must say noindex in BOTH
// robots.txt (src/app/robots.ts) and the <meta name="robots"> tag (layout.tsx):
// until BRO-5007 the meta tag said "index, follow" on hosts robots.txt blocked.
// Read per call, not at module load, so tests can flip VERCEL_ENV.
import type { Metadata } from 'next';

export function isIndexableDeploy(): boolean {
  return process.env.VERCEL_ENV === 'production' || !process.env.VERCEL_ENV;
}

/** Site-wide robots metadata. Pages should inherit it, not set `index: true`. */
export function siteRobots(): NonNullable<Metadata['robots']> {
  return isIndexableDeploy()
    ? { index: true, follow: true }
    : { index: false, follow: false };
}
