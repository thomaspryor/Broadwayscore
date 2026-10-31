#!/usr/bin/env node
/**
 * audit-wrong-article-parity.js (BRO-3956): read-only. Counts review-texts files whose
 * contentVerification.wrongArticle is true and says whether the canonical
 * isRejectedNonReview() agrees, so the hand-rolled checks in gather-reviews.js and
 * merge-review-fields.js can be judged against real data.
 *
 *   node scripts/audit-wrong-article-parity.js [--root=data/review-texts] [--examples=3]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { listShowDirs } = require('./lib/list-show-dirs');
const { classifyWrongArticle } = require('./lib/wrong-article-parity');

function arg(name, dflt) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
}

function scan(root, maxExamples) {
  const tally = {};
  const examples = {};
  let files = 0;
  for (const show of listShowDirs(root, { silent: true })) {
    const dir = path.join(root, show);
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      files++;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { tally.unreadable = (tally.unreadable || 0) + 1; continue; }
      const c = classifyWrongArticle(data);
      if (!c) continue;
      tally[c.reason] = (tally[c.reason] || 0) + 1;
      const list = (examples[c.reason] = examples[c.reason] || []);
      if (list.length < maxExamples) list.push(`${show}/${f}`);
    }
  }
  return { files, tally, examples };
}

if (require.main === module) {
  const root = path.resolve(arg('root', 'data/review-texts'));
  if (!fs.existsSync(root)) { console.error(`no review texts at ${root} (run scripts/setup-local-data.sh)`); process.exit(2); }
  const { files, tally, examples } = scan(root, Math.max(0, Number(arg('examples', '3')) || 0));
  console.log(`${files} files scanned (unreadable files are counted in the tally)`);
  console.log(JSON.stringify({ tally, examples }, null, 2));
}

module.exports = { scan };
