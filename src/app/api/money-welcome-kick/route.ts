import { NextRequest } from 'next/server';
import * as wake from '@/lib/money-welcome-wake';
import * as kick from '@/lib/money-welcome-kick';

// BRO-7704: called by the Supabase pg_net trigger money_scorecard_signups_kick (insert on
// money_scorecard_signups) with the shared secret in x-kick-secret. Dispatches money-welcome.yml now
// instead of waiting for GitHub's throttled hourly cron. The trigger is the proof a sign-up exists, so
// no table read here. Skips when a run is already queued/pending (it will read the new row). The
// workflow's welcomed_at claim keeps the send once-only; the hourly cron stays as the backstop.
const w = wake as unknown as { hasQueuedRun: (...json: unknown[]) => boolean };
const k = kick as unknown as { isAuthorized: (provided: unknown, expected: unknown) => boolean };

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WORKFLOW = 'money-welcome.yml';

function ok(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const secret = process.env.MONEY_WELCOME_KICK_SECRET;
  const ghToken = process.env.GH_DISPATCH_TOKEN;
  if (!secret || !ghToken) {
    console.error('[money-welcome-kick] not configured (MONEY_WELCOME_KICK_SECRET or GH_DISPATCH_TOKEN missing)');
    return ok({ ok: false, reason: 'not-configured' }, 503);
  }
  if (!k.isAuthorized(req.headers.get('x-kick-secret'), secret)) return ok({ ok: false, reason: 'unauthorized' }, 401);

  const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';
  const gh = { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'broadwayscorecard-money-welcome-kick' };
  try {
    const list = (status: string) => fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=${status}&per_page=1`, {
      headers: gh, cache: 'no-store', signal: AbortSignal.timeout(8000),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [queued, pending] = await Promise.all([list('queued'), list('pending')]);
    // A failed look is not a reason to skip: an extra run is harmless, a missed one is the bug.
    if (w.hasQueuedRun(queued, pending)) return ok({ ok: true, acted: false, reason: 'run-already-queued' });
    // No inputs on purpose: a dispatch without inputs is a real pass, never a preview to an arbitrary address.
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: { ...gh, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { console.error('[money-welcome-kick] dispatch failed', res.status); return ok({ ok: false, reason: `github-${res.status}` }, 502); }
    return ok({ ok: true, acted: true });
  } catch (e) {
    console.error('[money-welcome-kick]', e instanceof Error ? e.message : e);
    return ok({ ok: false, reason: 'error' }, 502);
  }
}
