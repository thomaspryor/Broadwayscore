#!/usr/bin/env node
/**
 * Turn a staged manifest into pending-fix add-show plans (BRO-6518).
 *
 *   node scripts/tic-make-plan.js --manifest=<m.json> --id=bro-6518-<tag> [--only=ids] [--dry-run]
 *
 * Writes data/pending-fixes/<id>.json (-b, -c ... at 25 actions), runs the
 * preflight and force-adds them. Also writes <manifest>.ingest.json:
 * { <showId>: [ "<review url>"... ] } for the ingest step.
 */
require('./lib/cli-help').exitOnHelp(module);
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { buildPlans } = require('./new-fix-plan');
const { preflight, pickReviewTextsTree, pickCoreDataDir } = require('./lib/preflight-review-fix-plan');

const ROOT = path.join(__dirname, '..');

function main() {
  const get = (k) => { const a = process.argv.find((x) => x.startsWith(`--${k}=`)); return a ? a.slice(k.length + 3) : null; };
  const manifest = JSON.parse(fs.readFileSync(get('manifest'), 'utf8'));
  const id = get('id');
  const only = get('only') ? new Set(get('only').split(',')) : null;
  const recs = Object.values(manifest.staged).filter((r) => !only || only.has(r.show.id));
  const actions = recs.map((r) => ({ type: 'add-show', show: r.show, description: `add ${r.show.id}` }));
  if (!actions.length) throw new Error('nothing staged');
  const plans = buildPlans(id, `Add ${actions.length} Chicago local productions from theatreinchicago.com (BRO-6518)`, actions);
  const dry = process.argv.includes('--dry-run');
  const written = plans.map((p) => {
    const f = path.join(ROOT, 'data', 'pending-fixes', `${p.name}.json`);
    if (!dry) fs.writeFileSync(f, JSON.stringify(p.plan, null, 2) + '\n');
    return f;
  });
  if (!process.argv.includes('--dry-run')) {
    const { failed } = preflight(written, { reviewTextsDir: pickReviewTextsTree(), coreDataDir: pickCoreDataDir() });
    if (failed) { console.error('preflight failed'); process.exit(1); }
    execFileSync('git', ['add', '-f', ...written], { cwd: ROOT, stdio: 'inherit' });
  }
  const ingest = {};
  for (const r of recs) ingest[r.show.id] = r.reviews.map((x) => x.url);
  fs.writeFileSync(get('manifest').replace(/\.json$/, '') + '.ingest.json', JSON.stringify(ingest));
  for (const p of plans) console.log(`node scripts/cloud-dispatch.js execute-approved-fix.yml -f issue_number=${p.name} -f plan_id=${p.plan.planId} -f mode=apply --wait`);
}
if (require.main === module) main();
