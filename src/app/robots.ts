import { MetadataRoute } from 'next';

const BASE_URL = process.env.NEXT_PUBLIC_SITE_URL || 'https://broadwayscore.com';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
      },
      {
        userAgent: 'GPTBot',
        allow: '/', // Allow AI crawlers to index for potential AI-powered recommendations
      },
    ],
    sitemap: `${BASE_URL}/sitemap.xml`,
  };
}
