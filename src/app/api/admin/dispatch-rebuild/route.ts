import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PUBLIC_REPO_OWNER = 'thomaspryor';
const PUBLIC_REPO_NAME = 'Broadwayscore';
const REBUILD_WORKFLOW = 'rebuild-fast.yml';
const SCORING_WORKFLOW = 'llm-ensemble-score.yml';

const GH_API_BASE = 'https://api.github.com';

interface DispatchRebuildBody {
  reason?: string;
  // 'rebuild' (default): dispatch rebuild-fast.yml directly. Use when every
  //   file in the batch already has humanReviewScore or an extractor-populated
  //   originalScore (i.e. every /ingest call returned needsScoring=false).
  // 'score-then-rebuild': dispatch llm-ensemble-score.yml with show_id +
  //   fast_rebuild=true. Use when ANY file in the batch has fullText only
  //   (needsScoring=true) — without this path, unscored files commit
  //   successfully but never render on the live page (Lost Boys 2026-04-26
  //   Issue #5; ship-check 2026-04-27 P0).
  mode?: 'rebuild' | 'score-then-rebuild';
  // Required when mode='score-then-rebuild'. The scoring workflow needs the
  // show slug to filter its targeted scoring run.
  show_id?: string;
}

/**
 * POST /api/admin/dispatch-rebuild
 *
 * Used by the /ingest UI's batch mode after committing N files via
 * /api/admin/ingest-review with skipDispatch=true. The caller decides which
 * workflow to dispatch based on whether any of those N files lack scoring:
 *
 *   - `mode: 'rebuild'` (default): dispatches rebuild-fast.yml. ~5 min to live.
 *   - `mode: 'score-then-rebuild'`: dispatches llm-ensemble-score.yml with
 *      show_id + fast_rebuild=true so it auto-triggers rebuild-fast on
 *      completion. ~15-20 min to live.
 *
 * Body:
 *   { reason?: string, mode?: 'rebuild' | 'score-then-rebuild', show_id?: string }
 *
 * Returns:
 *   { success: true, workflowRunUrl: string, dispatchedWorkflow: string }
 *   { success: false, error: string }
 */
export async function POST(request: NextRequest) {
  if (!isAdmin()) {
    return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
  }

  const token = process.env.REVIEW_TEXTS_TOKEN;
  if (!token) {
    return NextResponse.json(
      { success: false, error: 'REVIEW_TEXTS_TOKEN not configured on server' },
      { status: 500 },
    );
  }

  let reason = 'admin-ingest-ui: batch dispatch';
  let mode: 'rebuild' | 'score-then-rebuild' = 'rebuild';
  let showId: string | null = null;
  try {
    const body = (await request.json()) as DispatchRebuildBody;
    if (body && typeof body.reason === 'string' && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 200);
    }
    if (body && body.mode === 'score-then-rebuild') {
      mode = 'score-then-rebuild';
    }
    if (body && typeof body.show_id === 'string' && body.show_id.trim()) {
      showId = body.show_id.trim();
    }
  } catch {
    // Empty body OK — use default rebuild-only mode
  }

  if (mode === 'score-then-rebuild' && !showId) {
    return NextResponse.json(
      { success: false, error: 'show_id is required when mode=score-then-rebuild' },
      { status: 400 },
    );
  }

  const targetWorkflow = mode === 'score-then-rebuild' ? SCORING_WORKFLOW : REBUILD_WORKFLOW;
  const inputs: Record<string, string> =
    mode === 'score-then-rebuild'
      ? {
          show_id: showId as string,
          fast_rebuild: 'true',
          run_calibration: 'false',
          run_validation: 'false',
          // Per-show concurrency lane (ship-check 2026-04-27 P0). Same
          // rationale as /api/admin/ingest-review: without rescore_reason,
          // every dispatch queues into the default `scoring-reviews`
          // concurrency group and serializes — blocking parallel show
          // ingests up to the 350-min timeout, breaking the <20-min SLA.
          rescore_reason: `admin-ingest-${showId}`,
        }
      : { reason };

  const res = await fetchWithRetry(
    `${GH_API_BASE}/repos/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions/workflows/${targetWorkflow}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-admin-ingest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs }),
      cache: 'no-store',
    },
  );

  if (!res.ok) {
    return NextResponse.json(
      { success: false, error: `Dispatch failed: ${res.status} ${await res.text()}` },
      { status: 502 },
    );
  }

  return NextResponse.json({
    success: true,
    workflowRunUrl: `https://github.com/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions/workflows/${targetWorkflow}`,
    dispatchedWorkflow: targetWorkflow,
  });
}

// Same retry strategy as ingest-review/route.ts: 3 attempts, 200/500/1000ms
// backoff. Retries on 5xx + 429 + network errors. 4xx surfaces immediately.
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const delays = [200, 500, 1000];
  let lastError: unknown = null;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 || res.status === 429) {
        if (attempt < delays.length) {
          await new Promise(r => setTimeout(r, delays[attempt]));
          continue;
        }
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < delays.length) {
        await new Promise(r => setTimeout(r, delays[attempt]));
        continue;
      }
      throw err;
    }
  }
  if (lastError) throw lastError;
  throw new Error('fetchWithRetry exhausted attempts');
}
