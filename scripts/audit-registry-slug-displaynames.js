#!/usr/bin/env node
'use strict';

/**
 * audit-registry-slug-displaynames.js (BRO-4468)
 *
 * Lists outlet-registry entries whose displayName is just the capitalized slug
 * of a run-together id ("Newjerseystage") and, where the outlet's own review
 * files carry a better label that spells the same id ("New Jersey Stage"),
 * proposes it. Advisory: exits 0 unless --max=N is exceeded by entries that
 * have a proposal waiting (a better label exists and is not applied). Entries
 * with no review label are listed only; stamp `displayNameReviewed` to hide one.
 *
 * Usage: node scripts/audit-registry-slug-displaynames.js [--json] [--max=N]
 * Needs data/review-texts (run through cloud-run-script.js --review-texts in cloud).
 */

const fs = require('fs');
const path = require('path');
const { deriveOutletDisplayName } = require('./lib/outlet-auto-register');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');

function slugCapitalized(id) {
  return String(id).split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

/**
 * @param {Record<string, {displayName?: string, displayNameReviewed?: boolean}>} outlets
 * @param {Record<string, string[]>} namesByOutletId review `outlet` strings per outletId
 * @returns {Array<{outletId: string, current: string, proposed: string|null}>}
 */
function findSlugDerivedDisplayNames(outlets, namesByOutletId = {}) {
  const rows = [];
  for (const [id, entry] of Object.entries(outlets || {})) {
    if (!entry || entry.displayNameReviewed) continue;
    if (id.includes('-') || id.length < 8) continue;
    if (entry.displayName !== slugCapitalized(id)) continue;
    const { displayName, inferred } = deriveOutletDisplayName({ outletId: id, reviewOutletNames: namesByOutletId[id] || [] });
    rows.push({ outletId: id, current: entry.displayName, proposed: inferred ? null : displayName });
  }
  return rows;
}

function collectNames(reviewTextsDir, wanted) {
  const names = {};
  for (const showDir of fs.readdirSync(reviewTextsDir)) {
    const dir = path.join(reviewTextsDir, showDir);
    let files;
    try { files = fs.readdirSync(dir); } catch { continue; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const id = f.split('--')[0];
      if (!wanted.has(id)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        if (j.outlet) (names[id] = names[id] || []).push(j.outlet);
      } catch { /* unreadable file: skip */ }
    }
  }
  return names;
}

function main() {
  if (hasHelpFlag(process.argv)) {
    console.log('Usage: node scripts/audit-registry-slug-displaynames.js [--json] [--max=N]');
    return;
  }
  const max = Number((process.argv.find((a) => a.startsWith('--max=')) || '').slice(6));
  const outlets = require(path.join(ROOT, 'data', 'outlet-registry.json')).outlets;
  const candidates = findSlugDerivedDisplayNames(outlets, {});
  const rtDir = path.join(ROOT, 'data', 'review-texts');
  const names = fs.existsSync(rtDir) ? collectNames(rtDir, new Set(candidates.map((c) => c.outletId))) : {};
  const rows = findSlugDerivedDisplayNames(outlets, names);
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(rows, null, 1));
  } else {
    console.log(`[audit-registry-slug-displaynames] ${rows.length} slug-derived displayNames (${rows.filter((r) => r.proposed).length} with a proposal)`);
    for (const r of rows.slice(0, 40)) console.log(`  ${r.outletId}: "${r.current}" -> ${r.proposed ? `"${r.proposed}"` : '(no review label; set by hand or stamp displayNameReviewed)'}`);
  }
  if (Number.isFinite(max) && max > 0 && rows.filter((r) => r.proposed).length > max) process.exitCode = 1;
}

module.exports = { findSlugDerivedDisplayNames, slugCapitalized };
if (require.main === module) main();
