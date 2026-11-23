#!/usr/bin/env node
'use strict';
/**
 * recover-pending-subscriber-browser.js (BRO-8195): drain paywalled _pending stubs through the logged-in
 * browser, for every outlet with a browser adapter (scripts/lib/browser-outlet-adapters.js: ft, telegraph,
 * wsj, nyt, thetimes, wapo, newyorker, thestage). The paid scraper cannot read these pages, so the drain
 * settles them as subscriber-fetch-failed (pending-triage.js); this hands the drain the logged-in page's
 * html instead (browser-recovery-helpers.js processPendingCandidate: every drain check still applies).
 * Only _pending stubs: show-file recovery stays with recover-*-browser.js and the gap-recovery driver.
 *
 *   node scripts/recover-pending-subscriber-browser.js                       # every subscriber outlet
 *   node scripts/recover-pending-subscriber-browser.js --outlets=ft --shows=tosca-off-broadway-2026
 *   node scripts/recover-pending-subscriber-browser.js --dry-run
 */
require('./lib/cli-help').exitOnHelp(module);

const { ADAPTERS, openSession } = require('./lib/browser-outlet-adapters');
const { SUBSCRIBER_OUTLETS } = require('./lib/pending-triage');
const H = require('./lib/browser-recovery-helpers');

const argv = process.argv.slice(2);
const arg = (n) => { const h = argv.find((a) => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const dryRun = argv.includes('--dry-run');
const outletsArg = arg('outlets');
const showsArg = arg('shows');

/** Adapters to run: named ones, else every adapter serving a subscriber outlet. Pure. */
function adaptersToRun(names) {
  return Object.entries(ADAPTERS)
    .filter(([name, a]) => (names ? names.includes(name) : a.outletIds.some((o) => SUBSCRIBER_OUTLETS.has(o))))
    .map(([name, a]) => ({ name, ...a }));
}

async function main() {
  const adapters = adaptersToRun(outletsArg ? outletsArg.split(',') : null);
  const showsAllowlist = showsArg ? new Set(showsArg.split(',')) : null;
  const plan = adapters.map((a) => ({ a, cands: H.loadCandidates({ filePrefix: a.outletIds, showsAllowlist, includePending: true }).filter((c) => c.pending) }))
    .filter((p) => p.cands.length);
  console.log(`${plan.reduce((n, p) => n + p.cands.length, 0)} paywalled _pending stub(s) across ${plan.map((p) => `${p.a.name}:${p.cands.length}`).join(', ') || 'no outlet'}`);
  if (!plan.length) return;
  H.acquireRecoveryRunLock('recover-pending-subscriber-browser');
  if (!dryRun) H.startRun();
  const stats = { recovered: 0, dryRun, outcomes: {} };
  let runError = null;
  try {
    for (const { a, cands } of plan) {
      const open = await openSession(a);
      if (!open.ok) { console.log(`[${a.name}] session not opened (${open.outcome}: ${open.reason}); ${cands.length} stub(s) left as they are`); continue; }
      const s = open.session;
      try {
        for (const c of cands) {
          let r;
          try { r = await s.extract(c.url); } catch (e) { r = { error: e.message }; }
          if (r.error || !r.text) { console.log(`  [${c.reviewId}] ${r.error || 'no text'} (not stamped)`); stats.outcomes.skipped = (stats.outcomes.skipped || 0) + 1; continue; }
          let pr;
          try { pr = await H.processPendingCandidate(c, await s.page.content(), { dryRun, finalUrl: s.page.url(), textLen: r.len }); } catch (e) { pr = { outcome: 'error', detail: e.message }; }
          console.log(`  [${c.reviewId}] ${pr.outcome}${pr.detail ? ` (${pr.detail})` : ''}`);
          stats.outcomes[pr.outcome] = (stats.outcomes[pr.outcome] || 0) + 1;
          if (pr.outcome === 'promoted') stats.recovered++;
        }
      } finally { await s.close(); }
    }
    if (!dryRun) H.checkpoint(stats, 'Subscriber browser _pending drain (BRO-8195)');
  } catch (e) { runError = e; }
  console.log(`Outcomes: ${JSON.stringify(stats.outcomes)}`);
  if (runError) throw runError;
}

module.exports = { adaptersToRun };
if (require.main === module) main().catch((e) => { console.error(`FATAL: ${e.message}`); process.exit(1); });
