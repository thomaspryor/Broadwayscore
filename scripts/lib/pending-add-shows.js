/**
 * Shows queued for creation by a pending-fix plan (BRO-4381).
 *
 * A cloud session adds shows by committing data/pending-fixes/bro-N.json with
 * `add-show` actions, which execute-approved-fix.yml later applies to the
 * private shows.json. Between the plan landing and the apply run (and until
 * the local data clone catches up), discovery sees those titles as missing
 * and would mint its own rows for them: BRO-4377 queued 16 Off-Broadway shows
 * that the TheaterMania source (BRO-4381) lists too. Discovery and the OB
 * coverage guard treat these as already known.
 *
 * Only 'pending' and 'applied' plans count ('applied' shows are already in
 * shows.json, so including them only covers a lagging data clone). Every
 * other status ('rejected', 'partial', 'validation-failed', anything new
 * execute-approved-fix.js writes) may mean the add-show never happened, and
 * such a plan must not hide a real show from discovery or the coverage guard
 * (ship-check review). Allowlist, not denylist, for that reason.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { slugify } = require('./deduplication');

const DEFAULT_DIR = path.join(__dirname, '..', '..', 'data', 'pending-fixes');
const COUNTED_STATUSES = new Set(['pending', 'applied']);

/**
 * @param {object[]} plans parsed pending-fix plan files
 * @returns {object[]} show objects from their add-show actions
 */
function addShowsFromPlans(plans) {
  const out = [];
  for (const plan of plans || []) {
    if (!plan || !COUNTED_STATUSES.has(plan.status)) continue;
    const actions = (plan.plan && Array.isArray(plan.plan.actions)) ? plan.plan.actions : [];
    for (const a of actions) {
      if (a && a.type === 'add-show' && a.show && typeof a.show.title === 'string' && a.show.title) {
        // checkForDuplicate reads existing.slug.length: a plan that omits
        // slug must not crash discovery.
        const slug = typeof a.show.slug === 'string' && a.show.slug ? a.show.slug : slugify(a.show.title);
        out.push({ ...a.show, slug, _pendingFix: plan.issueNumber || null });
      }
    }
  }
  return out;
}

function loadPendingAddShows(dir = DEFAULT_DIR) {
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const plans = [];
  for (const f of files) {
    try { plans.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch { /* malformed plan: execute-approved-fix refuses it too */ }
  }
  return addShowsFromPlans(plans);
}

module.exports = { addShowsFromPlans, loadPendingAddShows };
