#!/usr/bin/env node
/**
 * dump-dnr-estimates.js — read-only: for every commercial entry labelled
 * "Did Not Recoup", print the live record's own % returned figure and the
 * estimate designation it would get (Flop under 30%, Fizzle 30%+), so a cloud
 * session with a stale data copy can write the data-edit plan (BRO-6158, owner
 * 2026-10-24). Run through scripts/cloud-run-script.js (the model fields only
 * exist in the live file). A figure of 100%+ or no figure prints proposed: null.
 *
 * Usage: node scripts/dump-dnr-estimates.js [--slugs=a,b,c]
 *   --slugs  these records instead, whatever their label: a new TBD record's
 *            estimate before labelling it (BRO-6218)
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const { estimatedDesignationForClosed, isLossDesignation, ownReturnedEstimatePct, modelMiddleReturnedPct } = require('./lib/commercial-designations');

const DATA = path.join(__dirname, '..', 'data');
const commercial = JSON.parse(fs.readFileSync(path.join(DATA, 'commercial.json'), 'utf8')).shows;
const bySlug = new Map(JSON.parse(fs.readFileSync(path.join(DATA, 'shows.json'), 'utf8')).shows.map(s => [s.slug, s]));

const slugsArg = process.argv.slice(2).find(a => a.startsWith('--slugs='));
const only = slugsArg ? new Set(slugsArg.slice(8).split(',').filter(Boolean)) : null;

for (const [slug, e] of Object.entries(commercial)) {
  if (only ? !only.has(slug) : e.designation !== 'Did Not Recoup') continue;
  const own = ownReturnedEstimatePct(e);
  const pct = own !== null ? own : modelMiddleReturnedPct(e);
  const d = estimatedDesignationForClosed(e);
  console.log(JSON.stringify({
    slug, designation: e.designation, productionType: e.productionType, status: (bySlug.get(slug) || {}).status, recouped: e.recouped, basis: e.designationBasis,
    locked: e.humanReviewedDesignation === true, pct, source: own !== null ? 'own' : 'model',
    proposed: d && isLossDesignation(d) ? d : null,
  }));
}
