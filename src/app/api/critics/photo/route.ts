import { NextRequest, NextResponse } from 'next/server';
import { revalidatePath, revalidateTag } from 'next/cache';
import { SLUG_RE } from '@/lib/critic-claim';
import { criticBackendReady, getRequestUser, approvedClaimFor, sbAdmin, CRITIC_PHOTO_BUCKET } from '@/lib/critic-server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const MAX_BYTES = 1_000_000;

/** Upload the profile photo (the editor re-encodes to a small JPEG first). */
export async function POST(req: NextRequest) {
  if (!criticBackendReady()) return NextResponse.json({ error: 'Not available right now.' }, { status: 503 });
  const user = await getRequestUser(req);
  if (!user) return NextResponse.json({ error: 'Please sign in.' }, { status: 401 });
  const form = await req.formData().catch(() => null);
  const slug = String(form?.get('slug') || '');
  const file = form?.get('photo');
  if (!SLUG_RE.test(slug) || !(file instanceof File)) return NextResponse.json({ error: 'Bad request.' }, { status: 400 });
  if (!(await approvedClaimFor(user.id, slug))) return NextResponse.json({ error: 'This page is not linked to your account.' }, { status: 403 });
  if (file.size > MAX_BYTES) return NextResponse.json({ error: 'Photo is too large.' }, { status: 413 });
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!(bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)) return NextResponse.json({ error: 'Photo must be a JPEG.' }, { status: 415 });

  const path = `${slug}/${Date.now()}.jpg`;
  const up = await fetch(`${process.env.NEXT_PUBLIC_SUPABASE_URL}/storage/v1/object/${CRITIC_PHOTO_BUCKET}/${path}`, {
    method: 'POST',
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=31536000' },
    body: bytes,
    signal: AbortSignal.timeout(15000),
  });
  if (!up.ok) return NextResponse.json({ error: 'Upload failed. Please try again.' }, { status: 502 });
  const patch = await sbAdmin(`/rest/v1/critic_profiles?critic_slug=eq.${slug}&user_id=eq.${user.id}`, { method: 'PATCH', prefer: 'return=minimal', body: JSON.stringify({ photo_path: path, updated_at: new Date().toISOString() }) });
  if (!patch.ok) return NextResponse.json({ error: 'Could not save. Please try again.' }, { status: 502 });
  revalidateTag(`critic-profile:${slug}`, { expire: 0 });
  revalidatePath(`/critics/${slug}`);
  return NextResponse.json({ ok: true });
}
