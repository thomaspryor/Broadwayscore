import { NextResponse } from 'next/server';
import { claimsDisabled } from '@/lib/critic-claim';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/** Public: lets the claim prompt hide itself when CRITIC_CLAIMS_DISABLED=true. */
export async function GET() {
  return NextResponse.json({ claimsDisabled: claimsDisabled() }, { headers: { 'Cache-Control': 'no-store' } });
}
