import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { isAdmin } from '@/lib/admin-auth';
import { createRequire } from 'module';

const nodeRequire = createRequire(import.meta.url);
// scripts/lib/review-count-probe.js is the same library the cron uses
// (scripts/check-opening-night-drift.js). Reusing it keeps API + CLI + cron
// in perfect agreement on how each stage is counted. See the script's header
// for the 4-stage model.
const {
  countAggregate,
  fetchLiveRc,
  countLocalPerShowJson,
  computeDrift,
} = nodeRequire('../../../../../scripts/lib/review-count-probe') as {
  countAggregate: (showId: string, reviewsDoc: unknown) => number;
  fetchLiveRc: (showId: string) => Promise<{ rc: number | null; err: string | null }>;
  countLocalPerShowJson: (
    showId: string,
    publicDataRoot?: string,
  ) => { rc: number | null; reviewsArrayLength: number } | null;
  computeDrift: (counts: {
    local: number;
    aggregate: number;
    localJson?: number | null;
    live?: number | null;
  }) => { min: number; max: number; drift: number };
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Health endpoint for phone-friendly monitoring of review-count drift across
 * pipeline stages.
 *
 * Covers 3 of 4 stages (stage 1 requires the private review-texts repo, which
 * only the CI cron in check-opening-night-drift.yml has access to):
 *   - stage 2: aggregate — data/reviews.json filtered by showId
 *   - stage 3: localJson — public/data/shows/{id}.json (rc + rv length)
 *   - stage 4: live — production CDN fetch of the same per-show JSON
 *
 * Query params:
 *   ?window=N    — days ± around openingDate (default 7)
 *   ?show=ID     — single show (overrides window)
 *   ?threshold=N — drift threshold for alerting status (default 2)
 *   ?format=html — phone-friendly HTML table (default JSON)
 *
 * Returns the matrix so operators can eyeball drift without opening a laptop.
 * For the full 4-stage check (including scoreable-review-texts on the private
 * repo), see the CLI/cron: scripts/check-opening-night-drift.js.
 */

interface ShowRecord {
  id: string;
  title?: string;
  openingDate?: string | null;
}

interface ReviewsDoc {
  reviews?: unknown[];
}

interface CacheEntry<T> {
  data: T;
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
let reviewsCache: CacheEntry<ReviewsDoc> | null = null;
let showsCache: CacheEntry<ShowRecord[]> | null = null;

function loadJson<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T;
}

function loadReviewsDoc(): ReviewsDoc | null {
  if (reviewsCache && reviewsCache.expiresAt > Date.now()) return reviewsCache.data;
  const p = path.join(process.cwd(), 'data', 'reviews.json');
  if (!fs.existsSync(p)) return null;
  try {
    const doc = loadJson<ReviewsDoc>(p);
    reviewsCache = { data: doc, expiresAt: Date.now() + CACHE_TTL_MS };
    return doc;
  } catch {
    return null;
  }
}

function loadShows(): ShowRecord[] {
  if (showsCache && showsCache.expiresAt > Date.now()) return showsCache.data;
  const p = path.join(process.cwd(), 'data', 'shows.json');
  const raw = loadJson<ShowRecord[] | { shows: ShowRecord[] }>(p);
  const shows = Array.isArray(raw) ? raw : raw.shows || [];
  showsCache = { data: shows, expiresAt: Date.now() + CACHE_TTL_MS };
  return shows;
}

function pickTargetShows(
  shows: ShowRecord[],
  specificShow: string | null,
  windowDays: number,
): ShowRecord[] {
  if (specificShow) {
    const match = shows.find((s) => s.id === specificShow);
    return match ? [match] : [];
  }
  const now = Date.now();
  const windowMs = windowDays * 24 * 60 * 60 * 1000;
  return shows.filter((s) => {
    if (!s.openingDate) return false;
    const opening = new Date(s.openingDate).getTime();
    if (isNaN(opening)) return false;
    return Math.abs(now - opening) <= windowMs;
  });
}

function classify(drift: number, threshold: number): 'ok' | 'watching' | 'alerting' {
  if (drift <= threshold) return 'ok';
  if (drift <= threshold * 2) return 'watching';
  return 'alerting';
}

interface ShowResult {
  showId: string;
  title: string;
  openingDate: string | null;
  counts: {
    local: null;
    aggregate: number;
    localJson: number | null;
    live: number | null;
  };
  drift: number;
  status: 'ok' | 'watching' | 'alerting';
  liveErr: string | null;
}

async function probeShow(
  show: ShowRecord,
  reviewsDoc: ReviewsDoc | null,
  threshold: number,
): Promise<ShowResult> {
  const aggregate = reviewsDoc ? countAggregate(show.id, reviewsDoc) : 0;
  const localJsonRec = countLocalPerShowJson(
    show.id,
    path.join(process.cwd(), 'public', 'data', 'shows'),
  );
  const localJson = localJsonRec ? localJsonRec.reviewsArrayLength : null;
  const liveResult = await fetchLiveRc(show.id);
  const live = liveResult.rc;
  const drift = computeDrift({ local: aggregate, aggregate, localJson, live }).drift;
  // computeDrift needs a `local` value; we don't have scoreable-review-texts
  // in Vercel runtime (private repo), so pass aggregate as the floor. Drift
  // over [aggregate, localJson, live] is what this endpoint detects.
  return {
    showId: show.id,
    title: show.title || show.id,
    openingDate: show.openingDate ?? null,
    counts: { local: null, aggregate, localJson, live },
    drift,
    status: classify(drift, threshold),
    liveErr: liveResult.err,
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderHtml(body: {
  generated: string;
  window: number;
  threshold: number;
  summary: { total: number; ok: number; watching: number; alerting: number };
  shows: ShowResult[];
  reviewsJsonAvailable: boolean;
}): string {
  const statusColor: Record<ShowResult['status'], string> = {
    ok: '#22c55e',
    watching: '#d97706',
    alerting: '#ef4444',
  };
  const rows = body.shows
    .map((r) => {
      const live = r.counts.live != null ? String(r.counts.live) : `err(${r.liveErr ?? 'n/a'})`;
      const localJson = r.counts.localJson != null ? String(r.counts.localJson) : 'n/a';
      return `<tr>
        <td style="padding:6px 8px"><strong>${escapeHtml(r.title)}</strong><br/><small style="color:#9ca3af">${escapeHtml(r.showId)}</small></td>
        <td style="padding:6px 8px;color:#9ca3af">${escapeHtml(r.openingDate ?? '?')}</td>
        <td style="padding:6px 8px;text-align:right">${r.counts.aggregate}</td>
        <td style="padding:6px 8px;text-align:right">${localJson}</td>
        <td style="padding:6px 8px;text-align:right">${live}</td>
        <td style="padding:6px 8px;text-align:right;font-weight:bold">${r.drift}</td>
        <td style="padding:6px 8px;color:${statusColor[r.status]};font-weight:bold">${r.status}</td>
      </tr>`;
    })
    .join('\n');
  const reviewsWarning = body.reviewsJsonAvailable
    ? ''
    : `<p style="color:#d97706"><strong>Note:</strong> data/reviews.json not readable from this deploy — aggregate column shows 0 for all shows.</p>`;
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Drift — Opening Window</title>
<style>
  body { font: 14px/1.4 -apple-system, system-ui, sans-serif; margin: 16px; background:#0f0f14; color:#e5e7eb; }
  h1 { font-size: 18px; margin: 0 0 8px; }
  .meta { color: #9ca3af; font-size: 12px; margin-bottom: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th { text-align: left; padding: 6px 8px; color: #9ca3af; border-bottom: 1px solid #374151; }
  tr:not(:last-child) td { border-bottom: 1px solid #1f2937; }
  .summary { display: flex; gap: 12px; margin: 8px 0 16px; flex-wrap: wrap; }
  .pill { padding: 4px 10px; border-radius: 6px; font-size: 12px; background: #1f2937; }
  .pill.alert { background: #7f1d1d; }
  .pill.warn { background: #78350f; }
  .pill.ok { background: #14532d; }
  footer { color:#6b7280; font-size:11px; margin-top:16px; }
  code { background:#1f2937; padding:1px 4px; border-radius:3px; }
</style>
</head>
<body>
<h1>Drift — Opening Window (±${body.window}d)</h1>
<div class="meta">Generated ${escapeHtml(body.generated)} · threshold=${body.threshold}</div>
${reviewsWarning}
<div class="summary">
  <span class="pill">Total: ${body.summary.total}</span>
  <span class="pill ok">OK: ${body.summary.ok}</span>
  <span class="pill warn">Watching: ${body.summary.watching}</span>
  <span class="pill alert">Alerting: ${body.summary.alerting}</span>
</div>
<table>
  <thead>
    <tr>
      <th>Show</th><th>Opening</th><th>Agg</th><th>Local JSON</th><th>Live</th><th>Drift</th><th>Status</th>
    </tr>
  </thead>
  <tbody>
    ${rows || '<tr><td colspan="7" style="padding:12px;color:#9ca3af">No shows in window</td></tr>'}
  </tbody>
</table>
<footer>
  <p>Covers stages 2-4. Stage 1 (scoreable review-texts, private repo) only visible via <code>scripts/check-opening-night-drift.js</code> cron.</p>
  <p>Fix drift: <code>node scripts/verify-review-recovery.js --show=SHOW_ID --production</code></p>
</footer>
</body>
</html>`;
}

export async function GET(request: NextRequest) {
  if (!isAdmin()) {
    return new NextResponse(null, { status: 404 });
  }

  const { searchParams } = new URL(request.url);
  const window = Math.max(0, Math.min(365, parseInt(searchParams.get('window') || '7', 10) || 7));
  const threshold = Math.max(0, Math.min(100, parseInt(searchParams.get('threshold') || '2', 10) || 2));
  const specificShow = searchParams.get('show');
  const format = searchParams.get('format') === 'html' ? 'html' : 'json';

  let shows: ShowRecord[];
  try {
    shows = loadShows();
  } catch (err) {
    return NextResponse.json(
      { error: 'shows.json unreadable', detail: String(err) },
      { status: 500 },
    );
  }

  const reviewsDoc = loadReviewsDoc();
  const targetShows = pickTargetShows(shows, specificShow, window);

  const results: ShowResult[] = await Promise.all(
    targetShows.map((s) => probeShow(s, reviewsDoc, threshold)),
  );

  // Sort by drift desc so the most alarming rows surface first on phone.
  results.sort((a, b) => b.drift - a.drift);

  const summary = {
    total: results.length,
    ok: results.filter((r) => r.status === 'ok').length,
    watching: results.filter((r) => r.status === 'watching').length,
    alerting: results.filter((r) => r.status === 'alerting').length,
  };

  const body = {
    generated: new Date().toISOString(),
    window,
    threshold,
    summary,
    shows: results,
    reviewsJsonAvailable: reviewsDoc != null,
  };

  if (format === 'html') {
    return new NextResponse(renderHtml(body), {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Robots-Tag': 'noindex',
      },
    });
  }

  return NextResponse.json(body, {
    headers: { 'Cache-Control': 'no-store' },
  });
}
