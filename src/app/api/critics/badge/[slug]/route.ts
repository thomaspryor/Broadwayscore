import { NextRequest } from 'next/server';
import { getCriticBySlug } from '@/lib/data-reviews';
import { getPublicCriticProfile } from '@/lib/critic-server';
import { SLUG_RE } from '@/lib/critic-claim';

export const runtime = 'nodejs';
export const revalidate = 3600;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));

/** Embeddable "My reviews on Broadway Scorecard" badge. Verified critics only; shows public numbers, nothing editable. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  if (!SLUG_RE.test(slug)) return new Response('Not found', { status: 404 });
  const [critic, profile] = [getCriticBySlug(slug), await getPublicCriticProfile(slug)];
  if (!critic || !profile) return new Response('Not found', { status: 404 });
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64" role="img" aria-label="${esc(`My reviews on Broadway Scorecard: ${critic.reviewCount} ${critic.reviewCount === 1 ? 'review' : 'reviews'}`)}">
<rect width="240" height="64" rx="8" fill="#0f0f14" stroke="#3a3a46"/>
<text x="16" y="26" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="13" font-weight="700" fill="#ffffff">My reviews on</text>
<text x="16" y="46" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="15" font-weight="700" fill="#d4a574">Broadway Scorecard</text>
<text x="224" y="38" text-anchor="end" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="22" font-weight="700" fill="#ffffff">${critic.reviewCount}</text>
<text x="224" y="52" text-anchor="end" font-family="-apple-system,Segoe UI,Roboto,sans-serif" font-size="10" fill="#9a9aa8">${critic.reviewCount === 1 ? 'review' : 'reviews'}</text>
</svg>`;
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=3600' } });
}
