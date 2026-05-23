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
    remotePatterns: [
      { protocol: 'https', hostname: 'images.ctfassets.net' },
      { protocol: 'https', hostname: 'res.cloudinary.com' },
      { protocol: 'https', hostname: '**.amazonaws.com' },
    ],
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
        'data/broadway.db',
        'data/llm-scoring-runs.json',
        'data/mezzanine-productions-raw.json',
      ],
    },
  },
}

module.exports = nextConfig
