import { NextRequest } from 'next/server';
import { CONFIRM_FIELD_HTML, readConfirmedForm } from '@/lib/confirm-post';
import * as linkModule from '@/lib/owner-decision-link';
import { esc, page, notice, linearGraphql, rateLimited, evidenceHtml } from '@/lib/owner-decision-page';

// The shared module is plain CJS JavaScript (scripts require it too), so its
// return shapes are typed here instead of inferred from every branch.
type Graphql = (query: string, variables: Record<string, unknown>) => Promise<any>;
const link = linkModule as unknown as {
  MAX_ANSWER_CHARS: number;
  verifyToken: (token: string | null, secret: string, now?: number) => any;
  loadDecision: (args: { graphql: Graphql; id: string; hash: string; secret: string }) => Promise<any>;
  recordAnswer: (args: { graphql: Graphql; id: string; hash: string; secret: string; choiceKey: string; text: string; via?: string }) => Promise<any>;
};
const { verifyToken, loadDecision, recordAnswer, MAX_ANSWER_CHARS } = link;

// BRO-6147: tap-to-answer page behind the owner's decision emails.
// GET only ever shows a choice; the POST behind its Confirm button writes,
// because mail-security scanners open every link in an email. The signed token
// (scripts/send-owner-decision-emails.js mints it) names one card and one
// question; everything shown comes from the live card. See
// src/lib/owner-decision-link.js for the security model.

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

function gate(req: NextRequest, tokenRaw: string | null): { id: string; hash: string; token: string } | Response {
  if (process.env.OWNER_DECISION_LINKS_DISABLED === 'true') {
    return notice('Paused', 'Decision links are switched off for now. Nothing was changed. Answer on the Linear card instead.', 503);
  }
  if (rateLimited(req)) return notice('Slow down', 'Too many tries. Wait a few minutes and open the link again.', 429);
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) return notice('Not set up', 'This page is not configured yet. Nothing was changed.', 500);
  const v = verifyToken(tokenRaw, secret);
  if (!v.ok) {
    if (v.reason === 'expired') return notice('Link expired', 'This link has expired. Nothing was changed. Open the latest decisions email (or the morning digest) for a fresh link if the decision is still open.', 410);
    return notice('Link not valid', 'This link could not be verified. Nothing was changed.', 400);
  }
  return { id: v.id as string, hash: v.hash as string, token: tokenRaw as string };
}

type Loaded = any;

function recordedPage(l: Loaded): Response {
  return page('Already answered', `<h1>Already answered</h1><p>This decision was recorded on the card. Nothing changes if you tap again.</p>
<div class="box"><pre>${esc((l as { recorded?: string }).recorded || '')}</pre></div>
<p class="small">Card: ${esc(l.issue?.identifier)} ${esc(l.issue?.title)}</p>`);
}

function staleNotice(l: Loaded): Response {
  const url = typeof l.issue?.url === 'string' && l.issue.url.startsWith('https://linear.app/') ? `<p><a href="${esc(l.issue.url)}" rel="noreferrer">Open the card</a></p>` : '';
  return page('Already handled', `<h1>Nothing to answer</h1><p>This question was changed or is no longer waiting on you. Nothing was changed.</p>${url}`);
}

function failure(err: unknown): Response {
  console.error('[owner-decision]', err instanceof Error ? err.message : err);
  return notice('Could not record that', 'Something went wrong talking to the board. Nothing was changed. Tap the link again in a minute.', 502);
}

