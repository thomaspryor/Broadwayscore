import { getBroadwayShows } from '@/lib/data-core';
import { getAllGuideSlugs, GUIDE_PAGES } from '@/config/guide-pages';
import { getAllBrowseSlugs, getBrowsePageConfig } from '@/config/browse-pages';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function GET() {
  const now = new Date();
  const items: string[] = [];

  // Recent show pages (opened in last 6 months, sorted by opening date)
  const shows = getBroadwayShows();
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);

  const recentShows = shows
    .filter(s => (s.status === 'open' || s.status === 'previews') && s.openingDate && new Date(s.openingDate) >= sixMonthsAgo)
    .sort((a, b) => new Date(b.openingDate).getTime() - new Date(a.openingDate).getTime())
    .slice(0, 20);

  for (const show of recentShows) {
    const scoreText = show.criticScore?.score
      ? ` CriticScore: ${Math.round(show.criticScore.score)}/100 from ${show.criticScore.reviewCount} reviews.`
      : '';
    items.push(`
    <item>
      <title>${escapeXml(show.title)} — Broadway Scorecard</title>
      <link>${BASE_URL}/show/${show.slug}</link>
      <guid isPermaLink="true">${BASE_URL}/show/${show.slug}</guid>
      <description>${escapeXml(`${show.title} reviews and CriticScore on Broadway Scorecard.${scoreText} ${show.synopsis || ''}`.trim())}</description>
      <pubDate>${new Date(show.openingDate).toUTCString()}</pubDate>
      <category>Shows</category>
    </item>`);
  }

  // Guide pages
  const guideSlugs = getAllGuideSlugs();
  for (const slug of guideSlugs.slice(0, 15)) {
    const config = GUIDE_PAGES[slug];
    if (!config) continue;
    items.push(`
    <item>
      <title>${escapeXml(config.title)} | Broadway Scorecard</title>
      <link>${BASE_URL}/guides/${slug}</link>
      <guid isPermaLink="true">${BASE_URL}/guides/${slug}</guid>
      <description>${escapeXml(config.introFallback.replace(/\{[^}]+\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 300))}</description>
      <pubDate>${now.toUTCString()}</pubDate>
      <category>Guides</category>
    </item>`);
  }

  // Browse pages (curated selection)
  const browseFeatured = [
    'best-recent-shows', 'best-recent-musicals', 'broadway-show-runtimes',
    'broadway-age-guide', 'broadway-shows-closing-soon', 'broadway-ticket-prices',
    'most-divisive-broadway-shows', 'longest-running-broadway-shows',
  ];
  for (const slug of browseFeatured) {
    const config = getBrowsePageConfig(slug);
    if (!config) continue;
    items.push(`
    <item>
      <title>${escapeXml(config.title)} | Broadway Scorecard</title>
      <link>${BASE_URL}/browse/${slug}</link>
      <guid isPermaLink="true">${BASE_URL}/browse/${slug}</guid>
      <description>${escapeXml(config.metaDescription)}</description>
      <pubDate>${now.toUTCString()}</pubDate>
      <category>Browse</category>
    </item>`);
  }

  // Static guide pages
  const staticGuides = [
    { slug: 'what-to-wear-to-broadway', title: 'What to Wear to Broadway', desc: 'Broadway dress code guide — what most people wear, what to avoid, and tips for every occasion.' },
    { slug: 'broadway-first-timer-guide', title: 'Going to Broadway for the First Time', desc: 'Everything you need to know before your first Broadway show — when to arrive, what to expect, and theater etiquette.' },
    { slug: 'off-broadway-vs-broadway', title: 'Off-Broadway vs Broadway', desc: 'The real difference between Broadway and Off-Broadway — theater size, ticket prices, and which is right for you.' },
    { slug: 'cheap-broadway-tickets', title: 'How to Get Cheap Broadway Tickets', desc: 'TKTS, lotteries, rush tickets, and every strategy for affordable Broadway tickets.' },
  ];
  for (const guide of staticGuides) {
    items.push(`
    <item>
      <title>${escapeXml(guide.title)} | Broadway Scorecard</title>
      <link>${BASE_URL}/guides/${guide.slug}</link>
      <guid isPermaLink="true">${BASE_URL}/guides/${guide.slug}</guid>
      <description>${escapeXml(guide.desc)}</description>
      <pubDate>${now.toUTCString()}</pubDate>
      <category>Guides</category>
    </item>`);
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Broadway Scorecard</title>
    <link>${BASE_URL}</link>
    <description>Aggregated critic reviews and CriticScore ratings for every Broadway, Off-Broadway, and West End show. Like Rotten Tomatoes for theater.</description>
    <language>en-us</language>
    <lastBuildDate>${now.toUTCString()}</lastBuildDate>
    <atom:link href="${BASE_URL}/rss.xml" rel="self" type="application/rss+xml" />
    <image>
      <url>${BASE_URL}/og/home.png</url>
      <title>Broadway Scorecard</title>
      <link>${BASE_URL}</link>
    </image>${items.join('')}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}
