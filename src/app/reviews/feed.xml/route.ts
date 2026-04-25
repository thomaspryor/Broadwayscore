import { getAllBlogReviews } from '@/lib/data-reviews-blog';
import { AUTHOR } from '@/config/author';

export const revalidate = 60;

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscorecard.com';

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export async function GET() {
  const reviews = await getAllBlogReviews();

  const items = reviews.map(r => {
    const url = `${BASE_URL}/reviews/${r.slug}`;
    const pubDate = new Date(r.publishDate + 'T12:00:00Z').toUTCString();
    return `    <item>
      <title>${escapeXml(r.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${pubDate}</pubDate>
      <description>${escapeXml(r.excerpt)}</description>
      <author>${escapeXml(AUTHOR.name)}</author>
    </item>`;
  });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>Broadway Scorecard Reviews</title>
    <link>${BASE_URL}/reviews</link>
    <description>Personal theater reviews by ${AUTHOR.name}, founder of Broadway Scorecard.</description>
    <language>en-us</language>
    <atom:link href="${BASE_URL}/reviews/feed.xml" rel="self" type="application/rss+xml" />
${items.join('\n')}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
    },
  });
}
