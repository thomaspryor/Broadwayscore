import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { detectFromReview } from '@/lib/admin-ingest-detect';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * POST /api/admin/ingest-review/detect
 *
 * Body: { url: string, fullText: string }
 * Returns detected fields for the ingest form preview:
 *   - outletId + outletDisplayName (via data/outlet-registry.json domain lookup)
 *   - criticName (byline regex on first 3000 chars)
 *   - publishDate (YYYY/MM/DD extraction from URL path)
 *   - showId + showTitle + showCandidates (substring match in shows.json)
 *   - warnings array for fields that need manual input
 *
 * Does NOT commit anything. Called by the form on paste/blur to populate the preview.
 * The actual commit goes through /api/admin/ingest-review.
 */
export async function POST(request: NextRequest) {
  if (!isAdmin()) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  let body: { url?: string; fullText?: string };
  try {
    body = (await request.json()) as { url?: string; fullText?: string };
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const url = typeof body.url === 'string' ? body.url.trim() : '';
  const fullText = typeof body.fullText === 'string' ? body.fullText : '';

  if (!url && !fullText) {
    return NextResponse.json({ error: 'url or fullText required' }, { status: 400 });
  }
  if (url) {
    try {
      new URL(url);
    } catch {
      return NextResponse.json({ error: 'url is not a valid URL' }, { status: 400 });
    }
  }

  try {
    const result = detectFromReview({ url, fullText });
    return NextResponse.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: `Detection failed: ${msg}` }, { status: 500 });
  }
}
