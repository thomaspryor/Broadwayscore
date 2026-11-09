#!/usr/bin/env npx tsx
/**
 * critic-reach.ts (BRO-6984): for each critic page with an approved claim,
 * count the unique people who visited any show page featuring that critic's
 * reviews in the last 30 days (PostHog $pageview on /show/<slug>, Real Users
 * lens), and store one row per critic in Supabase `critic_reach`.
 * /api/critics/me reads it and shows it only to the page's owner.
 *
 * The number is unique across the critic's show pages (one HogQL query per
 * critic over the union of paths), not a sum. Only counts leave this script:
 * no person ids, no emails.
 *
 * Usage:
 *   npx tsx scripts/critic-reach.ts                  # claimed critics -> Supabase
 *   npx tsx scripts/critic-reach.ts --slugs=dan-rubins,jonathan-mandell --dry-run
 * Env: POSTHOG_PERSONAL_API_KEY; NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *      (not needed with --dry-run and --slugs).
 * Exit: 0 ok (including "no claimed critics"); 1 missing env or any failure.
 */
import { createRequire } from 'module';
import { getCriticBySlug } from '../src/lib/data-reviews';
import { showPathsFor, REACH_WINDOW_DAYS } from '../src/lib/critic-reach';

const require = createRequire(import.meta.url);
const { phQuery, REAL_USERS_WHERE } = require('./lib/posthog-query') as {
  phQuery: (hogql: string) => Promise<unknown[][]>;
  REAL_USERS_WHERE: string;
};

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,99}$/;
const HOSTS = ['broadwayscorecard.com', 'www.broadwayscorecard.com'];

export function reachQuery(paths: readonly string[], days = REACH_WINDOW_DAYS): string {
  // Paths come from showPathsFor (slug charset only), so quoting is safe.
  const list = paths.map(p => `'${p.replace(/[^a-z0-9/-]/g, '')}'`).join(', ');
  return `
    SELECT count(DISTINCT person_id) AS people, count() AS views
    FROM events
    WHERE event = '$pageview'
      AND timestamp > now() - INTERVAL ${Math.floor(days)} DAY
      AND properties.$host IN (${HOSTS.map(h => `'${h}'`).join(', ')})
      AND replaceRegexpOne(properties.$pathname, '/+$', '') IN (${list})
      AND ${REAL_USERS_WHERE.trim()}`;
}

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required');
  return fetch(`${url}${path}`, {
    ...init,
    headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(30000),
  });
}

async function claimedSlugs(): Promise<string[]> {
  const res = await sb('/rest/v1/critic_claims?status=eq.approved&select=critic_slug');
  if (!res.ok) throw new Error(`critic_claims read failed: HTTP ${res.status}`);
  return [...new Set(((await res.json()) as { critic_slug: string }[]).map(r => r.critic_slug))].filter(s => SLUG_RE.test(s));
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const slugArg = args.find(a => a.startsWith('--slugs='))?.slice('--slugs='.length);
  if (!process.env.POSTHOG_PERSONAL_API_KEY) { console.error('POSTHOG_PERSONAL_API_KEY not set'); process.exit(1); }
  const slugs = slugArg ? slugArg.split(',').map(s => s.trim()).filter(s => SLUG_RE.test(s)) : await claimedSlugs();
  if (slugs.length === 0) { console.log('No claimed critic pages; nothing to do.'); return; }

  const rows: { critic_slug: string; people: number; views: number; show_pages: number; computed_at: string }[] = [];
  let failed = 0;
  for (const slug of slugs) {
    const critic = getCriticBySlug(slug);
    if (!critic) { console.error(`${slug}: no such critic page, skipped`); continue; }
    const paths = showPathsFor(critic.reviews);
    if (paths.length === 0) continue;
    try {
      const [[people, views] = [0, 0]] = await phQuery(reachQuery(paths));
      rows.push({ critic_slug: critic.slug, people: Number(people) || 0, views: Number(views) || 0, show_pages: paths.length, computed_at: new Date().toISOString() });
      console.log(`${critic.slug}: ${people} people, ${views} views across ${paths.length} show pages`);
    } catch (e) {
      failed++;
      console.error(`${slug}: PostHog query failed: ${e instanceof Error ? e.message : e}`);
    }
  }

  if (dry) { console.log(`--dry-run: ${rows.length} rows not written`); }
  else if (rows.length) {
    const res = await sb('/rest/v1/critic_reach?on_conflict=critic_slug', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
    if (res.status === 404) {
      // The critic_reach table comes from migration 20261104; until it is applied, warn and skip.
      console.warn('::warning::critic_reach table not found (migration 20261104_critic_requests_kinds.sql not applied yet); counts not stored.');
      return;
    }
    if (!res.ok) throw new Error(`critic_reach upsert failed: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    console.log(`Stored ${rows.length} rows in critic_reach.`);
  }
  if (failed) process.exit(1);
}

const isMain = process.argv[1] && /critic-reach\.ts$/.test(process.argv[1]);
if (isMain) main().catch(e => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
