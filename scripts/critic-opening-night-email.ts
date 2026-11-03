#!/usr/bin/env npx tsx
/**
 * BRO-6895 phase 3: optional opening-night "your review is in" email to claimed
 * critics who ticked the box in their editor. Transactional (one Resend email
 * per critic per show), NEVER a broadcast (CLAUDE.md section 17).
 *
 * Usage:
 *   npx tsx scripts/critic-opening-night-email.ts                  dry run: list who would be emailed
 *   npx tsx scripts/critic-opening-night-email.ts --send-to=me@x   send ONE sample to that address, record nothing
 *   npx tsx scripts/critic-opening-night-email.ts --send --yes     email the real critics and record each in the ledger
 *
 * Options: --window=DAYS (default 3), --max=N (default 25 real sends per run).
 * Needs NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and (to send) RESEND_API_KEY.
 */
import { getCriticBySlug } from '../src/lib/data-reviews';
import { selectNoticeReviews } from '../src/lib/critic-claim';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const has = (n: string) => process.argv.includes(`--${n}`);
const SB = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SEND_TO = arg('send-to');
const REAL = has('send') && has('yes');
const WINDOW = Number(arg('window') || 3);
const MAX = Number(arg('max') || 25);

async function sb(path: string, init: RequestInit = {}) {
  const res = await fetch(`${SB}${path}`, { ...init, headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  if (!res.ok) throw new Error(`Supabase ${path} -> ${res.status}`);
  return res;
}

function compose(name: string, showTitle: string, outlet: string, slug: string) {
  const url = `https://broadwayscorecard.com/critics/${slug}`;
  const first = name.split(' ')[0];
  return {
    subject: `Your ${showTitle} review is on Broadway Scorecard`,
    html: `<p>Hi ${first},</p>
<p>Your ${showTitle} review for ${outlet} is now on Broadway Scorecard, with its score, on your page: <a href="${url}">${url}</a></p>
<p>You asked for this note from your page. To stop it, open your page, choose Edit your page and untick the opening-night email box.</p>
<p>Broadway Scorecard</p>`,
  };
}

async function send(to: string, subject: string, html: string) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: 'Broadway Scorecard <critics@broadwayscorecard.com>', to: [to], subject, html }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}`);
}

async function main() {
  if (!SB || !KEY) { console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.'); process.exit(2); }
  const claims = (await (await sb('/rest/v1/critic_claims?status=eq.approved&notify_opening_night=eq.true&select=critic_slug,contact_email')).json()) as { critic_slug: string; contact_email: string }[];
  const ledger = (await (await sb('/rest/v1/critic_opening_notices?select=critic_slug,show_slug&limit=100000')).json()) as { critic_slug: string; show_slug: string }[];
  const sentBy = new Map<string, Set<string>>();
  for (const l of ledger) { if (!sentBy.has(l.critic_slug)) sentBy.set(l.critic_slug, new Set()); sentBy.get(l.critic_slug)!.add(l.show_slug); }

  const todo: { slug: string; to: string; name: string; outlet: string; showSlug: string; showTitle: string }[] = [];
  for (const c of claims) {
    const critic = getCriticBySlug(c.critic_slug);
    if (!critic) continue;
    for (const r of selectNoticeReviews(critic.reviews, sentBy.get(c.critic_slug) || new Set(), Date.now(), WINDOW)) {
      todo.push({ slug: c.critic_slug, to: c.contact_email, name: critic.name, outlet: critic.primaryOutlet, showSlug: r.showSlug, showTitle: r.showTitle });
    }
  }
  console.log(`${claims.length} opted-in critic(s), ${todo.length} email(s) due (window ${WINDOW}d).`);
  for (const t of todo) console.log(`  ${t.slug} <- ${t.showTitle}${REAL ? ` -> ${t.to}` : ''}`);

  if (SEND_TO) {
    const t = todo[0] || { slug: 'sample-critic', name: 'Sample Critic', outlet: 'Sample Outlet', showSlug: 'sample', showTitle: 'Sample Show', to: SEND_TO };
    const m = compose(t.name, t.showTitle, t.outlet, t.slug);
    await send(SEND_TO, `[TEST] ${m.subject}`, m.html);
    console.log(`Sent one sample to ${SEND_TO}. Nothing recorded.`);
    return;
  }
  if (!REAL) { console.log('Dry run. Nothing sent. Real sends need --send --yes.'); return; }
  let n = 0;
  for (const t of todo.slice(0, MAX)) {
    const m = compose(t.name, t.showTitle, t.outlet, t.slug);
    // Record first (the primary key dedupes), then send; undo the record if the send fails so a rerun retries.
    await sb('/rest/v1/critic_opening_notices', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ critic_slug: t.slug, show_slug: t.showSlug }) });
    try { await send(t.to, m.subject, m.html); }
    catch (err) {
      await sb(`/rest/v1/critic_opening_notices?critic_slug=eq.${encodeURIComponent(t.slug)}&show_slug=eq.${encodeURIComponent(t.showSlug)}`, { method: 'DELETE' });
      throw err;
    }
    n++;
  }
  console.log(`Sent ${n} email(s).`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
