import { NextRequest } from 'next/server';
import crypto from 'crypto';
import {
  TEAM_KEY,
  TERMINAL_STATE_TYPES,
  buildDispatchIssue,
  conditionSearchPrefix,
  hasConditionAnchor,
  pickCanonicalIssue,
  pickTodoState,
} from '@/lib/linear-dispatch-issue';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 15;

function htmlPage(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${title} - Broadway Scorecard</title>
<style>body{margin:0;padding:40px 20px;background:#0f0f14;color:#fff;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;text-align:center;}
h1{font-size:24px;margin-bottom:16px;}p{color:rgba(255,255,255,0.7);font-size:16px;line-height:1.6;max-width:480px;margin:0 auto 16px;}
a{color:#d4a574;}</style></head><body>${body}</body></html>`;
}

/** Strip HTML-significant characters and cap length for safe echoing into pages. */
function sanitize(input: string, maxLen = 200): string {
  return input.replace(/[<>&]/g, '').slice(0, maxLen);
}

// ── Linear (BRO-4718) ──────────────────────────────────────────────────────
// The "Fix this" tap files a Linear issue in Todo, where the dispatchers
// (linear-next.js on the Mac, the cloud worker routine) pick up work. It used
// to create a Notion card for scripts/notion-action-poll.js, whose launchd job
// was disabled 2026-08-30: the owner tapped and nothing happened.
// Raw GraphQL because this route cannot require scripts/lib/linear-client.js
// (CommonJS outside src/); the issue body and dedupe anchor live in
// src/lib/linear-dispatch-issue.js, drift-tested against scripts/lib.
const LINEAR_API_URL = 'https://api.linear.app/graphql';

interface LinearCandidate {
  id: string;
  identifier: string;
  url: string;
  createdAt: string;
  stateType: string;
}

async function linearGraphql(apiKey: string, query: string, variables: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  let json: { data?: Record<string, unknown>; errors?: Array<{ message?: string }> } = {};
  try {
    json = await res.json();
  } catch {
    // non-JSON body; handled below
  }
  if (!res.ok || json.errors?.length || !json.data) {
    const msg = json.errors?.map(e => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Linear GraphQL failed: ${msg.slice(0, 200)}`);
  }
  return json.data;
}

// Open issues on the team whose description carries this condition's anchor.
// owner-alert-router.js writes the same anchor, so this also finds an issue the
// automatic health-check path already filed; a tap then lands on that issue.
async function queryConditionIssues(conditionKey: string, apiKey: string): Promise<LinearCandidate[]> {
  // Prefix search + exact client-side check: Linear escapes the stored anchor,
  // so a `contains` on the full anchor never matches (BRO-5170).
  const data = await linearGraphql(apiKey,
    `query($teamKey: String!, $anchor: String!, $terminal: [String!]) {
      issues(first: 50, filter: { team: { key: { eq: $teamKey } }, description: { contains: $anchor }, state: { type: { nin: $terminal } } }) {
        nodes { id identifier url createdAt description state { type } }
      }
    }`,
    { teamKey: TEAM_KEY, anchor: conditionSearchPrefix(conditionKey), terminal: TERMINAL_STATE_TYPES });
  const nodes = ((data.issues as { nodes?: Array<Record<string, unknown>> } | undefined)?.nodes) || [];
  return nodes.filter(n => hasConditionAnchor(String(n.description || ''), conditionKey)).map(n => ({
    id: String(n.id),
    identifier: String(n.identifier || ''),
    url: String(n.url || ''),
    createdAt: String(n.createdAt || ''),
    stateType: String((n.state as { type?: string } | undefined)?.type || ''),
  }));
}

async function createConditionIssue(
  { conditionKey, title, description }: { conditionKey: string; title: string; description: string },
  apiKey: string
): Promise<LinearCandidate> {
  const teamData = await linearGraphql(apiKey,
    'query($teamKey: String!) { teams(filter: { key: { eq: $teamKey } }) { nodes { id states { nodes { id name type } } } } }',
    { teamKey: TEAM_KEY });
  const team = ((teamData.teams as { nodes?: Array<{ id: string; states?: { nodes?: Array<{ id: string; name: string; type: string }> } }> } | undefined)?.nodes || [])[0];
  if (!team) throw new Error(`Linear team ${TEAM_KEY} not found`);
  const todo = pickTodoState(team.states?.nodes || []);
  if (!todo) throw new Error(`Linear team ${TEAM_KEY} has no unstarted (Todo) state`);
  const issue = buildDispatchIssue({ conditionKey, title, description });
  const created = await linearGraphql(apiKey,
    `mutation($input: IssueCreateInput!) {
      issueCreate(input: $input) { success issue { id identifier url createdAt state { type } } }
    }`,
    { input: { teamId: team.id, stateId: todo.id, title: issue.title, description: issue.description, priority: issue.priority } });
  const payload = created.issueCreate as { success?: boolean; issue?: Record<string, unknown> } | undefined;
  if (!payload?.success || !payload.issue) throw new Error('Linear issueCreate returned no issue');
  const n = payload.issue;
  return {
    id: String(n.id),
    identifier: String(n.identifier || ''),
    url: String(n.url || ''),
    createdAt: String(n.createdAt || ''),
    stateType: String((n.state as { type?: string } | undefined)?.type || ''),
  };
}

// Archives the losing issue from a create-time race (double tap, or the link
// opened in two tabs). Failure is logged, never surfaced: worst case is a
// harmless duplicate issue, not a broken tap.
async function archiveIssue(id: string, apiKey: string): Promise<void> {
  try {
    await linearGraphql(apiKey, 'mutation($id: String!) { issueArchive(id: $id) { success } }', { id });
  } catch (err) {
    console.error(`Failed to archive duplicate dispatch issue ${id}:`, (err as Error).message);
  }
}

export async function GET(req: NextRequest): Promise<Response> {
  return handle(req, 'GET');
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req, 'POST');
}

async function handle(req: NextRequest, method: 'GET' | 'POST'): Promise<Response> {
  if (req.nextUrl.searchParams.get('action') === 'dispatch') {
    return handleDispatch(req, method);
  }
  // approve/reject/revert (BRO-4718): those signed links were only ever built
  // by scripts/autonomous-email.js for Notion cards in Auto=needs-approval, a
  // state only the autonomous nightly loop set. The loop was retired
  // 2026-07-27 and the Notion board froze 2026-08-20, so the paths that read
  // and patched those cards (and dispatched autonomous-merge.yml) were removed.
  // An old link gets a plain answer instead of a silent no-op.
  return new Response(htmlPage('Link Retired',
    '<h1>This Link Is Retired</h1><p>Approve, reject and undo links from the old overnight loop no longer do anything. Nothing was changed.</p>' +
    '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>'),
  { status: 410, headers: { 'Content-Type': 'text/html' } });
}

// ── "Fix this" digest buttons (card #634, owner ask 2026-07-30) ────────────
// Param shape: conditionKey + title (+ description), signed by
// scripts/lib/dispatch-link.js. The issue does not exist yet; a tap files it.
async function handleDispatch(req: NextRequest, method: 'GET' | 'POST'): Promise<Response> {
  const searchParams = req.nextUrl.searchParams;
  const conditionKey = searchParams.get('conditionKey');
  const title = searchParams.get('title');
  const description = searchParams.get('description') || '';
  const exp = searchParams.get('exp');
  const sig = searchParams.get('sig');

  const html = (title: string, body: string, status = 200) =>
    new Response(htmlPage(title, body), { status, headers: { 'Content-Type': 'text/html' } });

  if (!conditionKey || !title || !exp || !sig) {
    return html('Invalid Link',
      '<h1>Invalid Link</h1><p>This action link is incomplete or malformed.</p>', 400);
  }

  const expMs = parseInt(exp) * 1000;
  if (isNaN(expMs) || Date.now() > expMs) {
    return html('Link Expired',
      '<h1>Link Expired</h1><p>This action link has expired. Nothing was changed.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>', 410);
  }

  // Kill switch (ship-check adversarial finding, codex 2026-07-30): reverting
  // the sender stops NEW links but every already-delivered "Fix this" stays
  // tappable until it expires. Setting DISPATCH_LINKS_DISABLED=true in the
  // Vercel env kills the dispatch action immediately.
  if (process.env.DISPATCH_LINKS_DISABLED === 'true') {
    return html('Temporarily Disabled',
      '<h1>Fix-this Links Are Paused</h1><p>One-tap dispatch is temporarily switched off. Nothing was changed. ' +
      'The issue is still recorded in the morning digest.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>', 503);
  }

  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) {
    return html('Configuration Error',
      '<h1>Server Error</h1><p>The autonomous-action system is not configured. Please contact the admin.</p>', 500);
  }

  // HMAC message must match scripts/lib/dispatch-link.js — change them together.
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`dispatch:${conditionKey}:${title}:${description}:${exp}`)
    .digest('hex');

  let sigValid = false;
  // Require exactly 64 lowercase hex chars: Buffer.from(_, 'hex') silently
  // TRUNCATES at the first non-hex char, so "<validsig>JUNK" would otherwise
  // decode back to the valid signature and pass (ship-check 2026-07-13).
  if (/^[0-9a-f]{64}$/.test(sig)) {
    try {
      const sigBuf = Buffer.from(sig, 'hex');
      const expectedBuf = Buffer.from(expected, 'hex');
      sigValid = sigBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(sigBuf, expectedBuf);
    } catch {
      // invalid hex
    }
  }
  if (!sigValid) {
    return html('Invalid Link',
      '<h1>Invalid Link</h1><p>This action link could not be verified.</p>', 403);
  }

  // GET never mutates: mail-security link scanners and preview fetchers open
  // every URL in an email, so a state-changing GET would let a robot file
  // work (ship-check P0, 2026-07-13). GET renders a one-button confirm form;
  // only the POST it submits writes.
  if (method === 'GET') {
    const qs = new URLSearchParams({ action: 'dispatch', conditionKey, title, exp, sig });
    if (description) qs.set('description', description);
    return html('Confirm Fix',
      `<h1>Fix this?</h1><p>${sanitize(title, 150)}</p>` +
      `<form method="POST" action="/api/autonomous-action?${qs.toString()}">` +
      '<button type="submit" style="background:#16a34a;color:#fff;border:0;font-size:17px;font-weight:700;padding:14px 36px;border-radius:10px;">Fix this</button>' +
      '</form>');
  }

  const linearKey = process.env.LINEAR_API_KEY;
  if (!linearKey) {
    // Fail visibly (BRO-4718): a tap that silently did nothing is the bug this replaced.
    console.error('autonomous-action dispatch: LINEAR_API_KEY is not set in this deployment');
    return html('Configuration Error',
      '<h1>Could Not Start the Fix</h1><p>The Linear integration is not configured on the site, so nothing was filed. ' +
      'This is a setup problem, not something you did.</p>', 500);
  }

  const backLink = '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>';
  const openLink = (c: LinearCandidate, label: string) =>
    c.url ? `<p><a href="${sanitize(c.url, 300)}">${label} ${sanitize(c.identifier, 20)}</a></p>` : '';

  // Dedup: an open issue for this condition means a session is already on it
  // (or about to be). A repeat tap is a no-op rather than a second dispatch.
  let existing: LinearCandidate | null = null;
  try {
    existing = pickCanonicalIssue(await queryConditionIssues(conditionKey, linearKey));
  } catch (err) {
    console.error('Dispatch dedup query failed:', (err as Error).message);
    // Fail CLOSED: a Linear hiccup here must not risk a duplicate dispatch.
    return html('Could Not Check',
      '<h1>Could Not Check for Existing Work</h1><p>Tap the link again in a minute.</p>' + backLink, 502);
  }
  if (existing) {
    return html('Already Being Fixed',
      '<h1>Already Being Fixed</h1><p>A session is already working on this (or waiting to start).</p>' +
      openLink(existing, 'Open') + backLink);
  }

  try {
    const created = await createConditionIssue({ conditionKey, title, description }, linearKey);

    // Race-safe re-check: a second concurrent tap that raced past the dedup
    // query would also have filed an issue by now. Re-query and let
    // pickCanonicalIssue decide one winner; if ours lost, archive it.
    try {
      const winner = pickCanonicalIssue(await queryConditionIssues(conditionKey, linearKey));
      if (winner && winner.id !== created.id) {
        await archiveIssue(created.id, linearKey);
        return html('Already Being Fixed',
          '<h1>Already Being Fixed</h1><p>A session is already working on this (or waiting to start).</p>' +
          openLink(winner, 'Open') + backLink);
      }
    } catch (err) {
      console.error('Post-create race recheck failed (non-fatal):', (err as Error).message);
    }

    return html('Queued',
      '<h1>Queued</h1><p>A fix session will pick this up from the board. You\'ll hear back when it finishes, or if it needs you.</p>' +
      openLink(created, 'Watch') + backLink);
  } catch (err) {
    console.error('Dispatch issue create failed:', (err as Error).message);
    return html('Could Not Start the Fix',
      '<h1>Could Not Start the Fix</h1><p>Tap the link again in a minute.</p>' + backLink, 502);
  }
}
