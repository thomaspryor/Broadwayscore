import { SITEMAP_SHARDS, type ShardName } from '@/config/sitemap-shards';
import { getDataFreshness } from '@/lib/data-core';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

// Map each shard to the data source whose freshness dominates its URLs.
// Crawlers use <lastmod> to prioritize re-crawl — a single site-wide timestamp
// wastes crawl budget because reviews-driven shards rarely change relative
// to shows/core. Per-shard lastmod reflects actual change cadence.
function getShardLastmod(name: ShardName, showsDate: string, reviewsDate: string): string {
  switch (name) {
    case 'critics':
    case 'creatives':
      return reviewsDate;
    case 'shows':
    case 'theaters':
    case 'actors-ah':
    case 'actors-iq':
    case 'actors-rz':
      return showsDate;
    case 'core':
    default:
      return new Date(Math.max(new Date(showsDate).getTime(), new Date(reviewsDate).getTime())).toISOString();
  }
}

export function GET() {
  const freshness = getDataFreshness();
  const showsDate = new Date(freshness.showsLastUpdated).toISOString();
  const reviewsDate = new Date(freshness.reviewsLastUpdated).toISOString();

  const entries = SITEMAP_SHARDS.map((shard, i) => {
    const lastmod = getShardLastmod(shard.name, showsDate, reviewsDate);
    return `  <sitemap>\n    <loc>${BASE_URL}/sitemap/${i}.xml</loc>\n    <lastmod>${lastmod}</lastmod>\n  </sitemap>`;
  }).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    },
  });
}
