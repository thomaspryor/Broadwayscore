import { NextRequest } from 'next/server';
import * as webhook from '@/lib/linear-webhook';
import { linearGraphql } from '@/lib/owner-decision-page';

// BRO-6715: Linear calls this for every new comment. A reply on a card that waits on the owner starts the
// reply drain for that one card within a minute (it used to wait for the twice-daily schedule). The body
// is signed (Linear-Signature, HMAC-SHA256 of the raw body); nothing here writes to Linear.
const w = webhook as unknown as {
  verifySignature: (raw: string, header: string | null, secret: string | undefined) => boolean;
  fresh: (payload: unknown, now?: number) => boolean;
  replyCandidate: (payload: unknown) => string | null;
  waitsOnOwner: (issue: unknown) => boolean;
};

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const ISSUE_QUERY = `query($id: String!) { issue(id: $id) { id identifier description state { type } labels { nodes { name } } } }`;

function ok(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
}

export async function POST(req: NextRequest) {
  const secret = process.env.LINEAR_WEBHOOK_SECRET;
  if (!secret) return ok({ ok: false, reason: 'not-configured' });
  const raw = await req.text();
  if (!w.verifySignature(raw, req.headers.get('linear-signature'), secret)) return ok({ ok: false, reason: 'bad-signature' }, 401);
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return ok({ ok: false, reason: 'bad-json' }, 400); }
  if (!w.fresh(payload)) return ok({ ok: false, reason: 'stale' }, 400);
  const issueId = w.replyCandidate(payload);
  if (!issueId) return ok({ ok: true, acted: false, reason: 'not-a-reply' });
  const ghToken = process.env.GH_DISPATCH_TOKEN;
  if (!ghToken) { console.error('[linear-webhook] GH_DISPATCH_TOKEN is not set'); return ok({ ok: false, reason: 'no-github-token' }); }
  try {
    const data = await linearGraphql(ISSUE_QUERY, { id: issueId });
    const issue = data && data.issue;
    if (!w.waitsOnOwner(issue)) return ok({ ok: true, acted: false, reason: 'not-waiting' });
    const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';
    const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/linear-decision-reply-drain.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${ghToken}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'broadwayscorecard-linear-webhook' },
      body: JSON.stringify({ ref: 'main', inputs: { issue: issue.identifier, cap: '1' } }),
      cache: 'no-store',
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return ok({ ok: false, reason: `github-${res.status}` }, 502);
    return ok({ ok: true, acted: true, issue: issue.identifier });
  } catch (e) {
    console.error('[linear-webhook]', e instanceof Error ? e.message : e);
    return ok({ ok: false, reason: 'error' }, 502);
  }
}
