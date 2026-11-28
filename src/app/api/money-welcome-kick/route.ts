import { NextRequest } from 'next/server';
import * as wake from '@/lib/money-welcome-wake';
import * as kick from '@/lib/money-welcome-kick';

// BRO-7704: called by the Supabase pg_net trigger money_scorecard_signups_kick (insert on
// money_scorecard_signups) with the shared secret in x-kick-secret (read from money_welcome_kick_config). Dispatches money-welcome.yml now
// instead of waiting for GitHub's throttled hourly cron. The trigger is the proof a sign-up exists, so
// no table read here. Skips when a run is already queued/pending (it will read the new row). The
// workflow's welcomed_at claim keeps the send once-only; the hourly cron stays as the backstop.
const w = wake as unknown as { hasQueuedRun: (...json: unknown[]) => boolean };
const k = kick as unknown as { isAuthorized: (provided: unknown, expected: unknown) => boolean };

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WORKFLOW = 'money-welcome.yml';
// Per-instance cost brake: a burst of sign-ups (the RPC allows 60 rows/min) must not spend the shared
// GH_DISPATCH_TOKEN quota. Rows landing inside the window are read by the run the first kick starts, or by the cron.
const COOLDOWN_MS = 5_000;
let lastActAt = 0;

function ok(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ghToken = process.env.GH_DISPATCH_TOKEN;
  if (!url || !svc || !ghToken) {
    // Same 401 as a bad secret would be a lie; 503 only reveals "this deployment is unconfigured", which carries no secret.
    console.error('[money-welcome-kick] not configured (Supabase url, service key or GH_DISPATCH_TOKEN missing)');
    return ok({ ok: false, reason: 'not-configured' }, 503);
  }
  // The shared secret is generated inside the database by the migration (money_welcome_kick_config), so it is
  // never in git or a hand-copied env var. The route reads it with the service key and compares in constant time.
  let secret: string | undefined;
  try {
    const r = await fetch(`${url}/rest/v1/money_welcome_kick_config?select=secret&limit=1`, {
      headers: { apikey: svc, Authorization: `Bearer ${svc}` }, cache: 'no-store', signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) { console.error('[money-welcome-kick] config read failed', r.status); return ok({ ok: false, reason: `supabase-${r.status}` }, 502); }
    const rows = await r.json();
    secret = Array.isArray(rows) && rows[0] && typeof rows[0].secret === 'string' ? rows[0].secret : undefined;
  } catch (e) {
    console.error('[money-welcome-kick] config read error', e instanceof Error ? e.message : e);
    return ok({ ok: false, reason: 'error' }, 502);
  }
  if (!secret || !k.isAuthorized(req.headers.get('x-kick-secret'), secret)) return ok({ ok: false, reason: 'unauthorized' }, 401);
  const cooldown = process.env.MONEY_WELCOME_KICK_COOLDOWN_MS === undefined ? COOLDOWN_MS : Number(process.env.MONEY_WELCOME_KICK_COOLDOWN_MS) || 0;
  if (Date.now() - lastActAt < cooldown) return ok({ ok: true, acted: false, reason: 'cooldown' });
  const prevActAt = lastActAt;
  if (cooldown > 0) lastActAt = Date.now();

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
    if (!res.ok) { lastActAt = prevActAt; console.error('[money-welcome-kick] dispatch failed', res.status); return ok({ ok: false, reason: `github-${res.status}` }, 502); }
    return ok({ ok: true, acted: true });
  } catch (e) {
    lastActAt = prevActAt;
    console.error('[money-welcome-kick]', e instanceof Error ? e.message : e);
    return ok({ ok: false, reason: 'error' }, 502);
  }
}
