import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';
import { fetchPrivateJson } from '@/lib/private-data-repo';
// Pure P&L rollup shared with scripts (same server-only pattern as
// affiliate-stats — keeps the module out of the Next.js client bundle graph).
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { computeFinanceStats } = require('../../../../../scripts/lib/finance-stats') as {
  computeFinanceStats: (opts: {
    expenses: unknown[];
    revenue: unknown[];
    monthsBack?: number;
  }) => Record<string, unknown>;
};

/**
 * Admin finance dashboard JSON API.
 *
 * GET /api/admin/finance-stats?months=12[&refresh=1]
 *
 * - Auth-gated via admin_token cookie (isAdmin → plain 404, same as affiliate)
 * - Ledgers live in the PRIVATE repo thomaspryor/broadway-scorecard-data under
 *   data/finances/ (billing PII — never in this repo / the build). Read here at
 *   runtime via the GitHub contents API with REVIEW_TEXTS_TOKEN, mirroring
 *   /api/admin/ingest-review. A missing ledger file is treated as empty, not an
 *   error, so the dashboard works before the first ingest run.
 * - Module-level cache, 5-minute TTL, keyed on months; ?refresh=1 busts it.
 */

export const dynamic = 'force-dynamic';

interface CachedEntry {
  data: unknown;
  expiresAt: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
const cache = new Map<number, CachedEntry>();

export async function GET(request: NextRequest) {
  if (!isAdmin()) {
    return new NextResponse(null, { status: 404 });
  }

  const token = process.env.REVIEW_TEXTS_TOKEN;
  if (!token) {
    return NextResponse.json({ error: 'REVIEW_TEXTS_TOKEN not configured on server' }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const months = Math.min(Math.max(parseInt(searchParams.get('months') || '12', 10) || 12, 1), 24);
  const refresh = searchParams.get('refresh') === '1';

  if (refresh) {
    cache.delete(months);
  } else {
    const hit = cache.get(months);
    if (hit && hit.expiresAt > Date.now()) {
      return NextResponse.json({ ...(hit.data as object), cached: true });
    }
  }

  try {
    const [expenses, revenue, reviewQueue] = await Promise.all([
      fetchPrivateJson<unknown[]>('data/finances/expense-ledger.json', token, []),
      fetchPrivateJson<unknown[]>('data/finances/revenue-ledger.json', token, []),
      fetchPrivateJson<unknown[]>('data/finances/review-queue.json', token, []),
    ]);

    const stats = computeFinanceStats({ expenses, revenue, monthsBack: months });

    // Row-level detail for the dashboard's month drill-down. Slimmed to what
    // the UI renders — no raw email subjects/receipt numbers leave the server.
    type Row = { date?: string; vendor?: string; category?: string; kind?: string; amountBusiness?: number; amountUsd?: number; excluded?: boolean; excludedReason?: string };
    const rows = (expenses as Row[])
      .map((e) => ({
        date: e.date,
        vendor: e.vendor,
        category: e.category,
        kind: e.kind,
        amount: e.amountBusiness != null ? e.amountBusiness : e.amountUsd,
        excluded: !!e.excluded,
        excludedReason: e.excludedReason,
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));

    // Review-queue preview (admin-only page; senders/subjects are served at
    // request time from the private repo, never bundled or committed here).
    type QueueItem = { date?: string; from?: string; subject?: string; reason?: string };
    const queuePreview = (reviewQueue as QueueItem[])
      .slice()
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, 50)
      .map((q) => ({ date: String(q.date || '').slice(0, 10), from: q.from, subject: q.subject, reason: q.reason }));

    const payload = {
      ...stats,
      rows,
      queuePreview,
      ledgerCounts: { expenses: expenses.length, revenue: revenue.length },
      reviewQueueCount: reviewQueue.length,
      updatedAt: new Date().toISOString(),
    };
    cache.set(months, { data: payload, expiresAt: Date.now() + CACHE_TTL_MS });
    return NextResponse.json({ ...payload, cached: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
