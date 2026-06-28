#!/usr/bin/env node
'use strict';

/**
 * verify-opening-night-live.js — the post-deploy "is it ACTUALLY live?" check.
 *
 * The census audit (audit-opening-night-coverage.js) reconciles against
 * data/reviews.json — i.e. it confirms a review is SCORED. But "scored in
 * reviews.json" is not "rendering on broadwayscorecard.com": a rebuild can drop
 * it, a deploy can be cancelled (Vercel latest-build-wins), the data repo push
 * can be lost. That "green-but-not-live" class is invisible to every other check
 * (it bit us on 2026-06-28). This closes it by comparing local SCORED count vs
 * the live prod count (the slim `rv` array) per opening-window show.
 *
 * IMPORTANT — this is a VERIFY/ALERT step, NOT a gate inside the census loop.
 * It never re-dispatches a gather (the plan-review P0: reconcile-vs-prod inside
 * the close loop → re-close storm against deploy lag). To avoid false alarms on
 * NORMAL deploy lag (20-30 min), it uses STALENESS: a show must stay behind
 * across more than one run (firstSeenBehindAt older than --stale-minutes) before
 * it alerts — exactly the snapshot pattern check-opening-night-completeness uses.
 *
 * Usage:
 *   node scripts/verify-opening-night-live.js [--window-days=7] [--stale-minutes=40]
 *        [--alert] [--show=ID] [--now=ISO]   (--now for deterministic tests)
 */
const fs = require('fs');
const path = require('path');
const { decodeSlimShow } = require('./show-status');
const { dedupByCritic } = require('./lib/dedup-by-critic');

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, 'audit', 'opening-night-live-state.json');
const PROD_BASE = 'https://broadwayscorecard.com/data/shows';

const args = process.argv.slice(2);
const argNum = (name, dflt) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? parseInt(a.split('=')[1], 10) || dflt : dflt;
};
const argStr = (name) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.split('=').slice(1).join('=') : null;
};
const hasFlag = (n) => args.includes(`--${n}`);

function isWithinWindow(openingDate, now, windowDays) {
  if (!openingDate) return false;
  const diff = Math.abs(new Date(openingDate).getTime() - now.getTime());
  return diff <= windowDays * 24 * 60 * 60 * 1000;
}

/**
 * Pure: which shows are scored locally but under-represented live?
 * @param {Map<string,number>} localScored  showId -> scored review count (reviews.json)
 * @param {Map<string,number>} prodLive     showId -> live review count (prod rv)
 * @returns {Array<{showId,localScored,prodLive,delta}>}  only where local > prod
 */
function findLiveGaps(localScored, prodLive) {
  const gaps = [];
  for (const [showId, local] of localScored) {
    const live = prodLive.has(showId) ? prodLive.get(showId) : 0;
    if (local > live) gaps.push({ showId, localScored: local, prodLive: live, delta: local - live });
  }
  return gaps;
}

/**
 * Pure: should this gap alert NOW? Only if it has persisted longer than the
 * stale window (i.e. it's not just an in-flight deploy). Returns the updated
 * per-show state entry alongside the decision so the caller can persist it.
 * @returns {{alert:boolean, entry:{firstSeenBehindAt:string, delta:number}}}
 */
function shouldAlert(gap, prevEntry, nowMs, staleMinutes) {
  const firstSeen = prevEntry && prevEntry.firstSeenBehindAt
    ? new Date(prevEntry.firstSeenBehindAt).getTime()
    : nowMs;
  const ageMin = (nowMs - firstSeen) / 60000;
  return {
    alert: ageMin >= staleMinutes,
    entry: { firstSeenBehindAt: new Date(firstSeen).toISOString(), delta: gap.delta },
  };
}

async function fetchProdCount(showId) {
  try {
    const res = await fetch(`${PROD_BASE}/${showId}.json`);
    if (!res.ok) return null; // 404 = page not built yet; treat as unknown, skip
    return decodeSlimShow(await res.json()).reviews.length;
  } catch (_) { return null; }
}

