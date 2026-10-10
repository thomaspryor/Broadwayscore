#!/usr/bin/env node
/**
 * impact-payout-readout.js — why do some TodayTix orders pay $0 commission?
 * (BRO-4967). Read-only: pulls Impact Actions for the last N days (paging
 * through every page), marks which visitor IDs belong to the owner (PostHog
 * visitor IDs whose events carry is_owner=true), and prints aggregate breakdowns of $0-payout
 * vs paid orders as markdown (stdout + GITHUB_STEP_SUMMARY when set).
 *
 * The repo's Actions logs are public: no customer, order or visitor
 * identifier is printed (see scripts/lib/impact-payout-readout.js).
 *
 * Usage: node scripts/impact-payout-readout.js [--days=44]
 * Needs IMPACT_ACCOUNT_SID, IMPACT_AUTH_TOKEN; POSTHOG_PERSONAL_API_KEY optional
 * (without it the owner match is skipped).
 */
'use strict';

const fs = require('fs');
const { summarizeZeroPayout, renderMarkdown } = require('./lib/impact-payout-readout');
const { IMPACT_MAX_DAYS, fetchImpactActionsWindow } = require('./lib/affiliate-stats');
const { hasHelpFlag } = require('./lib/cli-help');

const USAGE = `impact-payout-readout.js — why do some TodayTix orders pay $0 commission?

Read-only. Prints aggregate breakdowns of $0-commission vs paid Impact orders.

Options:
  --days=N   Days back to read (default and max 44)
  --help     Show this message`;

const MAX_PAGES = 50;

function arg(name, dflt) {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

async function fetchAllActions(days) {
  const sid = process.env.IMPACT_ACCOUNT_SID;
  const token = process.env.IMPACT_AUTH_TOKEN;
  if (!sid || !token) throw new Error('IMPACT_ACCOUNT_SID / IMPACT_AUTH_TOKEN missing');
  const auth = 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64');
  // Exactly `days` wide: Impact rejects ranges over IMPACT_MAX_DAYS.
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  const iso = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  let next = `/Mediapartners/${sid}/Actions.json?StartDate=${iso(start)}&EndDate=${iso(end)}&PageSize=100`;
  const actions = [];
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    const res = await fetch(`https://api.impact.com${next}`, {
      headers: { Authorization: auth, Accept: 'application/json' },
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`Impact Actions HTTP ${res.status}`);
    const data = await res.json();
    // Impact can answer 200 with an error body; never read that as "0 actions".
    if (data.Status === 'ERROR') throw new Error(`Impact Actions error: ${data.Message || 'Status ERROR'}`);
    actions.push(...(data.Actions || []));
    pages += 1;
    next = data['@nextpageuri'] || '';
  }
  return { actions, pages, incomplete: Boolean(next) };
}

// Optional: a PostHog failure costs only the owner-match line, never the readout.
async function fetchOwnerIds(days) {
  if (!process.env.POSTHOG_PERSONAL_API_KEY) return { ids: new Set(), note: 'POSTHOG_PERSONAL_API_KEY not set, owner match skipped' };
  try {
    const { phQuery } = require('./lib/posthog-query');
    // is_owner is an event super-property (no person profile). An affiliate
    // order's SubId1 is the distinct_id stamped on the ticket CTA, so only the
    // owner's ticket_click events matter. Scanning every owner event timed out
    // in PostHog twice (runs 38039845828, 38041741433).
    const rows = await phQuery(`
      SELECT DISTINCT distinct_id FROM events
      WHERE event = 'ticket_click'
        AND JSONExtractString(properties, 'is_owner') = 'true'
        AND timestamp >= now() - INTERVAL ${Number(days) + 2} DAY
      LIMIT 10000`);
    return { ids: new Set(rows.map((r) => String(r[0]))), note: `${rows.length} owner visitor IDs in PostHog` };
  } catch (err) {
    return { ids: new Set(), note: `PostHog lookup failed (${String(err.message).slice(0, 120)}), owner match skipped` };
  }
}

// What the production revenue code sees for the same window (one request,
// Impact's default page size), so the readout can say whether it undercounts.
async function singlePageCount(days) {
  try {
    return (await fetchImpactActionsWindow(days, { timeoutMs: 30000 })).length;
  } catch (err) {
    console.error(`fetchImpactActionsWindow comparison failed: ${err.message}`);
    return null;
  }
}

// 44, not Impact's 45-day cap: fetchImpactActionsWindow (the comparison
// below) adds a day of headroom past now, and both reads must cover the
// same orders for the comparison to mean anything.
const MAX_READOUT_DAYS = IMPACT_MAX_DAYS - 1;

async function main() {
  if (hasHelpFlag(process.argv.slice(2))) {
    console.log(USAGE);
    return;
  }
  const days = Math.min(Math.max(parseInt(arg('days', String(MAX_READOUT_DAYS)), 10) || MAX_READOUT_DAYS, 1), MAX_READOUT_DAYS);
  const [{ actions, pages, incomplete }, owner, single] = await Promise.all([
    fetchAllActions(days),
    fetchOwnerIds(days),
    singlePageCount(days),
  ]);
  const summary = summarizeZeroPayout(actions, owner.ids);
  const md = renderMarkdown(summary, {
    windowLabel: `last ${days} days`,
    pages,
    incomplete,
    singlePageCount: single === null ? undefined : single,
  }) + `\n\nOwner match: ${owner.note}.\n`;
  console.log(md);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('impact-payout-readout failed:', err.message);
    process.exit(1);
  });
}
