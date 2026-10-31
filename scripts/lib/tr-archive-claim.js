'use strict';

/**
 * tr-archive-claim.js — keep theatre.reviews archives from replaying another
 * production's round-up onto a show (BRO-6089).
 *
 * data/aggregator-archive/theatre-reviews/{showId}.html is keyed by showId, but
 * the page inside may be a different production's round-up (legacy title-only
 * matching put the 2024 Godot round-up under the 2017 show). Title-only
 * checkArchiveCategory passes for those. The page's canonical URL is the
 * ground truth: when a round-up that BRO-6084's date-window matcher assigned
 * to a DIFFERENT show owns that URL, the archive is wrong-production.
 *
 * An archive whose canonical URL nobody claims is NOT touched: gather-reviews
 * also writes valid archives for shows the TR matcher cannot match.
 */

const fs = require('fs');
const path = require('path');
const { archiveUrlOf, sameRoundupUrl } = require('./tr-reconcile');

const COVERAGE_PATH = path.join(__dirname, '..', '..', 'data', 'audit', 'theatre-reviews-coverage.json');

/** [{showId, roundupUrl}] -> claims usable by checkTrArchiveClaim. */
function claimsFromCoverage(coverage) {
  return ((coverage && coverage.shows) || [])
    .filter((e) => e && e.showId && e.roundupUrl && !e.skipped) // skipped = guard-rejected / unfetched, not a trusted claim
    .map((e) => ({ showId: e.showId, url: e.roundupUrl }));
}

const cache = new Map();
function loadCoverageClaims(file = COVERAGE_PATH) {
  if (cache.has(file)) return cache.get(file);
  let claims = [];
  try { claims = claimsFromCoverage(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch (e) { console.warn(`[tr-archive-claim] no coverage claims (${e.code || e.message}); claim guard off`); }
  cache.set(file, claims);
  return claims;
}

/**
 * @param {string} html archived page
 * @param {string} showId the show the archive is filed under
 * @param {Array<{showId:string,url:string}>} claims matched round-ups
 * @returns {{ok:true}|{ok:false, reason:string, owner:string}}
 */
function checkTrArchiveClaim(html, showId, claims) {
  const canon = archiveUrlOf(html);
  if (!canon) return { ok: true };
  const mine = (claims || []).some((c) => c.showId === showId && sameRoundupUrl(canon, c.url));
  if (mine) return { ok: true };
  const other = (claims || []).find((c) => c.showId !== showId && sameRoundupUrl(canon, c.url));
  if (other) return { ok: false, reason: `archive page ${canon} is the round-up matched to ${other.showId}`, owner: other.showId };
  return { ok: true };
}

/**
 * Rename wrong-production orphans to .mismatch. Only archives whose canonical
 * URL is claimed by another show move; unclaimed orphans stay.
 * @returns {Array<{showId:string, owner:string}>} quarantined
 */
function quarantineClaimedOrphans(archiveDir, orphanIds, claims, { dryRun = false } = {}) {
  const out = [];
  for (const id of orphanIds) {
    const p = path.join(archiveDir, `${id}.html`);
    let html;
    try { html = fs.readFileSync(p, 'utf8'); } catch { continue; }
    const v = checkTrArchiveClaim(html, id, claims);
    if (v.ok) continue;
    if (!dryRun) { try { fs.renameSync(p, p + '.mismatch'); } catch { continue; } }
    out.push({ showId: id, owner: v.owner });
  }
  return out;
}

module.exports = { claimsFromCoverage, loadCoverageClaims, checkTrArchiveClaim, quarantineClaimedOrphans };
