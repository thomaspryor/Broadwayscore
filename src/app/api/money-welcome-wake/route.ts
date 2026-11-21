import { NextRequest } from 'next/server';
import * as wake from '@/lib/money-welcome-wake';

// BRO-7704: the sign-up page calls this right after a Profitability Scorecard sign-up is stored, so the
// welcome email goes out within minutes instead of waiting for GitHub's throttled hourly cron
// (measured gaps of 3 to 11 hours). Same shape as owner-decision's board-worker-wake: dispatch a workflow
// sooner than its schedule. No secret travels in the request: the route reads the table with the service key
// and only dispatches when a fresh unwelcomed row exists and no run is already queued. The workflow's
// welcomed_at claim keeps the send once-only, and the hourly cron stays as the backstop.
const w = wake as unknown as {
  shouldWake: (rows: unknown) => boolean;
  hasQueuedRun: (...json: unknown[]) => boolean;
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const WORKFLOW = 'money-welcome.yml';
// Per-instance debounce so a script hammering the route cannot turn into a stream of GitHub calls.
// Instances are not shared, so this is a cost brake only; correctness rests on the queued-run check
// and the workflow's welcomed_at claim.
const COOLDOWN_MS = 20_000;
let lastActAt = 0;

function ok(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(_req: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const ghToken = process.env.GH_DISPATCH_TOKEN;
  if (!url || !key || !ghToken) {
    console.error('[money-welcome-wake] not configured (Supabase url, service key or GH_DISPATCH_TOKEN missing)');
    return ok({ ok: false, reason: 'not-configured' });
  }
  const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';
  const gh = { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'broadwayscorecard-money-welcome-wake' };
  try {
    const rowsRes = await fetch(
      `${url}/rest/v1/money_scorecard_signups?select=created_at,welcomed_at,unsubscribed_at&welcomed_at=is.null&unsubscribed_at=is.null&order=created_at.desc&limit=5`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, cache: 'no-store', signal: AbortSignal.timeout(8000) },
    );
    if (!rowsRes.ok) { console.error('[money-welcome-wake] select failed', rowsRes.status); return ok({ ok: false, reason: `supabase-${rowsRes.status}` }, 502); }
    if (!w.shouldWake(await rowsRes.json())) return ok({ ok: true, acted: false, reason: 'nothing-waiting' });
    // The cooldown starts only once a fresh waiting row is confirmed, so a stray call that finds nothing
    // can never swallow the kick of a real sign-up. It only throttles the GitHub calls below.
    const cooldown = process.env.MONEY_WELCOME_WAKE_COOLDOWN_MS === undefined ? COOLDOWN_MS : Number(process.env.MONEY_WELCOME_WAKE_COOLDOWN_MS) || 0;
    if (Date.now() - lastActAt < cooldown) return ok({ ok: true, acted: false, reason: 'cooldown' });
    const prevActAt = lastActAt;
    if (cooldown > 0) lastActAt = Date.now();
    // A dispatch that fails must not leave the cooldown armed, or the next real sign-up's kick is swallowed.
    const disarm = () => { lastActAt = prevActAt; };

    const list = (status: string) => fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/runs?status=${status}&per_page=1`, {
      headers: gh, cache: 'no-store', signal: AbortSignal.timeout(8000),
    }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [queued, pending] = await Promise.all([list('queued'), list('pending')]);
    // A failed look is not a reason to skip the dispatch: an extra run is harmless, a missed one is the bug.
    if (w.hasQueuedRun(queued, pending)) return ok({ ok: true, acted: false, reason: 'run-already-queued' });

    // No inputs on purpose: a dispatch without inputs is a real pass, never a preview to an arbitrary address.
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${WORKFLOW}/dispatches`, {
      method: 'POST',
      headers: { ...gh, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main' }),
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) { disarm(); console.error('[money-welcome-wake] dispatch failed', res.status); return ok({ ok: false, reason: `github-${res.status}` }, 502); }
    return ok({ ok: true, acted: true });
  } catch (e) {
    lastActAt = 0;
    console.error('[money-welcome-wake]', e instanceof Error ? e.message : e);
    return ok({ ok: false, reason: 'error' }, 502);
  }
}
