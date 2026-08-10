import { NextRequest } from 'next/server';
import { buildIcs, decodeEventParams } from '@/lib/calendar';

/**
 * GET /api/calendar.ics?<event params> → a downloadable calendar file.
 *
 * Served rather than built client-side as a Blob: a Blob download of a .ics is
 * historically flaky on iOS Safari, whereas a real text/calendar response
 * reliably opens the native "add to calendar" sheet.
 *
 * GATING. This route CANNOT use featureFlags.calendarExport. `isDemo()` reads
 * `window` and returns false during SSR by design (src/config/feature-flags.ts),
 * and CI forbids referencing demo flags from server code — so a client flag here
 * would evaluate to false-but-unenforced and the route would in practice be open
 * to anyone in production the day it merged. It gates on a server-readable env
 * var instead. Set CALENDAR_EXPORT_ENABLED=1 in the environments where the
 * feature is live; everywhere else this 404s as though it did not exist.
 */

// Node runtime, not edge: nothing here needs edge, and the OG route next door
// is edge-only precisely because it cannot use CommonJS imports.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function disabled() {
  // 404 rather than 403 — an unlaunched feature should not advertise itself.
  return new Response('Not found', { status: 404 });
}

export async function GET(request: NextRequest) {
  if (process.env.CALENDAR_EXPORT_ENABLED !== '1') return disabled();

  const ev = decodeEventParams(request.nextUrl.searchParams);
  // decodeEventParams validates and fails closed. Serving a file built from a
  // half-parsed date writes a wrong-day event into somebody's real calendar,
  // which is materially worse than returning a 400.
  if (!ev) {
    return new Response('Invalid or incomplete event parameters', {
      status: 400,
      headers: { 'Cache-Control': 'no-store' },
    });
  }

  const ics = buildIcs(ev, { generatedAt: Date.now() });

  // Filename drives what the OS calls the event file; keep it boring and safe.
  const safeName = ev.showId.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60) || 'performance';

  return new Response(ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': `attachment; filename="${safeName}.ics"`,
      // Same params always produce the same file apart from DTSTAMP/SEQUENCE,
      // so let shared caches hold it briefly without pinning a stale event.
      'Cache-Control': 'public, max-age=300',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
