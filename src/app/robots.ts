import { MetadataRoute } from 'next';
import { SITEMAP_SHARDS } from '@/config/sitemap-shards';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

// Block indexing on Vercel preview/staging deployments
const isProduction = process.env.VERCEL_ENV === 'production' || !process.env.VERCEL_ENV;

// API routes are POST-only handlers, webhooks and admin actions — nothing a
// crawler should ever fetch. GET on a POST-only route returns 405, which GSC
// reports as "Blocked due to other 4xx issue" (fired 2026-08-11 for
// /api/submit-review, discovered from the endpoint prop rendered into
// /submit-review's HTML). Disallowing the whole prefix kills the class rather
// than the one URL. /api/badge/ stays crawlable: it serves real SVG badges
// embedded on third-party sites.
const API_DISALLOW = '/api/';
const API_ALLOW = '/api/badge/';

export default function robots(): MetadataRoute.Robots {
  if (!isProduction) {
    return {
      rules: { userAgent: '*', disallow: '/' },
    };
  }

  return {
    rules: [
      // Search engines (ALLOWED — index us, not admin/internal pages)
      {
        userAgent: 'Googlebot',
        allow: ['/', API_ALLOW],
        disallow: ['/status.html', '/opening-night-status.json', '/admin/', API_DISALLOW],
      },
      { userAgent: 'Bingbot', allow: ['/', API_ALLOW], disallow: ['/admin/', API_DISALLOW] },
      { userAgent: 'Slurp', allow: ['/', API_ALLOW], disallow: ['/admin/', API_DISALLOW] },
      { userAgent: 'DuckDuckBot', allow: ['/', API_ALLOW], disallow: ['/admin/', API_DISALLOW] },
      // AI search bots (ALLOWED — shows us in AI search results with citations)
      { userAgent: 'OAI-SearchBot', allow: ['/', API_ALLOW], disallow: ['/admin/', API_DISALLOW] },
      { userAgent: 'PerplexityBot', allow: ['/', API_ALLOW], disallow: ['/admin/', API_DISALLOW] },
      // Anthropic splits retrieval from training (support.claude.com article
      // 8896518): Claude-SearchBot (search indexing) + Claude-User (fetches for
      // a user's question) power citations; ClaudeBot is the TRAINING crawler.
      // Owner decision 2026-07-19: be citable in Claude answers, keep training
      // blocked — so allow the two retrieval agents, keep ClaudeBot below.
      { userAgent: 'Claude-SearchBot', allow: ['/', API_ALLOW], disallow: ['/admin/', API_DISALLOW] },
      { userAgent: 'Claude-User', allow: ['/', API_ALLOW], disallow: ['/admin/', API_DISALLOW] },
      // CCBot: allowed 2026-07-19 (owner decision, eyes open) — Common Crawl is
      // a public archive that trainers also ingest, but it's how the domain
      // enters the CC authority graph and smaller AI search tools' indexes.
      { userAgent: 'CCBot', allow: ['/', API_ALLOW], disallow: ['/admin/', API_DISALLOW] },
      // AI training crawlers (BLOCKED — prevent direct training scrapes)
      { userAgent: 'GPTBot', disallow: '/' },
      { userAgent: 'Google-Extended', disallow: '/' },
      { userAgent: 'anthropic-ai', disallow: '/' },
      { userAgent: 'ClaudeBot', disallow: '/' },
      { userAgent: 'Bytespider', disallow: '/' },
      { userAgent: 'Cohere-ai', disallow: '/' },
      { userAgent: 'Meta-ExternalAgent', disallow: '/' },
      // Default: allow everything else (except admin surface)
      { userAgent: '*', allow: ['/', API_ALLOW], disallow: ['/admin/', API_DISALLOW] },
    ],
    // The sitemap is sharded via generateSitemaps() in src/app/sitemap.ts, which
    // emits /sitemap/0.xml … /sitemap/N.xml. Next.js does NOT auto-generate a
    // /sitemap.xml index for static export, so referencing /sitemap.xml here used
    // to point Google at the 404 page (GSC: errors:1, contents:None since
    // 2026-04-16). List every shard directly so all are discovered. Derived from
    // SITEMAP_SHARDS so adding a shard updates robots.txt automatically.
    sitemap: SITEMAP_SHARDS.map((_, i) => `${BASE_URL}/sitemap/${i}.xml`),
  };
}
