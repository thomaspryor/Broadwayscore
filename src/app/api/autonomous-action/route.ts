import { NextRequest } from 'next/server';
import crypto from 'crypto';

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

const NOTION_BASE = 'https://api.notion.com/v1';

async function notionApi(
  path: string,
  method: string,
  apiKey: string,
  body?: object,
  notionVersion = '2022-06-28'
): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${NOTION_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Notion-Version': notionVersion,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: Record<string, unknown> = {};
  try {
    json = await res.json();
  } catch {
    // non-JSON body; leave empty
  }
  return { ok: res.ok, status: res.status, json };
}

const VALID_ACTIONS = ['approve', 'reject', 'revert'] as const;
type AutoAction = (typeof VALID_ACTIONS)[number];

// GET never mutates: mail-security link scanners and preview fetchers open
// every URL in an email, so a state-changing GET would let a robot approve
// overnight work (ship-check P0, 2026-07-13). GET validates the signed link
// and renders a one-button confirm form; the POST it submits does the write.
export async function GET(req: NextRequest): Promise<Response> {
  return handle(req, 'GET');
}

export async function POST(req: NextRequest): Promise<Response> {
  return handle(req, 'POST');
}

async function handle(req: NextRequest, method: 'GET' | 'POST'): Promise<Response> {
  const searchParams = req.nextUrl.searchParams;
  // "Fix this" digest buttons (card #634): a separate action with its own
  // param shape (conditionKey+title, no existing card/branch — the card
  // doesn't exist yet, it gets created on click) and its own HMAC message —
  // handle it before the approve/reject/revert path below, which requires
  // card+branch.
  if (searchParams.get('action') === 'dispatch') {
    return handleDispatch(req, method);
  }
  const card = searchParams.get('card');
  const branch = searchParams.get('branch');
  const action = searchParams.get('action');
  const exp = searchParams.get('exp');
  const sig = searchParams.get('sig');
  const reason = sanitize(searchParams.get('reason') || 'owner tap');

  const html = (title: string, body: string, status = 200) =>
    new Response(htmlPage(title, body), { status, headers: { 'Content-Type': 'text/html' } });

  if (!card || !branch || !action || !exp || !sig) {
    return html('Invalid Link',
      '<h1>Invalid Link</h1><p>This action link is incomplete or malformed.</p>', 400);
  }

  if (!(VALID_ACTIONS as readonly string[]).includes(action)) {
    return html('Invalid Link',
      '<h1>Invalid Link</h1><p>This action link requests an unknown action.</p>', 400);
  }
  const autoAction = action as AutoAction;

  const expMs = parseInt(exp) * 1000;
  if (isNaN(expMs) || Date.now() > expMs) {
    return html('Link Expired',
      '<h1>Link Expired</h1><p>This action link has expired — nothing was changed.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>', 410);
  }

  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) {
    return html('Configuration Error',
      '<h1>Server Error</h1><p>The autonomous-action system is not configured. Please contact the admin.</p>', 500);
  }

  // HMAC message must match scripts/lib/autonomous-links.js — change them together.
  const expected = crypto
    .createHmac('sha256', secret)
    .update(`auto:${autoAction}:${card}:${branch}:${exp}`)
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

  // Valid signed link opened in a browser: show the one-tap confirm form.
  // Only the POST it submits mutates anything.
  if (method === 'GET') {
    const verb = autoAction === 'approve' ? 'Approve' : autoAction === 'reject' ? 'Reject' : 'Revert';
    const color = autoAction === 'approve' ? '#16a34a' : '#dc2626';
    const qs = new URLSearchParams({ card, branch, action: autoAction, exp, sig });
    if (reason) qs.set('reason', reason);
    return html(`Confirm ${verb}`,
      `<h1>Confirm ${verb}</h1><p>${sanitize(branch, 100)}</p>` +
      `<form method="POST" action="/api/autonomous-action?${qs.toString()}">` +
      `<button type="submit" style="background:${color};color:#fff;border:0;font-size:17px;font-weight:700;padding:14px 36px;border-radius:10px;">${verb}</button>` +
      `</form>`);
  }

  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) {
    return html('Configuration Error',
      '<h1>Server Error</h1><p>Notion integration is not configured. Please contact the admin.</p>', 500);
  }

  // Read the card's current automation state (Auto select property).
  let currentState: string | null = null;
  try {
    const page = await notionApi(`/pages/${encodeURIComponent(card)}`, 'GET', notionKey);
    if (!page.ok) {
      console.error(`Notion GET page failed: ${page.status}`);
      return html('Update Failed',
        '<h1>Could Not Update the Card</h1><p>Tap the link again in a minute.</p>', 502);
    }
    const props = page.json.properties as Record<string, { select?: { name?: string } | null }> | undefined;
    currentState = props?.Auto?.select?.name ?? null;
  } catch (err) {
    console.error('Notion GET page error:', (err as Error).message);
    return html('Update Failed',
      '<h1>Could Not Update the Card</h1><p>Tap the link again in a minute.</p>', 502);
  }

  const backLink = '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>';
  const safeState = sanitize(currentState ?? 'none', 50);

  const patchAuto = async (name: string): Promise<boolean> => {
    try {
      const res = await notionApi(`/pages/${encodeURIComponent(card)}`, 'PATCH', notionKey, {
        properties: { Auto: { select: { name } } },
      });
      if (!res.ok) console.error(`Notion PATCH failed: ${res.status}`);
      return res.ok;
    } catch (err) {
      console.error('Notion PATCH error:', (err as Error).message);
      return false;
    }
  };

  // Dispatch autonomous-merge.yml (Sprint 3). Returns whether the dispatch
  // itself succeeded — callers must not treat a dispatch failure as fatal,
  // since the underlying state (approved / still merged) is already correct
  // either way; the owner can re-tap or the next nightly run will surface it.
  const dispatchMergeWorkflow = async (mergeAction: 'approve' | 'revert'): Promise<boolean> => {
    const ghToken = process.env.GH_DISPATCH_TOKEN;
    const repo = process.env.GITHUB_REPO || 'thomaspryor/Broadwayscore';
    if (!ghToken) return false;
    try {
      const res = await fetch(
        `https://api.github.com/repos/${repo}/actions/workflows/autonomous-merge.yml/dispatches`,
        {
          method: 'POST',
          headers: {
            'Authorization': `token ${ghToken}`,
            'User-Agent': 'BroadwayScorecard-AutonomousAction',
            'Content-Type': 'application/json',
            'Accept': 'application/vnd.github.v3+json',
          },
          body: JSON.stringify({ ref: 'main', inputs: { card_id: card, branch, action: mergeAction } }),
        }
      );
      if (!res.ok) console.error(`Merge dispatch (${mergeAction}) failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      return res.ok;
    } catch (err) {
      console.error(`Merge dispatch (${mergeAction}) error:`, (err as Error).message);
      return false;
    }
  };

  if (autoAction === 'approve') {
    if (currentState === 'approved') {
      return html('Already Approved',
        '<h1>Already Approved</h1><p>This card was already approved — nothing further was changed.</p>' + backLink);
    }
    if (currentState === 'merged') {
      return html('Already Merged',
        '<h1>Already Merged</h1><p>This card has already been merged — nothing further was changed.</p>' + backLink);
    }
    if (currentState === 'rejected') {
      return html('Card Was Rejected',
        '<h1>Card Was Rejected</h1><p>This card was rejected — a fresh nightly run is needed before it can be approved.</p>' + backLink, 409);
    }
    if (currentState !== 'needs-approval') {
      return html('Not Awaiting Approval',
        `<h1>Not Awaiting Approval</h1><p>This card is not awaiting approval (state: ${safeState}).</p>` + backLink, 409);
    }

    if (!(await patchAuto('approved'))) {
      return html('Update Failed',
        '<h1>Could Not Update the Card</h1><p>Tap the link again in a minute.</p>', 502);
    }

    const dispatched = await dispatchMergeWorkflow('approve');
    return html('Approved',
      '<h1>Approved!</h1>' +
      (dispatched
        ? '<p>Approval recorded and the merge is underway. You\'ll see the result on the card.</p>'
        : '<p>Approval recorded, but the merge dispatch could not be confirmed. Check the card shortly — re-tap Approve if it\'s still showing needs-approval.</p>') +
      backLink);
  }

  if (autoAction === 'revert') {
    if (currentState === 'reverted') {
      return html('Already Reverted',
        '<h1>Already Reverted</h1><p>This card was already reverted — nothing further was changed.</p>' + backLink);
    }
    if (currentState !== 'merged') {
      return html('Cannot Revert',
        `<h1>Cannot Revert</h1><p>This card is not in a revertable state (state: ${safeState}). Only merged work can be reverted.</p>` + backLink, 409);
    }

    // No pre-patch here (unlike approve): 'reverted' should only be set once
    // the git revert actually lands — autonomous-merge.js's revert() flips
    // Auto atomically after a successful push. A failed dispatch below just
    // leaves the card at Auto=merged, which is still an accurate state.
    const dispatched = await dispatchMergeWorkflow('revert');
    return html('Revert Underway',
      '<h1>Revert Underway</h1>' +
      (dispatched
        ? '<p>The revert is running now. You\'ll see the result on the card shortly.</p>'
        : '<p>The revert dispatch could not be confirmed. Check the card shortly — re-tap Undo if it\'s still showing merged.</p>') +
      backLink);
  }

  // autoAction === 'reject'
  if (currentState === 'rejected') {
    return html('Already Rejected',
      '<h1>Already Rejected</h1><p>This card was already rejected — nothing further was changed.</p>' + backLink);
  }
  if (currentState !== 'needs-approval' && currentState !== 'approved') {
    return html('Cannot Reject',
      `<h1>Cannot Reject</h1><p>This card is not in a rejectable state (state: ${safeState}).</p>` + backLink, 409);
  }

  if (!(await patchAuto('rejected'))) {
    return html('Update Failed',
      '<h1>Could Not Update the Card</h1><p>Tap the link again in a minute.</p>', 502);
  }

  // Leave an audit comment on the card; comment failure is non-fatal.
  try {
    const res = await notionApi('/comments', 'POST', notionKey, {
      parent: { page_id: card },
      rich_text: [{ text: { content: `[auto] rejected via signed tap: ${reason}` } }],
    });
    if (!res.ok) console.error(`Notion comment failed: ${res.status}`);
  } catch (err) {
    console.error('Notion comment error:', (err as Error).message);
  }

  return html('Rejected',
    '<h1>Rejected</h1><p>The branch will not merge.</p>' + backLink);
}

// ── "Fix this" digest buttons (card #634 — owner ask 2026-07-30) ───────────
// A tap here has no existing Notion card: it creates one with the Action
// Queue property set to 'Fix', which scripts/notion-action-poll.js (launchd,
// polls every 5 min) already picks up hands-free via its 'Fix' pipeline
// (Investigate → Plan → Review → Start — see PIPELINES in that file). Reuses
// that infrastructure as-is; no poller changes needed.
//
// BRAIN_DATABASE_ID / DISPATCH_NOTION_VERSION MUST match
// scripts/lib/notion-constants.js — duplicated here rather than imported
// (this route can't require a CommonJS file outside src/), same convention
// as the HMAC message duplication called out at the top of this file.
const BRAIN_DATABASE_ID = 'fa7b3ff2-c073-4097-b54c-0a78e56e06b6';
const DISPATCH_NOTION_VERSION = '2025-09-03';

interface DispatchCandidate {
  id: string;
  url: string;
  status: string | null;
  action: string | null;
}

// The exact substring written into a card's Notes to mark which condition it
// belongs to — ALSO what the dedup query below searches for. Quoted (not
// bare) so `health-check:foo` never substring-matches a card actually filed
// for `health-check:foo-bar` (ship-check adversarial finding, codex
// 2026-07-30: Notion's rich_text `contains` filter is a plain substring
// match with no anchoring). Phrasing MUST match buildCardNotes() in
// scripts/lib/owner-alert-router.js (`Condition "${conditionKey}" no longer
// fires…`, no colon) — that's the exact substring already written into every
// card the EXISTING automatic health-check.js path files, and matching it is
// what lets a Fix-this tap land on that same card instead of duplicating it.
function conditionMarker(conditionKey: string): string {
  return `Condition "${conditionKey}"`;
}

// Mirrors scripts/lib/dispatch-link.js's selectOpenDispatchCard — kept as a
// small inline duplicate for the same reason as the constants above. See that
// file's comment for why `action` (not just `status`) decides "still open".
function selectOpenDispatchCard(candidates: DispatchCandidate[]): DispatchCandidate | null {
  const OPEN = new Set(['Not started', 'In progress']);
  return candidates.find(c => (c.status !== null && OPEN.has(c.status)) || (c.action !== null && c.action !== '')) || null;
}

// Dedup query: any card whose Notes carry this condition's marker
// (createDispatchCard below writes it, and dispatchCard() in
// scripts/lib/owner-alert-router.js already writes the equivalent
// `Condition "${conditionKey}"` phrasing into every card it files — so this
// also finds cards filed by the EXISTING automatic health-check.js path; a
// tap on an issue that already auto-dispatched lands on that same card
// instead of filing a duplicate). page_size 100 (Notion's max, not paginated
// further) — plenty for a single-owner project's card volume; a real
// pagination loop would be premature complexity here.
async function findOpenDispatchCard(conditionKey: string, notionKey: string): Promise<DispatchCandidate | null> {
  const res = await notionApi(`/data_sources/${BRAIN_DATABASE_ID}/query`, 'POST', notionKey, {
    filter: { property: 'Notes', rich_text: { contains: conditionMarker(conditionKey) } },
    page_size: 100,
  }, DISPATCH_NOTION_VERSION);
  if (!res.ok) throw new Error(`Notion query failed: ${res.status}`);
  const results = Array.isArray(res.json.results) ? (res.json.results as Array<Record<string, unknown>>) : [];
  const candidates: DispatchCandidate[] = results.map(page => {
    const props = (page.properties || {}) as Record<string, { status?: { name?: string } | null; select?: { name?: string } | null }>;
    return {
      id: String(page.id),
      url: String(page.url || ''),
      status: props.Status?.status?.name ?? null,
      action: props.Action?.select?.name ?? null,
    };
  });
  return selectOpenDispatchCard(candidates);
}

async function createDispatchCard(
  { conditionKey, title, description }: { conditionKey: string; title: string; description: string },
  notionKey: string
): Promise<{ id: string; url: string }> {
  // description (ship-check adversarial finding, codex 2026-07-30): without
  // it, the dispatched session only sees a check NAME — for a check whose
  // failure reason has changed since the digest was generated (or that
  // covers several distinct failure modes under one name), it can "fix" the
  // wrong thing silently. This is the same detail health-check.js's OWN
  // routeAlert() calls already pass as `description` (see health-check.js's
  // dispatchedCards loop) — carrying it here keeps the two dispatch paths at
  // parity.
  const notes = `## Problem\nFiled via a "Fix this" tap in the digest email.\n\n- **Title:** ${title}\n${description ? `- **Detail:** ${description}\n` : ''}\n## Suggested approach\nInvestigate the condition named above and fix the root cause.\n\n## Acceptance criteria\n${conditionMarker(conditionKey)} no longer fires. The Action Queue pipeline (Investigate → Plan → Review → Start) runs this hands-free — no owner involvement needed beyond this tap.`;
  const res = await notionApi('/pages', 'POST', notionKey, {
    parent: { type: 'data_source_id', data_source_id: BRAIN_DATABASE_ID },
    properties: {
      Name: { title: [{ text: { content: `Fix: ${title}`.slice(0, 200) } }] },
      Status: { status: { name: 'Not started' } },
      Action: { select: { name: 'Fix' } },
      Priority: { select: { name: 'P1 Next' } },
      Category: { select: { name: 'Infra' } },
      Tags: { multi_select: [{ name: 'alert-router' }, { name: 'fix-this-button' }] },
      Notes: { rich_text: [{ text: { content: notes.slice(0, 2000) } }] },
    },
  }, DISPATCH_NOTION_VERSION);
  if (!res.ok) throw new Error(`Notion create failed: ${res.status} ${JSON.stringify(res.json).slice(0, 200)}`);
  return { id: String(res.json.id), url: String(res.json.url || '') };
}

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
      '<h1>Link Expired</h1><p>This action link has expired — nothing was changed.</p>' +
      '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>', 410);
  }

  // Kill switch (ship-check adversarial finding, codex 2026-07-30): reverting
  // the sender stops NEW links but every already-delivered "Fix this" stays
  // tappable until it expires, and rotating APPROVAL_HMAC_SECRET would also
  // revoke the unrelated approve/reject/revert links. Setting
  // DISPATCH_LINKS_DISABLED=true in the Vercel env kills the dispatch action
  // alone, immediately, without touching the other actions.
  if (process.env.DISPATCH_LINKS_DISABLED === 'true') {
    return html('Temporarily Disabled',
      '<h1>Fix-this Links Are Paused</h1><p>One-tap dispatch is temporarily switched off — nothing was changed. ' +
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
  // Same truncated-hex hardening as the approve/reject/revert path above.
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

  // GET never mutates (same mail-scanner hazard as the approve/reject/revert
  // path above) — it renders a confirm form; only the POST it submits writes.
  if (method === 'GET') {
    const qs = new URLSearchParams({ action: 'dispatch', conditionKey, title, exp, sig });
    if (description) qs.set('description', description);
    return html('Confirm Fix',
      `<h1>Fix this?</h1><p>${sanitize(title, 150)}</p>` +
      `<form method="POST" action="/api/autonomous-action?${qs.toString()}">` +
      '<button type="submit" style="background:#16a34a;color:#fff;border:0;font-size:17px;font-weight:700;padding:14px 36px;border-radius:10px;">Fix this</button>' +
      '</form>');
  }

  const notionKey = process.env.NOTION_API_KEY;
  if (!notionKey) {
    return html('Configuration Error',
      '<h1>Server Error</h1><p>Notion integration is not configured. Please contact the admin.</p>', 500);
  }

  const backLink = '<p><a href="https://broadwayscorecard.com">Back to Broadway Scorecard</a></p>';

  // Dedup: an already-open card for this condition means a session is
  // already on it (or about to be) — a repeat tap, or re-opening the same
  // email within its expiry window, is a no-op rather than a second dispatch.
  let existing: DispatchCandidate | null = null;
  try {
    existing = await findOpenDispatchCard(conditionKey, notionKey);
  } catch (err) {
    console.error('Dispatch dedup query failed:', (err as Error).message);
    // Fail CLOSED: a Notion hiccup here must not risk a duplicate dispatch —
    // safer to ask for a retry than to skip the dedup check.
    return html('Could Not Check',
      '<h1>Could Not Check for Existing Work</h1><p>Tap the link again in a minute.</p>' + backLink, 502);
  }
  if (existing) {
    return html('Already Being Fixed',
      '<h1>Already Being Fixed</h1><p>A session is already working on this (or waiting to start).</p>' +
      (existing.url ? `<p><a href="${sanitize(existing.url, 300)}">Open the card</a></p>` : '') + backLink);
  }

  try {
    const created = await createDispatchCard({ conditionKey, title, description }, notionKey);
    return html('Dispatched',
      '<h1>On it!</h1><p>A session will start on this within a few minutes — you\'ll see progress on the card.</p>' +
      (created.url ? `<p><a href="${sanitize(created.url, 300)}">Watch the card</a></p>` : '') + backLink);
  } catch (err) {
    console.error('Dispatch card create failed:', (err as Error).message);
    return html('Could Not Start the Fix',
      '<h1>Could Not Start the Fix</h1><p>Tap the link again in a minute.</p>' + backLink, 502);
  }
}
