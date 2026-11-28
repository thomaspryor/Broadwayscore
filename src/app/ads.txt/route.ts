// ads.txt: authorizes Google AdSense to sell ads for our publisher id
// (BRO-5893). See https://iabtechlab.com/ads-txt/

import { ADS_TXT_LINE } from '@/lib/ads';

export async function GET() {
  return new Response(`${ADS_TXT_LINE}\n`, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
    },
  });
}

// Required for static export
export const dynamic = 'force-static';
