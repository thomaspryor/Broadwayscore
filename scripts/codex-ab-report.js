#!/usr/bin/env node
/**
 * BRO-6236: Codex reasoning-effort A/B table, read from the "## Codex runner" summaries on BRO-4745.
 *   node scripts/codex-ab-report.js [--since=YYYY-MM-DD] [--lane=gha|cloud] [--json]
 * One row per effort: cards worked, landed+Done, landed part, already fixed, rejected by the
 * Claude check, runner errors, minutes per card. Decide by landed rate (landed + partial) per card.
 */
const R = require('./lib/codex-runner.js');
const { listIssueComments } = require('./lib/linear-client.js');

const arg = (n, d) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.slice(n.length + 3) : d; };

(async () => {
  const card = arg('card', process.env.CODEX_RUNNER_CARD || 'BRO-4745');
  const since = arg('since', '');
  const comments = (await listIssueComments([card])).get(card) || [];
  const runs = comments.filter((c) => String(c.body || '').startsWith('## Codex runner'));
  const rep = R.abReport(runs.map((c) => c.body), { lane: arg('lane', 'gha'), sinceMs: since ? Date.parse(since) : 0, createdAtMs: runs.map((c) => Date.parse(c.createdAt) || 0) });
  if (process.argv.includes('--json')) { console.log(JSON.stringify(rep, null, 2)); return; }
  const pct = (n, d) => (d ? `${Math.round((100 * n) / d)}%` : 'n/a');
  console.log('| effort | cards | landed+Done | landed part | already fixed | rejected | errors | other | landed rate | min/card |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const [e, r] of Object.entries(rep).sort()) {
    console.log(`| ${e} | ${r.cards} | ${r.landed} | ${r.partial} | ${r.alreadyFixed} | ${r.rejected} | ${r.error} | ${r.other} | ${pct(r.landed + r.partial, r.cards)} | ${r.cards ? (r.mins / r.cards).toFixed(1) : 'n/a'} |`);
  }
  if (!Object.keys(rep).length) console.log('(no run summaries with a "Codex settings" line yet)');
})().catch((e) => { console.error(e.message); process.exit(1); });
