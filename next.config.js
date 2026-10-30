/** @type {import('next').NextConfig} */
const isGitHubPages = process.env.GITHUB_PAGES === 'true';

// BRO-5592: `vercel build` has no platform deployment ID before --prebuilt
// uploads. Next writes this custom ID into its routes manifest, which Vercel
// carries into the deployment so ?dpl= pins assets to the matching build.
// A fresh 32-character ID also distinguishes rebuilds of the same commit.
const deploymentId = process.env.NEXT_DEPLOYMENT_ID || process.env.VERCEL_DEPLOYMENT_ID ||
  (process.env.VERCEL === '1' ? require('node:crypto').randomBytes(16).toString('hex') : undefined);

// BRO-6197: prepare versions before next dev/build compiles any site data.
// The manifest also ships to ISR functions, where public/ is not on disk.
require('./scripts/lib/site-image-versions').writeSiteImageVersions();

// BRO-5007: inlined as a literal, so `process.env.HELD_BOX_OFFICE_BUILD === 'true'`
// folds at build time and a flag-off build never emits the held sections'
// chunks (a dynamic() import still emits its chunk even when nothing renders it).
// The held sections need commercial AND boxOfficeV2; commercial is always on
// since its release (BRO-6192), so boxOfficeV2 alone decides.
const builtFeatures = (process.env.NEXT_PUBLIC_FEATURES || '').split(',').map((s) => s.trim());
const heldBoxOfficeBuild = builtFeatures.includes('boxOfficeV2');

const nextConfig = {
  reactStrictMode: true,
  deploymentId,
  env: { HELD_BOX_OFFICE_BUILD: heldBoxOfficeBuild ? 'true' : 'false' },
  trailingSlash: false,
  // Type checking and ESLint run separately in test.yml.
  // Next 16 no longer runs ESLint during builds.
  typescript: { ignoreBuildErrors: true },
  ...(isGitHubPages && { basePath: '/Broadwayscore' }),
  images: {
    // remotePatterns is the allow-list for /_next/image, which is a PUBLIC,
    // unauthenticated endpoint (the OG route at src/app/show/[slug]/
    // opengraph-image.tsx self-calls it for WebP->JPEG conversion, so it is
    // live on prod — it is not dead config). Every entry here is a host whose
    // bytes an anonymous caller can push through the image optimizer.
    //
    // Host-only entries on MULTI-TENANT CDNs are therefore an open door:
    // res.cloudinary.com/<anyone's-cloud>/... and s3 buckets under
    // **.amazonaws.com are attacker-controllable, so a host-only entry lets
    // anyone feed arbitrary image bytes (e.g. the AVIF of
    // GHSA-2xp9-vwfh-vxw4) into sharp/libheif. Verified 2026-09-13:
    // /_next/image?url=https://res.cloudinary.com/demo/image/upload/f_avif/...
    // returned 200 through prod. Rule: shared CDN hosts MUST carry a pathname
    // restriction scoping them to our own account.
    //
    // In practice every show image is a same-origin /images/shows/* path
    // (2372 of 2373 shows with a hero/poster; the one exception is an
    // assets.playbill.com URL that was never in this list), so scoping these
    // costs nothing at render time. See BRO-3202.
    remotePatterns: [
      // Our Contentful space only (space id is the first path segment).
      { protocol: 'https', hostname: 'images.ctfassets.net', pathname: '/6pezt69ih962/**' },
    ],
    // Pin output negotiation to WebP (Next 14's default) so the optimizer
    // never ENCODES AVIF via libheif. This is the encode half only —
    // GHSA-2xp9-vwfh-vxw4 is about DECODING an AVIF input, which is closed
    // above by scoping remote input to our own Contentful space (plus
    // same-origin /images/**, which contains zero .avif files).
    formats: ['image/webp'],
  },
  // Next 15 moved this out of `experimental` (BRO-3203).
  // Prevent NFT from tracing large/irrelevant files into serverless functions.
  // Primary root cause fixed in data-tony-nominees.ts (replaced process.cwd()
  // dynamic paths with static require()). This is a belt-and-suspenders guard
  // for any future dynamic data/ access: exclude .git pack files, audit logs,
  // and other files that are never needed at serverless runtime.
  // BRO-5811: data-core.ts reads the coverage floor at module load. Its raw
  // inputs live under data/audit/ (excluded below, ~10MB), so runtime
  // re-renders (show/[slug] revalidate, OG dynamicParams) read this ~200KB
  // prebuild snapshot instead. Without it the floor silently fails open and
  // a held show's score appears. Checked post-build by
  // scripts/lib/check-coverage-floor-trace.js.
  outputFileTracingIncludes: {
    '**/*': ['data/coverage-floor-snapshot.json', 'data/site-image-versions.json'],
  },
  outputFileTracingExcludes: {
    '**/*': [
      'data/audit/**',
      'data/review-texts/**',
      // BRO-6277: show art (7k+ files, ~570MB with sm/ variants) is static
      // output only. A server module building an fs path from process.cwd()
      // once traced all of it into functions and broke every prod deploy
      // (2026-10-26, BRO-6305; tests/unit/trace-excludes-public.test.mjs).
      'public/images/**',
      // ~2400 cast files (~300MB total). Tony pages now consume cast data
      // via data/actor-slugs.json (generated at prebuild). If any code path
      // re-introduces a dynamic data/cast/${showId}.json read, NFT will try
      // to bundle the whole directory again — this exclude blocks that.
      'data/cast/**',
      // BRO-6310: getServerImageSrcSet() does fs.existsSync(cwd/public/<dynamic>),
      // which makes NFT bundle all of public/images (~640MB) into every page
      // function ("off-broadway" hit 792MB > 250MB, 11 failed deploys 2026-10-26).
      // Vercel serves public/ from the CDN; the existsSync only runs at build time.
      'public/images/**',
      'data/broadway.db',
      'data/llm-scoring-runs.json',
      'data/mezzanine-productions-raw.json',
    ],
  },
}

module.exports = nextConfig
