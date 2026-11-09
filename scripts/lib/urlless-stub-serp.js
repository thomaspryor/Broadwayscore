'use strict';
/**
 * Opening-night poller hook (BRO-7171 Stage 4): a review we only know from an
 * aggregator quote is saved as a stub with no url. found-outlet-ids counts that
 * stub as "found", so the poller's SERP layer never looks for the link, and a
 * SERP hit for the outlet would be dropped anyway (an Unknown-critic result is
 * skipped when a named file exists). The stub then sits as a NO_URL gap on a
 * show from the last two years.
 *
 * This module picks the stubs worth one SERP call and attaches a found link to
 * the existing stub instead of creating a sibling file. It does not change
 * getFoundOutletIds, so readiness counts are unaffected.
 */
const fs = require('fs');
const path = require('path');

const hasHttpUrl = (u) => typeof u === 'string' && /^https?:\/\//i.test(u) && !u.includes('undefined');

/**
 * Url-less stub slots for one show: outletId -> { filePath, criticName }.
 * A slot qualifies only when the outlet has exactly one live file for the show
 * and that file has no url, so a found link can only belong to that critic.
 * @param {string} showDir
 * @param {{inWindow: boolean, isReviewTextFile: (name: string) => boolean}} ctx
 * @returns {Map<string, {filePath: string, criticName: string|null}>}
 */
function urllessStubSlots(showDir, { inWindow, isReviewTextFile }) {
  const slots = new Map();
  if (!inWindow || !fs.existsSync(showDir)) return slots;
  const byOutlet = new Map();
  for (const name of fs.readdirSync(showDir)) {
    if (!isReviewTextFile(name)) continue;
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(showDir, name), 'utf8')); } catch { continue; }
    if (!d || !d.outletId) continue;
    if (d.wrongProduction || d.wrongShow || d.duplicateOf || d.isRoundupArticle || d.isNonReview
        || d.rejectionReason === 'not_a_review') continue;
    const k = String(d.outletId).toLowerCase();
    if (!byOutlet.has(k)) byOutlet.set(k, []);
    byOutlet.get(k).push({ filePath: path.join(showDir, name), data: d });
  }
  for (const [k, files] of byOutlet) {
    if (files.length !== 1) continue;
    const { filePath, data } = files[0];
    if (hasHttpUrl(data.url)) continue;
    slots.set(k, { filePath, criticName: data.criticName || null });
  }
  return slots;
}

/**
 * Attach SERP links to their url-less stubs. Pure apart from `attach`.
 * @param {Array<{outletId: string, url: string}>} results runSERPBackup output
 * @param {Map} slots from urllessStubSlots
 * @param {(filePath: string, url: string) => object|null} attach writer; null = refused
 * @returns {{remaining: Array, attached: Array<{filePath, url}>, refused: Array<{filePath, url}>}}
 */
function attachSerpUrlsToStubs(results, slots, attach) {
  const remaining = [];
  const attached = [];
  const refused = [];
  const used = new Set();
  for (const r of results) {
    const slot = r && r.outletId ? slots.get(String(r.outletId).toLowerCase()) : null;
    if (!slot || !hasHttpUrl(r.url) || used.has(slot.filePath)) { remaining.push(r); continue; }
    used.add(slot.filePath);
    if (attach(slot.filePath, r.url)) attached.push({ filePath: slot.filePath, url: r.url });
    else { refused.push({ filePath: slot.filePath, url: r.url }); remaining.push(r); }
  }
  return { remaining, attached, refused };
}

// Stub searches per poller cycle. The SERP budget is 12 calls and a 2026 show
// can carry 9 url-less stubs; uncapped they took most of it every cycle.
const URLLESS_STUB_SERP_PER_CYCLE = 2;

/**
 * Pick up to `cap` stub outlets for this cycle, rotating through the list by
 * `rotation` (the caller passes the hour) so every stub gets its turn. Pure.
 * @param {string[]} outletIds
 * @param {number} cap
 * @param {number} rotation
 * @returns {string[]}
 */
function pickStubOutletsForCycle(outletIds, cap, rotation) {
  const ids = [...outletIds].sort();
  if (ids.length <= cap) return ids;
  const start = ((rotation % ids.length) + ids.length) % ids.length;
  return Array.from({ length: cap }, (_, i) => ids[(start + i) % ids.length]);
}

module.exports = { urllessStubSlots, attachSerpUrlsToStubs, pickStubOutletsForCycle, URLLESS_STUB_SERP_PER_CYCLE };
