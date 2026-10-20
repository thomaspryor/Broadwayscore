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
 * Usage: node scripts/audit-registry-slug-displaynames.js [--json] [--max=N] [--fetch [--apply]]
 * Needs data/review-texts (run through cloud-run-script.js --review-texts in cloud).
 *
 * --fetch (BRO-5336): for every run-together slug displayName ("Hackneycitizen")
 * with a domain, fetch the outlet homepage through fetchPage() and propose its
 * og:site_name / <title> when that spells the id or domain (the acceptance
 * rule is deriveOutletDisplayName's). --apply writes accepted names to
 * data/outlet-registry.json. Unaccepted rows are listed for a human.
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

async function fetchMastheads({ apply }) {
  const { fetchPage } = require('./lib/scraper');
  const { resolveMastheadName, findRunTogetherSlugDisplayNames } = require('./lib/outlet-auto-register');
  const registryPath = path.join(ROOT, 'data', 'outlet-registry.json');
  const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
  const outlets = registry.outlets || registry;
  const fixes = [];
  const unresolved = [];
  for (const { outletId, displayName: current } of findRunTogetherSlugDisplayNames(outlets)) {
    const domain = outlets[outletId].domain;
    if (!domain) { unresolved.push({ outletId, current, reason: 'no domain' }); continue; }
    const r = await resolveMastheadName({ outletId, domain, fetchPage });
    if (r.error) { unresolved.push({ outletId, current, reason: r.error }); continue; }
    if (!r.displayName || r.displayName === current) unresolved.push({ outletId, current, reason: `no masthead spells the id (page offered: ${r.siteNames.slice(0, 3).join(' / ') || 'nothing'})` });
    else {
      fixes.push({ outletId, current, proposed: r.displayName });
      // Written per fix, so a run cut off by its step timeout keeps what it found.
      if (apply) {
        outlets[outletId].displayName = r.displayName;
        delete outlets[outletId].displayNameInferred; // the masthead replaced the slug guess
        outlets[outletId].displayNameSource = 'homepage'; // provenance for a later audit
        fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
      }
    }
  }
  for (const f of fixes) console.log(`  ${f.outletId}: "${f.current}" -> "${f.proposed}"`);
  for (const u of unresolved) console.log(`  ${u.outletId}: "${u.current}" left (${u.reason})`);
  // BRO-5732: outlets the rebuild parked because only a slug-shaped name existed.
  // A masthead found here is stored on the staging row; the next rebuild reads it
  // and registers the outlet through its normal collision checks.
  const { STAGING_RELATIVE_PATH, STAGE_REASONS } = require('./lib/outlet-auto-register');
  const stagingPath = path.join(ROOT, STAGING_RELATIVE_PATH);
  let stagedFound = 0;
  if (fs.existsSync(stagingPath)) {
    const doc = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
    for (const row of doc.staged || []) {
      if (row.reason !== STAGE_REASONS.NAME_UNRESOLVED || row.mastheadName || !row.domainHint) continue;
      const r = await resolveMastheadName({ outletId: row.outletId, domain: row.domainHint, fetchPage });
      if (r.displayName) { row.mastheadName = r.displayName; stagedFound++; console.log(`  staged ${row.outletId}: masthead "${r.displayName}"`); }
      else console.log(`  staged ${row.outletId}: still unresolved (${r.error || 'no masthead spells the id'})`);
    }
    if (apply && stagedFound) fs.writeFileSync(stagingPath, JSON.stringify(doc, null, 2) + '\n');
  }
  console.log(`[audit-registry-slug-displaynames --fetch] ${stagedFound} staged masthead(s) found; ${fixes.length} masthead name(s) found${apply ? ' and applied' : ''}, ${unresolved.length} left`);
  // Every fetch failing means the scraper is down, not that nothing is fixable.
  // Two or more, so one permanently dead site is not reported as an outage.
  if (!fixes.length && !stagedFound && unresolved.filter((u) => /^fetch failed/.test(u.reason)).length >= 2 && unresolved.every((u) => /^fetch failed|^no domain/.test(u.reason))) {
    console.error('::warning::every masthead fetch failed (scraper keys or credits?)');
    process.exitCode = 1;
  }
}

function main() {
  if (hasHelpFlag(process.argv)) {
    console.log('Usage: node scripts/audit-registry-slug-displaynames.js [--json] [--max=N] [--fetch [--apply]]');
    return;
  }
  if (process.argv.includes('--fetch')) {
    fetchMastheads({ apply: process.argv.includes('--apply') }).catch((err) => { console.error(err); process.exitCode = 1; });
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
