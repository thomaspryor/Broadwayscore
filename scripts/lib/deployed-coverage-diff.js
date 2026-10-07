'use strict';

/**
 * deployed-coverage-diff.js — B4 of the v2 reconciler Sprint B plan
 * (~/Documents/claude-outputs/review-pipeline-from-scratch-design-2026-07-29.md,
 * REVISED PLAN v2 point 6):
 *
 *   "The scoreboard must diff against the DEPLOYED public JSON, not internal
 *    state — otherwise publish-stage silence (cancel-cascaded deploys) recreates
 *    the miss at the last hop."
 *
 * WHY THIS IS A DISTINCT CHECK
 * Every existing coverage audit compares aggregator evidence against
 * reviews.json. reviews.json is INTERNAL: a review can be collected, scored and
 * present there while the public site serves an older build that doesn't have
 * it. That last hop fails silently and often — a cancel-cascaded Vercel deploy
 * reports `success` on the GitHub run while its deployment ends CANCELED
 * (2026-06-26 incident, see check-prod-deploy.js), so the internal audits stay
 * green while the site is stale. This module closes the loop by comparing
 * internal state against what broadwaycorecard.com actually serves.
 *
 * THREE DEFECT CLASSES, all "the site is lying about coverage":
 *   missing-from-prod   — an outlet scored internally that the deployed JSON has no
 *                         review for (the publish-stage silence this exists to catch)
 *   score-drift         — deployed `cs` differs from local `cs` beyond a tolerance
 *                         (the show's page is serving a stale Critic Score)
 *   unreachable         — the deployed JSON 404s / won't parse (show page not
 *                         published at all — worse than stale, and previously
 *                         invisible to every audit)
 *
 * Outlet identity: the public JSON stores the outlet DISPLAY NAME (`rv[].o`), not
 * an outletId, so ids are re-derived through normalizeOutlet at diff time — the
 * same live-derivation discipline review-census.js's normalizeWetRow documents.
 * A baked/stale id mapping here would manufacture phantom "missing" rows.
 *
 * Pure: the fetch lives in the caller (scripts/audit-deployed-coverage.js). This
 * file only decides, so the decision is unit-testable against fixtures.
 */

const { normalizeOutlet } = require('./review-normalization');

// Critic Score tolerance. The deployed and local values are both rounded to 2dp
// by the same builder, so any real difference means different inputs — but a
// hair of float noise must not page anyone. 0.05 is below the smallest
// meaningful display delta (the UI rounds to whole numbers).
const CS_TOLERANCE = 0.05;

/** Outlet ids present in a deployed public show JSON's review array. */
function deployedOutletIds(deployedJson) {
  const rv = (deployedJson && (deployedJson.rv || deployedJson.reviews)) || [];
  const ids = new Set();
  for (const r of rv) {
    if (!r) continue;
    // outletId is never stored in the public payload; `o` is the display name.
    const id = r.outletId || (r.o ? normalizeOutlet(r.o) : null);
    if (id) ids.add(id);
  }
  return ids;
}

/**
 * Diff ONE show: internal truth vs what production serves.
 *
 * @param {object} p
 * @param {string} p.showId
 * @param {string} [p.title]
 * @param {Set<string>|string[]} p.localScoredOutletIds  outletIds scored in reviews.json
 * @param {number|null} p.localCs                        local public/data/shows/{id}.json cs
 * @param {string|null} [p.openingDate]                  used only to rank the report (recent first)
 * @param {object|null} p.deployedJson                   parsed prod JSON (null when unreachable)
 * @param {string} [p.fetchError]                        why it was unreachable
 * @param {object} [opts] { csTolerance }
 * @returns {{showId, title, ok:boolean, defects:Array<{type, detail}>,
 *            missingFromProd:string[], localCount:number, deployedCount:number|null}}
 */
