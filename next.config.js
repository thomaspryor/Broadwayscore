/** @type {import('next').NextConfig} */
const isGitHubPages = process.env.GITHUB_PAGES === 'true';

const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  trailingSlash: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Only use basePath for GitHub Pages, not for Vercel
  ...(isGitHubPages && { basePath: '/Broadwayscore' }),
  images: {
    unoptimized: true,
  },
}

module.exports = nextConfig
