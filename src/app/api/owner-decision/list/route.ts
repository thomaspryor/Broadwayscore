import { NextRequest } from 'next/server';
import * as linkModule from '@/lib/owner-decision-link';
import { esc, page, notice, linearGraphql, rateLimited, evidenceHtml } from '@/lib/owner-decision-page';

// BRO-6235: one private page listing every decision waiting on the owner.
// Read-only. Each option is a GET link to the existing confirm page
// (/api/owner-decision), which still requires the Confirm POST before anything
// is saved. The list token (HMAC, own domain) is minted by the decision emails
// and the morning digest; per-decision tokens are minted here, capped at the
// list token's own expiry. See src/lib/owner-decision-link.js.

type Graphql = (query: string, variables: Record<string, unknown>) => Promise<any>;
const link = linkModule as unknown as {
  LIST_QUERY: string;
  verifyListToken: (token: string | null, secret: string, now?: number) => { ok: boolean; reason?: string; expires?: number };
  mintDecisionToken: (args: { id: string; hash: string; secret: string; listExpires?: number }) => string;
  listOpenDecisions: (issues: unknown[]) => any[] & { omitted?: number };
};
const { verifyListToken, mintDecisionToken, listOpenDecisions, LIST_QUERY } = link;

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 20;

// Short in-process cache so a refresh loop or a mail scanner cannot spend the
// shared Linear quota; a fresh answer shows within a minute.
const CACHE_MS = 60_000;
let cache: { at: number; issues: unknown[] } | null = null;

async function openIssues(): Promise<unknown[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.issues;
  const data = await (linearGraphql as Graphql)(LIST_QUERY, { teamKey: 'BRO' });
  const issues = (data && data.issues && data.issues.nodes) || [];
  cache = { at: Date.now(), issues };
  return issues;
}

export async function GET(req: NextRequest) {
  if (process.env.OWNER_DECISION_LINKS_DISABLED === 'true' || process.env.OWNER_DECISION_LIST_DISABLED === 'true') {
    return notice('Paused', 'The decisions list is switched off for now. Nothing was changed.', 503);
  }
  if (rateLimited(req)) return notice('Slow down', 'Too many tries. Wait a few minutes and open the link again.', 429);
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) return notice('Not set up', 'This page is not configured yet. Nothing was changed.', 500);
  const v = verifyListToken(req.nextUrl.searchParams.get('t'), secret);
  if (!v.ok) {
    if (v.reason === 'expired') return notice('Link expired', 'This link has expired. Open the latest decisions email or the morning digest for a fresh one.', 410);
    return notice('Link not valid', 'This link could not be verified. Nothing was changed.', 400);
  }

  let decisions: any[] & { omitted?: number };
  try {
    decisions = listOpenDecisions(await openIssues());
  } catch (e) {
    console.error('[owner-decision-list]', e instanceof Error ? e.message : e);
    return notice('Could not load the list', 'Something went wrong talking to the board. Nothing was changed. Try again in a minute.', 502);
  }

  if (!decisions.length) {
    return page('Decisions', '<h1>Nothing is waiting on you</h1><p>Every question has been answered. This page updates within a minute of a new one.</p>');
  }

  const cards = decisions.map((d) => {
    const token = mintDecisionToken({ id: d.identifier, hash: d.hash, secret, listExpires: v.expires });
    const base = `/api/owner-decision?t=${encodeURIComponent(token)}`;
    const b = d.block;
    const options = b.options.length >= 2
      ? b.options.map((o: any) => `<p class="opt">${esc(o.label)}: ${esc(o.name)}</p>${o.upside ? `<p class="up">Upside: ${esc(o.upside)}</p>` : ''}${o.downside ? `<p class="down">Downside: ${esc(o.downside)}</p>` : ''}<a class="btn" href="${base}&o=${encodeURIComponent(o.key)}">Choose ${esc(o.label)}</a>`).join('')
      : d.choices.map((c: any) => `<a class="btn" href="${base}&o=${encodeURIComponent(c.key)}">${esc(c.label)}</a>`).join('');
    return `<section class="box"><p class="q">${esc(d.question)}</p>
${d.title && d.title !== d.question ? `<p class="small">About: ${esc(d.title)}</p>` : ''}
${evidenceHtml(b.evidence)}
${b.why ? `<p><strong>${b.task ? 'Why Claude cannot do this itself' : 'Why this is your call'}:</strong> ${esc(b.why)}</p>` : ''}
${b.task ? `<ol>${(b.steps || []).map((st: string) => `<li>${esc(st)}</li>`).join('')}</ol>` : ''}
${options}
${b.recommendation ? `<p><strong>My recommendation:</strong> ${esc(b.recommendation)}</p>` : ''}
${b.defaultText ? `<p class="small"><strong>If you do not answer:</strong> ${esc(b.defaultText)}</p>` : ''}
<a class="btn alt" href="${base}&o=own">Reply in my own words</a>
<p class="small">Card ${esc(d.identifier)}${d.url ? ` · <a href="${esc(d.url)}" rel="noreferrer">open</a>` : ''}</p></section>`;
  }).join('');
  const n = decisions.length;
  return page('Decisions', `<h1>${n} ${n === 1 ? 'decision is' : 'decisions are'} waiting on you</h1><p class="small">Most urgent first. Tapping an option opens a page that asks you to confirm before anything is saved.</p>${cards}${decisions.omitted ? `<p class="small">${decisions.omitted} more not shown here. Answer these first and refresh.</p>` : ''}`);
}