function diffShow(p, opts = {}) {
  const tolerance = opts.csTolerance != null ? opts.csTolerance : CS_TOLERANCE;
  const local = new Set(p.localScoredOutletIds || []);
  const defects = [];

  if (!p.deployedJson) {
    // Unreachable is its own class, NOT "everything is missing": reporting 40
    // missing outlets for one 404 would swamp the report and hide the real
    // signal, which is that the page isn't published.
    defects.push({
      type: 'unreachable',
      detail: p.fetchError || 'deployed JSON could not be fetched or parsed',
    });
    return {
      showId: p.showId, title: p.title || p.showId, openingDate: p.openingDate || null,
      ok: false, defects,
      missingFromProd: [], localCount: local.size, deployedCount: null,
    };
  }

  const deployed = deployedOutletIds(p.deployedJson);
  const missingFromProd = [...local].filter((id) => !deployed.has(id)).sort();
  if (missingFromProd.length) {
    defects.push({
      type: 'missing-from-prod',
      detail: `${missingFromProd.length} scored outlet(s) absent from the deployed payload: ${missingFromProd.join(', ')}`,
    });
  }

  const deployedCs = p.deployedJson.cs;
  if (p.localCs != null && typeof deployedCs === 'number'
      && Math.abs(deployedCs - p.localCs) > tolerance) {
    defects.push({
      type: 'score-drift',
      detail: `deployed cs ${deployedCs} vs local ${p.localCs} (Δ${Math.round(Math.abs(deployedCs - p.localCs) * 100) / 100})`,
    });
  }
  // A show that HAS local reviews but whose deployed payload carries no cs at all
  // is a build defect, not merely drift — the page renders with no score.
  if (p.localCs != null && typeof deployedCs !== 'number') {
    defects.push({ type: 'score-drift', detail: `deployed payload has no numeric cs (local ${p.localCs})` });
  }

  return {
    showId: p.showId, title: p.title || p.showId, openingDate: p.openingDate || null,
    ok: defects.length === 0, defects, missingFromProd,
    localCount: local.size, deployedCount: deployed.size,
  };
}

/**
 * Roll per-show diffs into the report the audit writes + alerts on.
 * @param {Array} showDiffs  diffShow() results
 * @returns {{ generatedAt:null, checked:number, clean:number, defective:number,
 *             byType:object, shows:Array }}
 *   generatedAt is left to the caller (keeps this pure — no clock).
 */
function summarize(showDiffs) {
  const rows = (showDiffs || []).filter(Boolean);
  const byType = {};
  for (const r of rows) {
    for (const d of r.defects) byType[d.type] = (byType[d.type] || 0) + 1;
  }
  const defective = rows.filter((r) => !r.ok);
  return {
    checked: rows.length,
    clean: rows.length - defective.length,
    defective: defective.length,
    byType,
    // Worst first: unreachable (page not published) > missing reviews > score drift.
    // Within a severity class, RECENT openings first. The audit's target set is
    // "open OR opened in the window", and `open` includes evergreens that have run
    // for years — so without a recency tiebreak a CDN hiccup on a 2015 revival can
    // occupy the digest's 5-line callout and hide today's failed deploy (adversarial
    // review finding). Undated shows sort last.
    shows: defective.sort((a, b) =>
      (severityRank(b) - severityRank(a))
      || String(b.openingDate || '').localeCompare(String(a.openingDate || ''))),
  };
}

function severityRank(row) {
  const types = new Set(row.defects.map((d) => d.type));
  if (types.has('unreachable')) return 3;
  if (types.has('missing-from-prod')) return 2;
  return 1;
}

/** The public JSON URL for a show. Single place the path convention lives. */
function deployedShowUrl(showId, base = 'https://broadwayscorecard.com') {
  return `${base}/data/shows/${showId}.json`;
}

module.exports = {
  diffShow, summarize, deployedOutletIds, deployedShowUrl, severityRank, CS_TOLERANCE,
};
