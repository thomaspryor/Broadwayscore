import { SITEMAP_SHARDS } from '@/config/sitemap-shards';
import { getDataFreshness } from '@/lib/data-core';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

export function GET() {
  const freshness = getDataFreshness();
  const lastmod = new Date(
    Math.max(
      new Date(freshness.showsLastUpdated).getTime(),
      new Date(freshness.reviewsLastUpdated).getTime()
    )
  ).toISOString();

  const entries = SITEMAP_SHARDS.map((_, i) =>
    `  <sitemap>\n    <loc>${BASE_URL}/sitemap/${i}.xml</loc>\n    <lastmod>${lastmod}</lastmod>\n  </sitemap>`
  ).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries}\n</sitemapindex>\n`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, must-revalidate',
    },
  });
}
