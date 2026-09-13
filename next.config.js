/** @type {import('next').NextConfig} */
const isGitHubPages = process.env.GITHUB_PAGES === 'true';

const nextConfig = {
  reactStrictMode: true,
  trailingSlash: false,
  // Skip in-build lint+type-check; they run separately in
  // .github/workflows/test.yml (typescript-check job: tsc + next lint).
  // Keeps these gates in CI but removes ~20-40s from every deploy build.
  // If you re-enable these flags, remove the corresponding steps from test.yml.
  eslint: { ignoreDuringBuilds: true },
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
  experimental: {
    // Prevent NFT from tracing large/irrelevant files into serverless functions.
    // Primary root cause fixed in data-tony-nominees.ts (replaced process.cwd()
    // dynamic paths with static require()). This is a belt-and-suspenders guard
    // for any future dynamic data/ access: exclude .git pack files, audit logs,
    // and other files that are never needed at serverless runtime.
    outputFileTracingExcludes: {
      '**/*': [
        'data/audit/**',
        'data/review-texts/**',
        // ~2400 cast files (~300MB total). Tony pages now consume cast data
        // via data/actor-slugs.json (generated at prebuild). If any code path
        // re-introduces a dynamic data/cast/${showId}.json read, NFT will try
        // to bundle the whole directory again — this exclude blocks that.
        'data/cast/**',
        'data/broadway.db',
        'data/llm-scoring-runs.json',
        'data/mezzanine-productions-raw.json',
      ],
    },
  },
}

module.exports = nextConfig
