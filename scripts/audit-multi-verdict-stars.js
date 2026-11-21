#!/usr/bin/env node
/**
 * audit-multi-verdict-stars.js (BRO-4490): find multi-review articles (FT
 * columns reviewing several shows, one star verdict each) whose stored star is
 * another show's section star, or whose section cannot be told apart.
 *
 * Read-only by default. --write-plan=<bro-N> writes data/pending-fixes/<bro-N>.json
 * with one review-field-edit originalScore action per mismatch (stored star
 * present and wrong; the section's star replaces it via
 * verified-original-score.js, which also lets late-star-anchor re-anchor the
 * stale band). Ambiguous files are reported only: no star can be chosen.
 *
 * Usage:
 *   node scripts/audit-multi-verdict-stars.js [--json] [--write-plan=bro-N]
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { hasHelpFlag } = require('./lib/cli-help.js');
const { listShowDirs } = require('./lib/list-show-dirs');
const { multiVerdictStarStatus, MULTI_VERDICT_OUTLETS } = require('./lib/multi-verdict-sections');
const { MAX_PLAN_ACTIONS } = require('./lib/pending-fix-limits.js');

const USAGE = `audit-multi-verdict-stars.js: stored stars on multi-review articles that belong to another show's section.

Usage:
  node scripts/audit-multi-verdict-stars.js [--json] [--write-plan=bro-N]
  node scripts/audit-multi-verdict-stars.js --help, -h    print this usage and exit
`;

const ROOT = path.join(__dirname, '..');
const REVIEW_DIR = path.join(ROOT, 'data', 'review-texts');

function scan() {
  const rows = [];
  for (const dir of listShowDirs(REVIEW_DIR)) {
    const showDir = path.join(REVIEW_DIR, dir);
    for (const file of fs.readdirSync(showDir)) {
      if (!file.endsWith('.json') || file.startsWith('_')) continue;
      if (![...MULTI_VERDICT_OUTLETS].some((o) => file.startsWith(`${o}--`))) continue;
      let data;
      try { data = JSON.parse(fs.readFileSync(path.join(showDir, file), 'utf8')); } catch { continue; }
      const res = multiVerdictStarStatus(data, data.showTitle || require('./lib/known-show-titles').showTitleForId(dir));
      if (res.kind === 'single') continue;
      rows.push({ file: `${dir}/${file}`, kind: res.kind, stored: res.stored ?? null, want: res.want || null,
        sections: res.verdict.sections, mentions: res.verdict.mentions });
    }
  }
  return rows;
}

function buildPlan(issue, rows) {
  const fixes = rows.filter((r) => r.kind === 'mismatch' && r.stored);
  if (fixes.length > MAX_PLAN_ACTIONS) throw new Error(`${fixes.length} fixes exceed MAX_PLAN_ACTIONS ${MAX_PLAN_ACTIONS}`);
  return {
    issueNumber: issue,
    planId: crypto.randomUUID(),
    status: 'pending',
    createdAt: new Date().toISOString(),
    submitter: { name: null, email: null },
    plan: {
      summary: `${issue}: ${fixes.length} FT multi-review columns store another show's section star; set each to its own section's star (scripts/lib/multi-verdict-sections.js).`,
      steps: [
        'Each originalScore is the star run that ends the section naming this show (audit-multi-verdict-stars.js).',
        'verified-original-score.js writes the rating set; late-star-anchor re-anchors the stale band on the next cron.',
      ],
      riskLevel: 'low',
      actions: fixes.map((r) => ({
        type: 'review-field-edit', file: r.file, field: 'originalScore', oldValue: r.stored, newValue: r.want,
        description: `${r.file}: multi-review FT column; the section naming this show ends ${r.want}, stored ${r.stored} is another section's star (mentions per section ${JSON.stringify(r.mentions)}).`,
      })),
    },
  };
}

function main() {
  const args = process.argv.slice(2);
  if (hasHelpFlag(args)) { console.log(USAGE); return; }
  const rows = scan();
  const planArg = args.find((a) => a.startsWith('--write-plan='));
  if (args.includes('--json')) console.log(JSON.stringify(rows, null, 2));
  else {
    for (const r of rows) console.log(`${r.kind.padEnd(9)} ${r.file} stored=${r.stored} want=${r.want || '-'} mentions=${JSON.stringify(r.mentions)}`);
    const by = rows.reduce((m, r) => ({ ...m, [r.kind]: (m[r.kind] || 0) + 1 }), {});
    console.log(`\n${rows.length} multi-review files: ${JSON.stringify(by)}`);
  }
  if (planArg) {
    const issue = planArg.split('=')[1];
    if (!/^bro-\d+(-[a-z])?$/.test(issue)) throw new Error(`--write-plan needs bro-N, got ${issue}`);
    const out = path.join(ROOT, 'data', 'pending-fixes', `${issue}.json`);
    if (fs.existsSync(out)) throw new Error(`${out} exists; refusing to overwrite`);
    const plan = buildPlan(issue, rows);
    fs.writeFileSync(out, JSON.stringify(plan, null, 2) + '\n');
    console.log(`Wrote ${out} (${plan.plan.actions.length} actions)`);
  }
}

if (require.main === module) main();
module.exports = { buildPlan };