export async function GET(req: NextRequest) {
  const tokenRaw = req.nextUrl.searchParams.get('t');
  const g = gate(req, tokenRaw);
  if (g instanceof Response) return g;
  const secret = process.env.APPROVAL_HMAC_SECRET as string;
  let l: Loaded;
  try {
    l = await loadDecision({ graphql: linearGraphql, id: g.id, hash: g.hash, secret });
  } catch (e) { return failure(e); }
  if (l.status === 'missing') return notice('Link not valid', 'This link could not be verified. Nothing was changed.', 400);
  if (l.status === 'answered') return recordedPage(l);
  if (l.status !== 'open') return staleNotice(l);

  const open = l as Extract<Loaded, { status: 'open' }>;
  const choice = req.nextUrl.searchParams.get('o') || '';
  const form = (inner: string) => `<form method="POST" action="/api/owner-decision"><input type="hidden" name="t" value="${esc(g.token)}">${CONFIRM_FIELD_HTML}${inner}</form>`;
  // BRO-6654: a task card (Owner step lines) shows its steps, so the Done page reads on its own.
  const task = (open.block as { task?: boolean; steps?: string[] }).task === true;
  const steps = task ? `<ol>${((open.block as { steps?: string[] }).steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '';
  const head = `<h1>${task ? 'Your task' : 'Your decision'}</h1><p class="q">${esc(open.question)}</p>${steps}<p class="small">Card: ${esc(open.issue.identifier)} ${esc(open.issue.title)}</p>${evidenceHtml((open.block as { evidence?: { label: string; url: string }[] }).evidence)}`;

  if (choice === 'own') {
    return page(task ? 'Your task' : 'Your decision', `${head}${form(`<input type="hidden" name="choice" value="own"><textarea name="text" maxlength="${MAX_ANSWER_CHARS}" required placeholder="Type your answer here" aria-label="Your answer"></textarea><button type="submit">Send my answer</button>`)}`);
  }
  const picked = open.choices.find((c: { key: string }) => c.key === choice);
  if (picked) {
    const block = open.block.options.find((o: { key: string }) => o.key === picked.key) as { name: string; upside: string; downside: string } | undefined;
    const detail = block ? `<div class="box"><p><strong>${esc(block.name)}</strong></p>${block.upside ? `<p class="small">Upside: ${esc(block.upside)}</p>` : ''}${block.downside ? `<p class="small">Downside: ${esc(block.downside)}</p>` : ''}</div>` : '';
    return page('Confirm your answer', `${head}<p>You picked <strong>${esc(picked.label)}</strong>.</p>${detail}${form(`<input type="hidden" name="choice" value="${esc(picked.key)}"><button type="submit">Confirm: ${esc(picked.short)}</button>`)}<p class="small">Nothing is saved until you press Confirm.</p>`);
  }
  // No (or unknown) option: show them all, GET links only.
  const base = `/api/owner-decision?t=${encodeURIComponent(g.token)}`;
  const buttons = open.choices.map((c: { key: string; label: string }) => `<a class="btn" href="${base}&o=${encodeURIComponent(c.key)}">${esc(c.label)}</a>`).join('');
  return page(task ? 'Your task' : 'Your decision', `${head}${buttons}<a class="btn alt" href="${base}&o=own">Reply in my own words</a>`);
}

export async function POST(req: NextRequest) {
  const form = await readConfirmedForm(req);
  const tokenRaw = form ? String(form.get('t') || '') : null;
  const g = gate(req, tokenRaw);
  if (g instanceof Response) return g;
  if (!form) return notice('Not confirmed', 'Open the link from your email and press the button on that page. Nothing was changed.', 400);
  const secret = process.env.APPROVAL_HMAC_SECRET as string;
  const choiceKey = String(form.get('choice') || '').slice(0, 20);
  const text = String(form.get('text') || '');
  try {
    const r = await recordAnswer({ graphql: linearGraphql, id: g.id, hash: g.hash, secret, choiceKey, text });
    if (r.status === 'answered') return recordedPage(r);
    if (r.status === 'bad-choice') return notice('Not recognised', 'That choice is not one of the options. Nothing was changed.', 400);
    if (r.status === 'empty') return notice('Nothing typed', 'Go back and type your answer. Nothing was changed.', 400);
    if (r.status !== 'recorded') return staleNotice(r);
    const card = r.issue ? `<p class="small">Card: ${esc(r.issue.identifier)} ${esc(r.issue.title)}</p>` : '';
    return page('Recorded', `<h1>Recorded</h1><p>Your answer is saved on the card: <strong>${esc(r.answer?.label)}</strong>.</p><p>Claude picks the card up from the board and carries on. You do not need to do anything else.</p>${card}`);
  } catch (e) { return failure(e); }
}
