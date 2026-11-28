#!/usr/bin/env node
/**
 * Delete data/cast files whose show id is not in shows.json (BRO-5277).
 * Usage: node scripts/prune-orphan-cast-files.js [--apply]
 * Dry run by default. Decision logic: scripts/lib/orphan-cast-files.js.
 */
const fs = require('fs');
const path = require('path');
const { planOrphanCastPrune } = require('./lib/orphan-cast-files');
const { hasHelpFlag } = require('./lib/cli-help.js');

const ROOT = path.join(__dirname, '..');

function pruneOrphanCastFiles({ castDir = path.join(ROOT, 'data', 'cast'), showsFile = path.join(ROOT, 'data', 'shows.json'), apply = false } = {}) {
  const showIds = JSON.parse(fs.readFileSync(showsFile, 'utf8')).shows.map((s) => s.id);
  const fileIds = fs.readdirSync(castDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  const plan = planOrphanCastPrune(fileIds, showIds);
  if (apply && !plan.refused) for (const id of plan.prune) fs.unlinkSync(path.join(castDir, `${id}.json`));
  return plan;
}

module.exports = { pruneOrphanCastFiles };

if (require.main === module) {
  if (hasHelpFlag(process.argv)) {
    console.log('Usage: node scripts/prune-orphan-cast-files.js [--apply]  (dry run by default)');
    process.exit(0);
  }
  const apply = process.argv.includes('--apply');
  const plan = pruneOrphanCastFiles({ apply });
  if (plan.refused) { console.error(`[prune-orphan-cast] refused: ${plan.refused}`); process.exit(2); }
  console.log(`[prune-orphan-cast] ${plan.prune.length} orphan cast file(s) ${apply ? 'deleted' : '(dry run)'}${plan.prune.length ? ': ' + plan.prune.join(', ') : ''}`);
}
