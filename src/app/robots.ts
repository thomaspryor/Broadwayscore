import { MetadataRoute } from 'next';
import { SITEMAP_SHARDS } from '@/config/sitemap-shards';

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
      // Search engines (ALLOWED — index us, not admin/internal pages)
      { userAgent: 'Googlebot', allow: '/', disallow: ['/status.html', '/opening-night-status.json', '/admin/'] },
      { userAgent: 'Bingbot', allow: '/', disallow: ['/admin/'] },
      { userAgent: 'Slurp', allow: '/', disallow: ['/admin/'] },
      { userAgent: 'DuckDuckBot', allow: '/', disallow: ['/admin/'] },
      // AI search bots (ALLOWED — shows us in AI search results with citations)
      { userAgent: 'OAI-SearchBot', allow: '/', disallow: '/admin/' },
      { userAgent: 'PerplexityBot', allow: '/', disallow: '/admin/' },
      // Anthropic splits retrieval from training (support.claude.com article
      // 8896518): Claude-SearchBot (search indexing) + Claude-User (fetches for
      // a user's question) power citations; ClaudeBot is the TRAINING crawler.
      // Owner decision 2026-07-19: be citable in Claude answers, keep training
      // blocked — so allow the two retrieval agents, keep ClaudeBot below.
      { userAgent: 'Claude-SearchBot', allow: '/', disallow: '/admin/' },
      { userAgent: 'Claude-User', allow: '/', disallow: '/admin/' },
      // CCBot: allowed 2026-07-19 (owner decision, eyes open) — Common Crawl is
      // a public archive that trainers also ingest, but it's how the domain
      // enters the CC authority graph and smaller AI search tools' indexes.
      { userAgent: 'CCBot', allow: '/', disallow: '/admin/' },
      // AI training crawlers (BLOCKED — prevent direct training scrapes)
      { userAgent: 'GPTBot', disallow: '/' },
      { userAgent: 'Google-Extended', disallow: '/' },
      { userAgent: 'anthropic-ai', disallow: '/' },
      { userAgent: 'ClaudeBot', disallow: '/' },
      { userAgent: 'Bytespider', disallow: '/' },
      { userAgent: 'Cohere-ai', disallow: '/' },
      { userAgent: 'Meta-ExternalAgent', disallow: '/' },
      // Default: allow everything else (except admin surface)
      { userAgent: '*', allow: '/', disallow: '/admin/' },
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
