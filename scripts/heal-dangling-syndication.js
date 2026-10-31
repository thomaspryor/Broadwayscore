#!/usr/bin/env node
/**
 * heal-dangling-syndication.js (BRO-5396) — report-only. Finds syndicated
 * secondaries whose primary file no longer exists. Each is either repointed to
 * the live same-show copy of the article or, when no live copy exists, cleared
 * (the secondary is then the only copy and would otherwise be excluded for
 * nothing). With --plan it writes a data/pending-fixes review-field-edit plan;
 * the executor re-derives both decisions (review-field-edit.js
 * syndicatedDanglingContext). Never writes review texts.
 *
 *   node scripts/heal-dangling-syndication.js [--dir=<review-texts dir>] [--plan=data/pending-fixes/bro-N.json --issue=bro-N]
 */
require('./lib/cli-help').exitOnHelp(module);
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { findLiveSyndicationPrimary } = require('./lib/syndicated-duplicate-heal');

const arg = (n) => (process.argv.find((a) => a.startsWith(`--${n}=`)) || '').split('=').slice(1).join('=') || null;
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const ROOT = arg('dir') || resolveReviewTextsDir();

const rows = [];
for (const sid of fs.readdirSync(ROOT)) {
  const dir = path.join(ROOT, sid);
  if (sid.startsWith('.') || !fs.statSync(dir).isDirectory()) continue;
  const siblings = fs.readdirSync(dir);
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  for (const f of siblings) {
    if (!isReviewTextFile(f)) continue;
    let data;
    try { data = read(f); } catch { continue; }
    const ptr = data.syndicatedPrimaryFile;
    if (data.isSyndicatedDuplicate !== true || typeof ptr !== 'string') continue;
    const slash = ptr.indexOf('/');
    const ptrFolder = slash >= 0 ? ptr.slice(0, slash) : sid;
    if (fs.existsSync(path.join(ROOT, ptrFolder, path.basename(ptr)))) continue;
    const found = findLiveSyndicationPrimary({ data, file: f, siblings, read });
    if (!found.file && found.undecidable) { console.log(`UNDECIDABLE ${sid}/${f} <- ${ptr} (short text or unparseable sibling): left alone`); continue; }
    rows.push({ sid, f, ptr, live: found.file });
  }
}
for (const r of rows) console.log(`${r.live ? 'REPOINT' : 'CLEAR  '} ${r.sid}/${r.f} <- ${r.ptr}${r.live ? ` => ${r.live}` : ''}`);
console.log(`\n${rows.length} dangling: ${rows.filter((r) => r.live).length} repoint, ${rows.filter((r) => !r.live).length} clear`);

const planPath = arg('plan');
if (planPath && rows.length) {
  const actions = [];
  for (const r of rows) {
    const rel = `${r.sid}/${r.f}`;
    if (r.live) {
      actions.push({ type: 'review-field-edit', file: rel, field: 'syndicatedPrimaryFile', oldValue: r.ptr, newValue: `${r.sid}/${r.live}`, description: 'Repoint dangling syndication pointer to the live same-show copy of the article' });
    } else {
      actions.push({ type: 'review-field-edit', file: rel, field: 'isSyndicatedDuplicate', oldValue: true, newValue: false, description: 'Clear syndication mark: primary file is gone and no live copy of the article exists' });
      actions.push({ type: 'review-field-edit', file: rel, field: 'syndicatedPrimaryFile', oldValue: r.ptr, newValue: null, description: 'Clear dangling syndication pointer: primary file is gone and no live copy exists' });
    }
  }
  const plan = {
    issueNumber: arg('issue') || 'bro-5396',
    planId: crypto.randomUUID(),
    status: 'pending',
    submitter: { name: null, email: null },
    plan: {
      summary: `Heal ${rows.length} dangling syndication pointers (BRO-5396): repoint where a live copy exists, clear where the secondary is the only copy`,
      steps: ['Each secondary points at a primary file that no longer exists, so it is excluded for nothing.', 'A live same-show file holding the same article (text match) gets the pointer; otherwise the mark is cleared so the review scores.'],
      riskLevel: 'low',
      actions,
    },
  };
  fs.writeFileSync(planPath, JSON.stringify(plan, null, 2) + '\n');
  console.log(`wrote ${planPath} (${actions.length} actions)`);
}
