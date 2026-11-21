#!/usr/bin/env node
'use strict';
/**
 * route-limbo-reviews.js (BRO-7930): give every "limbo" review-text file a recorded route.
 * Limbo = usable text, no exclusion flag, no score, no decision (scripts/lib/limbo-gate.js). After the
 * grace window each one is routed to reject / scoring / refetch and stamped limboRoute.
 *
 *   node scripts/route-limbo-reviews.js [--apply] [--all-shows] [--days=760] [--show=ID] [--list] [--check]
 *
 * Dry run by default. --check exits 1 when any file past the grace window is still unrouted (the class guard:
 * run it after --apply, or alone in CI/health checks). Called by replay-pending-bylines.js sweeps with apply.
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { GRACE_DAYS, classifyLimbo, applyDecision, misattributedWetRoundup } = require('./lib/limbo-gate');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { isReviewTextFile } = require('./lib/review-text-sidecars');

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/shows.json'), 'utf8'));
  return Array.isArray(raw) ? raw : raw.shows || [];
}

/** Shows in scope: opened within `days` (default 760) and not regional-only; --all-shows widens to everything. */
function inScope(show, { allShows, days, nowMs, only }) {
  if (only) return show.id === only;
  if (allShows) return true;
  const opened = Date.parse(show.openingDate || '');
  return Number.isFinite(opened) && nowMs - opened <= days * 864e5 && opened <= nowMs + 30 * 864e5;
}

function routeLimbo({ apply = false, allShows = false, days = 760, only = null, graceDays = GRACE_DAYS, nowMs = Date.now(), root = resolveReviewTextsDir(), shows = loadShows(), log = () => {}, guards } = {}) {
  const { safeWriteReview } = require('./lib/review-write-guard');
  const counts = { scanned: 0, routed: 0, grace: 0, byRoute: {}, byRule: {}, writeFailed: 0 };
  const rows = [];
  for (const show of shows) {
    if (!inScope(show, { allShows, days, nowMs, only })) continue;
    const dir = path.join(root, show.id);
    let names;
    try { names = fs.readdirSync(dir).filter(isReviewTextFile); } catch { continue; }
    for (const f of names) {
      const filePath = path.join(dir, f);
      let d, mtimeMs = 0;
      try { d = JSON.parse(fs.readFileSync(filePath, 'utf8')); mtimeMs = fs.statSync(filePath).mtimeMs; } catch { continue; }
      counts.scanned++;
      const dec = misattributedWetRoundup(d, guards) || classifyLimbo(d, show, filePath, { nowMs, mtimeMs, graceDays, guards });
      if (!dec) continue;
      if (dec.route === 'grace') { counts.grace++; continue; }
      if (d.limboRoute === dec.route && d.limboRule === (dec.rule || null)) { counts.unchanged = (counts.unchanged || 0) + 1; continue; } // re-judged, same answer: already routed
      rows.push({ showId: show.id, file: f, route: dec.route, rule: dec.rule, url: d.url });
      counts.byRoute[dec.route] = (counts.byRoute[dec.route] || 0) + 1;
      counts.byRule[dec.rule] = (counts.byRule[dec.rule] || 0) + 1;
      if (!apply) continue;
      try {
        const res = safeWriteReview(filePath, applyDecision(d, dec, new Date(nowMs).toISOString()));
        if (res && res.lockedSkipped) counts.writeFailed++; else counts.routed++;
      } catch (e) { counts.writeFailed++; log(`  limbo write failed ${show.id}/${f}: ${e.message}`); }
    }
  }
  if (!apply) counts.routed = 0;
  return { counts, rows, graceDays };
}

module.exports = { routeLimbo, inScope };

if (require.main === module) {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) {
    console.log('Usage: node scripts/route-limbo-reviews.js [--apply] [--all-shows] [--days=760] [--show=ID] [--list] [--check]\nRoutes every unflagged, unscored review file past the grace window to reject / scoring / refetch (BRO-7930). Dry run unless --apply.');
    process.exit(0);
  }
  const opt = n => (args.find(a => a.startsWith(`--${n}=`)) || '').split('=')[1];
  const apply = args.includes('--apply');
  const r = routeLimbo({ apply, allShows: args.includes('--all-shows'), days: Number(opt('days')) || 760, only: opt('show') || null, log: console.log });
  if (args.includes('--list')) for (const x of r.rows) console.log(`${x.route}\t${x.rule}\t${x.showId}/${x.file}\t${(x.url || '').slice(0, 90)}`);
  console.log(`limbo gate${apply ? '' : ' [DRY RUN]'}: scanned ${r.counts.scanned}; past-grace limbo ${r.rows.length}${apply ? `; routed ${r.counts.routed}; write-failed/locked ${r.counts.writeFailed}` : ''}; within ${r.graceDays}d grace ${r.counts.grace}`);
  console.log(`  by route: ${JSON.stringify(r.counts.byRoute)}\n  by rule: ${JSON.stringify(r.counts.byRule)}`);
  if (args.includes('--check')) {
    // After --apply nothing past the grace window may be left unrouted.
    const left = apply ? r.counts.writeFailed : r.rows.length;
    if (left > 0) { console.error(`FAIL: ${left} limbo file(s) past the ${r.graceDays}-day grace window have no route`); process.exit(1); }
    console.log('OK: no unrouted limbo files');
  }
}
