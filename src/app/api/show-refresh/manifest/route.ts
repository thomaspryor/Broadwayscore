// BRO-8214: the build manifest this deployment was built with, for the
// show-refresh publisher (scripts/publish-show-refresh.ts --manifest default).
// Static: the manifest is fixed per build, so the body is baked at build time
// and changes only with a new deployment. No store reads, no secrets.
// A missing or unusable manifest answers { usable: false } with 200 (a static
// route cannot bake a 503); the publisher re-checks isUsableManifest itself.
import { NextResponse } from 'next/server';
import { buildManifest } from '@/lib/show-refresh';

/* eslint-disable-next-line @typescript-eslint/no-require-imports */
const { isUsableManifest } = require('../../../../../scripts/lib/show-refresh/manifest') as { isUsableManifest(m: unknown): boolean };

export const dynamic = 'force-static';

export function GET() {
  const m = buildManifest();
  const body = isUsableManifest(m) ? m : { usable: false };
  return NextResponse.json(body, { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
