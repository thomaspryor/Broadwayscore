#!/usr/bin/env node
'use strict';
/** Limbo routing engine (BRO-7930), split from scripts/route-limbo-reviews.js so it lives under scripts/lib (covered by test.yml's lib path filter). */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./cli-help.js');
const { GRACE_DAYS, classifyLimbo, applyDecision, misattributedWetRoundup } = require('./limbo-gate');
const { resolveReviewTextsDir } = require('./review-texts-dir');
const { isReviewTextFile } = require('./review-text-sidecars');

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/shows.json'), 'utf8'));
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
  const { safeWriteReview } = require('./review-write-guard');
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
      if (d.limboRoute === dec.route && d.limboRule === (dec.rule || null)) { // re-judged, same answer: already routed
        counts.unchanged = (counts.unchanged || 0) + 1;
        // A refetch that has not recovered text 14 days on is surfaced (the sweep raises an alert), never silent.
        if (dec.route === 'refetch' && nowMs - Date.parse(d.limboRoutedAt || '') > 14 * 864e5) counts.stuckRefetch = (counts.stuckRefetch || 0) + 1;
        continue;
      }
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
