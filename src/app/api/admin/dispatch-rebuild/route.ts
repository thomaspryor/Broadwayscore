import { NextRequest, NextResponse } from 'next/server';
import { isAdmin } from '@/lib/admin-auth';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PUBLIC_REPO_OWNER = 'thomaspryor';
const PUBLIC_REPO_NAME = 'Broadwayscore';
const REBUILD_WORKFLOW = 'rebuild-fast.yml';

const GH_API_BASE = 'https://api.github.com';

/**
 * POST /api/admin/dispatch-rebuild
 *
 * Dispatches Rebuild Reviews (Fast) once. Used by the form's batch mode after
 * committing N files via /api/admin/ingest-review with skipDispatch=true.
 *
 * Body (optional):
 *   { reason?: string }  // commit-message-style reason for the rebuild
 *
 * Returns:
 *   { success: true, workflowRunUrl: string }
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
  try {
    const body = (await request.json()) as { reason?: string };
    if (body && typeof body.reason === 'string' && body.reason.trim()) {
      reason = body.reason.trim().slice(0, 200);
    }
  } catch {
    // Empty body OK — use default reason
  }

  const res = await fetchWithRetry(
    `${GH_API_BASE}/repos/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions/workflows/${REBUILD_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'broadwayscorecard-admin-ingest',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ref: 'main', inputs: { reason } }),
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
    workflowRunUrl: `https://github.com/${PUBLIC_REPO_OWNER}/${PUBLIC_REPO_NAME}/actions/workflows/${REBUILD_WORKFLOW}`,
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
