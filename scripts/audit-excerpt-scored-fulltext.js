#!/usr/bin/env node
'use strict';

/**
 * audit-excerpt-scored-fulltext.js — BRO-7345 class guard: a complete, >=1500-char
 * fullText file whose recorded llmMetadata.textSource.type is 'excerpt' and which is not
 * queued (needsRescore false) means the critic's full text never reached the scorer.
 * Classification lives in scripts/lib/rescore-flagging.js classifyExcerptScoredFullText;
 * only 'actionable' fails the gate (the rest are excluded / non-LLM score / unscored / settled).
 *
 * Usage:
 *   node scripts/audit-excerpt-scored-fulltext.js                 # report, exit 0
 *   node scripts/audit-excerpt-scored-fulltext.js --max=0         # gate: exit 1 if actionable > max
 *   node scripts/audit-excerpt-scored-fulltext.js --fix           # markRescoreNeeded on the actionable set
 *   node scripts/audit-excerpt-scored-fulltext.js --json
 * Exit: 0 ok, 1 over threshold, 2 could not run.
 */

const fs = require('fs');
const path = require('path');
const { isReviewTextFile } = require('./lib/review-text-sidecars');
const { listShowDirs } = require('./lib/list-show-dirs');
const { resolveReviewTextsDir } = require('./lib/review-texts-dir');
const { classifyExcerptScoredFullText, markRescoreNeeded } = require('./lib/rescore-flagging');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { parseMaxArgOrExit } = require('./lib/parse-max-arg.js');

const USAGE = `audit-excerpt-scored-fulltext.js — complete fullText files scored from an excerpt and not queued (BRO-7345).

Usage:
  node scripts/audit-excerpt-scored-fulltext.js [--max=N] [--fix] [--json]
`;

const ROOT = path.join(__dirname, '..');
const FIX_REASON = 'complete fullText scored from an excerpt by an older text selector (BRO-7345)';

function loadShows() {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'shows.json'), 'utf8'));
  return new Map((raw.shows || raw).filter((s) => s.id).map((s) => [s.id, s]));
}

function scan(dir, showsById) {
  const counts = {};
  const actionable = [];
  for (const showDir of listShowDirs(dir)) {
    const showPath = path.join(dir, showDir);
    for (const file of fs.readdirSync(showPath).filter((f) => isReviewTextFile(f))) {
      const fp = path.join(showPath, file);
      let data;
      try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { continue; }
      const cls = classifyExcerptScoredFullText(data, showsById.get(showDir), fp);
      if (!cls) continue;
      counts[cls] = (counts[cls] || 0) + 1;
      if (cls === 'actionable') actionable.push({ path: fp, rel: `${showDir}/${file}` });
    }
  }
  return { counts, actionable };
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return; }
  const max = parseMaxArgOrExit(argv, { scriptName: 'audit-excerpt-scored-fulltext' });
  const dir = resolveReviewTextsDir();
  if (!fs.existsSync(dir)) { console.error(`[excerpt-scored-fulltext] review-texts dir missing: ${dir}`); process.exit(2); }
  let showsById;
  try { showsById = loadShows(); } catch (e) { console.error(`[excerpt-scored-fulltext] cannot load shows.json: ${e.message}`); process.exit(2); }

  const { counts, actionable } = scan(dir, showsById);
  let fixed = 0;
  if (argv.includes('--fix') && actionable.length) {
    const { safeWriteReview } = require('./lib/review-write-guard');
    for (const f of actionable) {
      const d = JSON.parse(fs.readFileSync(f.path, 'utf8'));
      markRescoreNeeded(d, FIX_REASON);
      const res = safeWriteReview(f.path, d, { force: true });
      if (res && res.wrote === false) { console.error(`[excerpt-scored-fulltext] write refused: ${f.rel} (${res.skipped || 'unknown'})`); continue; }
      fixed++;
    }
  }
  const remaining = actionable.length - fixed;
  if (argv.includes('--json')) {
    console.log(JSON.stringify({ counts, actionable: actionable.length, fixed, remaining, max, examples: actionable.slice(0, 20).map((f) => f.rel) }, null, 2));
  } else {
    console.log(`[excerpt-scored-fulltext] ${JSON.stringify(counts)}; actionable=${actionable.length} fixed=${fixed} remaining=${remaining}; threshold --max=${max}`);
    for (const f of actionable.slice(0, 20)) console.log(`    - ${f.rel}`);
  }
  process.exit(remaining > max && argv.some((a) => a.startsWith('--max')) ? 1 : 0);
}

if (require.main === module) main();
module.exports = { scan };
