#!/usr/bin/env node
/**
 * plan-key-duplicate-fixes.js (BRO-5274)
 *
 * Read-only. Scans review-texts for (showDir|outlet|criticName) duplicate
 * groups (same definition as audit-review-key-duplicates.js) and prints, as one
 * JSON line, review-field-edit actions for an approved-fix plan plus the groups
 * it will not decide. Decision logic: scripts/lib/key-duplicate-plan.js.
 *
 *   node scripts/cloud-run-script.js --review-texts scripts/plan-key-duplicate-fixes.js
 *
 * No review text is printed. Write the actions into data/pending-fixes/bro-N.json.
 */

const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { isRejectedNonReview } = require('./lib/review-guards');
const { planKeyGroup } = require('./lib/key-duplicate-plan');
const { hasHelpFlag } = require('./lib/cli-help.js');

const RT = path.join(__dirname, '..', 'data', 'review-texts');

function bylineHit(name, d) {
  const n = String(name || '').replace(/-/g, ' ').trim().toLowerCase();
  if (!n || n === 'unknown') return null;
  const body = String(d.fullText || d.text || '').toLowerCase();
  const surname = n.split(/\s+/).pop();
  return surname.length >= 3 && (body.slice(0, 900) + ' ' + body.slice(-500)).includes(surname);
}

function scan() {
  const groups = new Map();
  for (const showDir of listShowDirs(RT, { skipHolding: true })) {
    const dir = path.join(RT, showDir);
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const file of names) {
      if (!isReviewTextFile(file)) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
      if (d.duplicateOf || d.wrongProduction || d.wrongShow || d.wrongUrl || isRejectedNonReview(d)) continue;
      const key = `${showDir}|${(d.outletId || '').toLowerCase() || (d.outlet || '').toLowerCase()}|${(d.criticName || 'unknown').toLowerCase().trim()}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({
        showDir, file, locked: d._locked === true,
        url: d.url || null, critic: d.criticName || null,
        head: String(d.fullText || d.text || '').slice(0, 400),
        hrs: d.humanReviewScore ?? null, orig: d.originalScore ?? null,
        textLen: Math.max((d.fullText || '').length, (d.text || '').length), tier: d.contentTier || null,
        bylineFile: bylineHit(fileSlugOf(file), d), bylineField: bylineHit(d.criticName, d),
      });
    }
  }
  return [...groups.entries()].filter(([, v]) => v.length > 1);
}

const fileSlugOf = (file) => file.replace(/\.json$/, '').split('--')[1] || '';

function main() {
  if (hasHelpFlag(process.argv)) { console.log('Usage: node scripts/plan-key-duplicate-fixes.js  (read-only; prints JSON)'); return; }
  if (!fs.existsSync(RT)) { console.error('review-texts corpus missing'); process.exit(2); }
  const actions = []; const ambiguous = [];
  for (const [key, files] of scan()) {
    if (files.some((f) => f.locked)) { ambiguous.push(`${key}: a file is _locked`); continue; }
    const showDir = files[0].showDir;
    const r = planKeyGroup(files);
    for (const a of r.actions) actions.push({ ...a, path: `${showDir}/${a.file}`, key });
    for (const m of r.ambiguous) ambiguous.push(`${showDir}: ${m}`);
  }
  console.log(JSON.stringify({ actions, ambiguous }));
}

if (require.main === module) main();
module.exports = { scan };
