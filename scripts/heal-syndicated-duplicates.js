#!/usr/bin/env node
/**
 * heal-syndicated-duplicates.js (BRO-4415) — report-only. Walks data/review-texts,
 * runs syndicatedDuplicateHealPlan on every syndicated secondary whose primary is
 * excluded, prints each decision, and with --plan=<path> writes a
 * data/pending-fixes plan (review-field-edit clears) for the 'clear' cases.
 * Never writes review texts.
 *
 *   node scripts/heal-syndicated-duplicates.js [--show=ID] [--plan=data/pending-fixes/bro-N.json --issue=bro-N]
 */
require('./lib/cli-help').exitOnHelp(module);
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { explainExclusion } = require('./lib/review-guards');
const { syndicatedDuplicateHealPlan } = require('./lib/syndicated-duplicate-heal');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const ROOT = path.join(__dirname, '..');
const REVIEW_DIR = path.join(ROOT, 'data', 'review-texts');
const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
const showById = {};
for (const s of (Array.isArray(shows) ? shows : shows.shows)) showById[s.id] = s;

const rows = [];
for (const sid of fs.readdirSync(REVIEW_DIR)) {
  if (arg('show') && sid !== arg('show')) continue;
  const dir = path.join(REVIEW_DIR, sid);
  if (!fs.statSync(dir).isDirectory()) continue;
  const io = {
    exists: (f) => fs.existsSync(path.join(dir, f)),
    read: (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')),
  };
  const explain = (d, f) => explainExclusion(d, showById[sid], path.join(dir, f));
  for (const f of fs.readdirSync(dir)) {
    if (!isReviewTextFile(f)) continue;
    let data;
    try { data = io.read(f); } catch { continue; }
    const plan = syndicatedDuplicateHealPlan({ data, file: f, folder: sid, io, explain });
    if (plan) rows.push({ sid, file: f, data, plan });
  }
}

// Rows with no primaryWhy are structural (self-pointer, dangling or cross-show pointer): counted, not listed.
const structural = rows.filter((r) => !r.plan.primaryWhy);
for (const r of rows.filter((x) => x.plan.primaryWhy)) {
  console.log(`${r.plan.decision.toUpperCase().padEnd(5)} ${r.sid}/${r.file} <- ${r.plan.primaryFile} [${r.plan.primaryWhy || '-'}] ${r.plan.reason}`);
}
const clears = rows.filter((r) => r.plan.decision === 'clear');
const byReason = {};
for (const r of structural) byReason[r.plan.reason] = (byReason[r.plan.reason] || 0) + 1;
console.log(`\n${rows.length - structural.length} with an excluded primary, ${clears.length} to clear; structural (not handled here): ${JSON.stringify(byReason)}`);

const planPath = arg('plan');
if (planPath && clears.length) {
  const issue = arg('issue') || 'bro-4415';
  const actions = [];
  for (const r of clears) {
    const rel = `${r.sid}/${r.file}`;
    const why = `${r.plan.reason}; primary ${r.plan.primaryFile} excluded (${r.plan.primaryWhy})`;
    actions.push({ type: 'review-field-edit', file: rel, field: 'isSyndicatedDuplicate', oldValue: true, newValue: false, description: `Clear stale syndication mark: ${why}` });
    actions.push({ type: 'review-field-edit', file: rel, field: 'syndicatedPrimaryFile', oldValue: r.data.syndicatedPrimaryFile, newValue: null, description: `Clear stale syndication pointer: ${why}` });
  }
  const plan = {
    issueNumber: issue,
    planId: crypto.randomUUID(),
    status: 'pending',
    submitter: { name: null, email: null },
    plan: {
      summary: `Clear ${clears.length} syndication marks whose primary copy is excluded for a primary-only reason (BRO-4415)`,
      steps: ['Each secondary is the same article as its excluded primary; the primary verdict (wrongAttribution, misfiled or dated wrongProduction, garbage extraction) does not apply to it.'],
      riskLevel: 'low',
      actions,
    },
  };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
  console.log(`wrote ${planPath} (${actions.length} actions)`);
}