async function main() {
  const windowDays = argNum('window-days', 7);
  const staleMinutes = argNum('stale-minutes', 40);
  const now = argStr('now') ? new Date(argStr('now')) : new Date();
  const nowMs = now.getTime();
  const onlyShow = argStr('show');

  const shows = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'shows.json'), 'utf8')).shows;
  // Load reviews EXACTLY as the prod rv builder does — loadReviewsWithBlog unions
  // blog-reviews-for-scoring.json. Raw reviews.json alone would miscount vs prod.
  const reviews = (() => {
    try { return require('./lib/load-reviews-with-blog').loadReviewsWithBlog(); }
    catch (_) {
      const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'reviews.json'), 'utf8'));
      return Array.isArray(raw) ? raw : raw.reviews || Object.values(raw);
    }
  })();

  let targets = shows.filter((s) => s.status === 'open' && isWithinWindow(s.openingDate, now, windowDays));
  if (onlyShow) targets = shows.filter((s) => (s.id || s.slug) === onlyShow);
  if (targets.length === 0) { console.log('[live-verify] No shows in window — nothing to check.'); return; }

  // Local "would be live" count == prod rv: dedup to one review per (outlet,critic)
  // via the SHARED helper the rv builder uses, THEN keep assignedScore != null.
  // Counting raw rows instead would over-count any multi-critic-per-outlet show and
  // alert forever (ship-check P0, 2026-06-28).
  const localScored = new Map();
  for (const s of targets) {
    const id = s.id || s.slug;
    const showReviews = dedupByCritic(reviews.filter((r) => (r.showId || r.show) === id));
    localScored.set(id, showReviews.filter((r) => r.assignedScore != null).length);
  }

  // Live prod counts.
  const prodLive = new Map();
  for (const id of localScored.keys()) {
    const c = await fetchProdCount(id);
    if (c != null) prodLive.set(id, c);
  }

  const gaps = findLiveGaps(localScored, prodLive).filter((g) => prodLive.has(g.showId));
  console.log(`[live-verify] ${targets.length} in-window show(s); ${gaps.length} scored-but-not-fully-live.`);

  // Load + update staleness state.
  let state = {};
  try { state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch (_) {}
  const nextState = {};
  const toAlert = [];
  for (const g of gaps) {
    const { alert, entry } = shouldAlert(g, state[g.showId], nowMs, staleMinutes);
    nextState[g.showId] = entry;
    const ageMin = Math.round((nowMs - new Date(entry.firstSeenBehindAt).getTime()) / 60000);
    console.log(`  ${g.showId}: local ${g.localScored} > live ${g.prodLive} (behind ${ageMin}m)${alert ? ' → ALERT (stuck, not lag)' : ' → within deploy-lag window'}`);
    if (alert) toAlert.push({ ...g, ageMin });
  }
  // Shows that caught up drop out of nextState (firstSeenBehindAt cleared).

  if (hasFlag('alert') && toAlert.length) {
    try {
      const { sendAlert } = require('./lib/discord-notify');
      await sendAlert({
        title: '🟠 Scored but NOT live on prod',
        description: `${toAlert.length} opening-window show(s) have scored reviews that aren't rendering on the site (stuck >${staleMinutes}m — not deploy lag). Likely a rebuild-drop, lost data-repo push, or cancelled deploy.`,
        severity: 'error',
        fields: toAlert.slice(0, 10).map((g) => ({
          name: g.showId,
          value: `local scored **${g.localScored}**, live **${g.prodLive}** (missing ${g.delta}, behind ${g.ageMin}m). Check: node scripts/check-prod-deploy.js HEAD`,
        })),
      });
      console.log('[live-verify] Alert sent.');
    } catch (e) { console.error('[live-verify] alert failed:', e.message); }
  }

  try {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(nextState, null, 2));
  } catch (e) { console.error('[live-verify] state write failed:', e.message); }
}

module.exports = { findLiveGaps, shouldAlert };

if (require.main === module) {
  main().catch((e) => { console.error('[live-verify] fatal:', e.stack || e.message); process.exit(1); });
}
