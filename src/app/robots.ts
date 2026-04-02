import { MetadataRoute } from 'next';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

// Block indexing on Vercel preview/staging deployments
const isProduction = process.env.VERCEL_ENV === 'production' || !process.env.VERCEL_ENV;

export default function robots(): MetadataRoute.Robots {
  if (!isProduction) {
    return {
      rules: { userAgent: '*', disallow: '/' },
    };
  }

  return {
    rules: [
      // Search engines (ALLOWED — index us, but not BTC co-branded page)
      { userAgent: 'Googlebot', allow: '/', disallow: ['/beat-the-critics', '/status.html', '/opening-night-status.json'] },
      { userAgent: 'Bingbot', allow: '/', disallow: '/beat-the-critics' },
      { userAgent: 'Slurp', allow: '/', disallow: '/beat-the-critics' },
      { userAgent: 'DuckDuckBot', allow: '/', disallow: '/beat-the-critics' },
      // AI search bots (ALLOWED — shows us in AI search results with citations)
      { userAgent: 'OAI-SearchBot', allow: '/' },
      { userAgent: 'PerplexityBot', allow: '/' },
      // AI training crawlers (BLOCKED — prevent content from training AI models)
      { userAgent: 'GPTBot', disallow: '/' },
      { userAgent: 'Google-Extended', disallow: '/' },
      { userAgent: 'CCBot', disallow: '/' },
      { userAgent: 'anthropic-ai', disallow: '/' },
      { userAgent: 'ClaudeBot', disallow: '/' },
      { userAgent: 'Bytespider', disallow: '/' },
      { userAgent: 'Cohere-ai', disallow: '/' },
      { userAgent: 'Meta-ExternalAgent', disallow: '/' },
      // Default: allow everything else
      { userAgent: '*', allow: '/' },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
