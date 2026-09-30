#!/usr/bin/env node
'use strict';

/**
 * Corpus sweep for multi-show blog posts (interestedbystander): files whose
 * stored fullText is the WHOLE post (several shows' reviews) get only this
 * show's section, a rescore, and — when the content verifier judged the whole
 * post and its reason names ANOTHER section's show — an automated clear of
 * that verdict so the rescore/CV re-judge the real section.
 *
 * Found 2026-09-29: 34 of 40 interestedbystander files held the whole post
 * (e.g. sunset-boulevard-2024 was flagged wrongShow because the CV read the
 * DRAG / Mama I'm a Big Girl Now reviews that precede "Sunset Blvd"). The
 * write-time gate is isolateMultiShowSection() in every collector path; this
 * sweep repairs what was stored before it existed. Idempotent: an isolated
 * section has < 2 headings, so a second run finds nothing.
 *
 * Usage:
 *   node scripts/isolate-multi-show-sections.js [--apply] [--dir=PATH] [--show=ID]
 *     (default dry run; --dir or REVIEW_TEXTS_DIR selects the corpus)
 */

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { hasHelpFlag } = require('./lib/cli-help');
const { planIsolation } = require('./lib/multi-show-isolation-plan');
const { safeWriteReview } = require('./lib/review-write-guard');

const USAGE = 'Usage: node scripts/isolate-multi-show-sections.js [--apply] [--dir=PATH] [--show=ID]';

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const apply = argv.includes('--apply');
  const dirArg = argv.find((a) => a.startsWith('--dir='));
  const showArg = argv.find((a) => a.startsWith('--show='));
  const dir = dirArg ? dirArg.slice(6) : (process.env.REVIEW_TEXTS_DIR || path.join(__dirname, '..', 'data', 'review-texts'));
  const onlyShow = showArg ? showArg.slice(7) : null;
  const at = new Date().toISOString();
  let changed = 0; let refused = 0;
  // listShowDirs: a dangling symlink must not crash the daily scheduled run.
  for (const showId of listShowDirs(dir)) {
    if (showId[0] === '_' || showId[0] === '.' || (onlyShow && showId !== onlyShow)) continue;
    const showDir = path.join(dir, showId);
    for (const file of fs.readdirSync(showDir)) {
      if (!file.endsWith('.json') || file === 'failed-fetches.json') continue;
      const filePath = path.join(showDir, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { continue; }
      const plan = planIsolation(data, showId, at);
      if (!plan) continue;
      if (plan.refused) { refused++; console.log(`  refuse  ${showId}/${file} (no unique section for this show — left as is)`); continue; }
      changed++;
      console.log(`  isolate ${showId}/${file}: ${plan.from} -> ${plan.to} chars${plan.clearedFlags.length ? `; cleared ${plan.clearedFlags.join('+')}` : ''}`);
      if (apply) safeWriteReview(filePath, plan.data, { force: true, merge: false });
    }
  }
  console.log(`[isolate-multi-show-sections] ${changed} file(s) ${apply ? 'rewritten' : 'would be rewritten'}, ${refused} left (no unique section)${apply ? '' : ' (dry run)'}`);
}

if (require.main === module) main();
