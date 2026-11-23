// BRO-8056 phase 2: the publisher's and the kill switch's revalidate call
// (plan 1.5 step 8 and Kill). POST with header x-show-refresh-secret; body
//   { slugs?: string[], home?: boolean, tag?: boolean }
// revalidates /show/<slug> and /show/<slug>/reviews.json for each slug, '/' when
// home is true, and the 'show-refresh' tag (every cached store read) when tag is
// true. 404 while SHOW_REFRESH_REVALIDATE_SECRET is unset, so it does nothing
// until the secret exists. The decision lives in show-refresh-revalidate.ts.
import { revalidatePath, revalidateTag } from 'next/cache';
import { NextResponse } from 'next/server';
import { planRevalidate, revalidateAuth } from '@/lib/show-refresh-revalidate';
import { SHOW_REFRESH_TAG } from '@/lib/show-refresh-core';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Secret first: an unauthorised caller never gets the body parsed.
  const denied = revalidateAuth(process.env.SHOW_REFRESH_REVALIDATE_SECRET, req.headers.get('x-show-refresh-secret'));
  if (denied) return NextResponse.json({ ok: false, error: denied.error }, { status: denied.status });
  let body: unknown = null;
  try { body = await req.json(); } catch { body = null; }
  const plan = planRevalidate({
    configuredSecret: process.env.SHOW_REFRESH_REVALIDATE_SECRET,
    givenSecret: req.headers.get('x-show-refresh-secret'),
    body,
  });
  if (!plan.ok) return NextResponse.json({ ok: false, error: plan.error }, { status: plan.status });
  if (plan.tag) revalidateTag(SHOW_REFRESH_TAG, { expire: 0 });
  for (const p of plan.paths) revalidatePath(p);
  return NextResponse.json({ ok: true, tag: plan.tag, paths: plan.paths }, { headers: { 'cache-control': 'no-store' } });
}
