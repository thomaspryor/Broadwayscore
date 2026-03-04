/** @type {import('next').NextConfig} */
const isGitHubPages = process.env.GITHUB_PAGES === 'true';

const nextConfig = {
  reactStrictMode: true,
  trailingSlash: false,
  ...(isGitHubPages && { basePath: '/Broadwayscore' }),
  images: {
    unoptimized: true,
  },
}

module.exports = nextConfig
