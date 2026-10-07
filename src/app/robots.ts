import { MetadataRoute } from 'next';
import { SITEMAP_SHARDS } from '@/config/sitemap-shards';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

// API routes are POST-only handlers, webhooks and admin actions — nothing a
// crawler should ever fetch. GET on a POST-only route returns 405, which GSC
// reports as "Blocked due to other 4xx issue" (fired 2026-08-11 for
// /api/submit-review, discovered from the endpoint prop rendered into
// /submit-review's HTML). Disallowing the whole prefix kills the class rather
// than the one URL. /api/badge/ stays crawlable: it serves real SVG badges
// embedded on third-party sites, and a longer Allow beats a shorter Disallow
// under RFC 9309 longest-match.
//
// Every crawlable agent shares this allow/disallow pair, so it lives in one
// object that each rule spreads — the same "derive, don't repeat" shape the
// sitemap list uses below. Adding an agent without the /api/ block is the
// mistake tests/unit/robots-api-disallow.test.ts exists to catch.
const CRAWLABLE_SURFACE = {
  allow: ['/', '/api/badge/'],
  disallow: ['/admin/', '/api/'],
};

export default function robots(): MetadataRoute.Robots {
  // Block indexing on Vercel preview/staging deployments. Read per call, not at
  // module load, so the branch is reachable in tests.
  const isProduction = process.env.VERCEL_ENV === 'production' || !process.env.VERCEL_ENV;

  if (!isProduction) {
    return {
      rules: { userAgent: '*', disallow: '/' },
    };
  }

  return {
    rules: [
      // Search engines (ALLOWED — index us, not admin/internal pages)
      {
        ...CRAWLABLE_SURFACE,
        userAgent: 'Googlebot',
        disallow: [...CRAWLABLE_SURFACE.disallow, '/status.html', '/opening-night-status.json'],
      },
      { ...CRAWLABLE_SURFACE, userAgent: 'Bingbot' },
      { ...CRAWLABLE_SURFACE, userAgent: 'Slurp' },
      { ...CRAWLABLE_SURFACE, userAgent: 'DuckDuckBot' },
      // AI search bots (ALLOWED — shows us in AI search results with citations)
      { ...CRAWLABLE_SURFACE, userAgent: 'OAI-SearchBot' },
      { ...CRAWLABLE_SURFACE, userAgent: 'PerplexityBot' },
      // Anthropic splits retrieval from training (support.claude.com article
      // 8896518): Claude-SearchBot (search indexing) + Claude-User (fetches for
      // a user's question) power citations; ClaudeBot is the TRAINING crawler.
      // Owner decision 2026-07-19: be citable in Claude answers, keep training
      // blocked — so allow the two retrieval agents, keep ClaudeBot below.
      { ...CRAWLABLE_SURFACE, userAgent: 'Claude-SearchBot' },
      { ...CRAWLABLE_SURFACE, userAgent: 'Claude-User' },
      // CCBot: allowed 2026-07-19 (owner decision, eyes open) — Common Crawl is
      // a public archive that trainers also ingest, but it's how the domain
      // enters the CC authority graph and smaller AI search tools' indexes.
      { ...CRAWLABLE_SURFACE, userAgent: 'CCBot' },
      // AI training crawlers (BLOCKED — prevent direct training scrapes)
      { userAgent: 'GPTBot', disallow: '/' },
      { userAgent: 'Google-Extended', disallow: '/' },
      { userAgent: 'anthropic-ai', disallow: '/' },
      { userAgent: 'ClaudeBot', disallow: '/' },
      { userAgent: 'Bytespider', disallow: '/' },
      { userAgent: 'Cohere-ai', disallow: '/' },
      { userAgent: 'Meta-ExternalAgent', disallow: '/' },
      // Default: allow everything else (except admin surface)
      { ...CRAWLABLE_SURFACE, userAgent: '*' },
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
