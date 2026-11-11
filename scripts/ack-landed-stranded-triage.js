#!/usr/bin/env node
/**
 * ack-landed-stranded-triage.js (BRO-4081): list every card whose newest
 * dispatch-ledger row is job-stopped-short or job-stranded, check whether a
 * real work commit naming it is on origin/main, and (with --apply) ack the
 * landed ones through scripts/ack-landed.js and comment on the rest.
 *
 * Decisions come from scripts/lib/ack-landed-stranded-triage.js. Merge
 * commits, gate-bypass ledger commits and bookkeeping-only commits never
 * count as landing proof. ack-landed.js re-checks everything itself and
 * derives --sha, so a refusal there leaves the card untouched.
 *
 * The ledger (data/audit/dispatch-ledger.jsonl) is Mac-local: in a cloud
 * checkout this prints 0 candidates and exits 0.
 *
 * Usage:
 *   node scripts/ack-landed-stranded-triage.js            dry run (default)
 *   node scripts/ack-landed-stranded-triage.js --apply    ack + comment
 *   --no-linear   skip Linear reads/comments (no VERIFY lookup, so no acks)
 */
'use strict';

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const ledger = require('./lib/dispatch-ledger.js');
const { extractVerifyCmd } = require('./lib/autonomous-verify-cmd.js');
const { isSafeCheckCommand, explainUnsafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const { newestStrandedByRef, triageCard, currentVerifyCmd, hasTriageComment } = require('./lib/ack-landed-stranded-triage.js');
const { MAIN_REPO_ROOT: REPO } = require('./lib/repo-root');

const USAGE = 'Usage: node scripts/ack-landed-stranded-triage.js [--dry-run|--apply] [--no-linear]';
const MAX_COMMITS = 20;

function gitOut(args) {
  return execFileSync('git', ['-C', REPO, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 256 * 1024 * 1024,
  });
}

function namingCommits(ref) {
  let out = '';
  try {
    out = gitOut(['log', 'origin/main', '--fixed-strings', `--grep=${ref}`,
      `--max-count=${MAX_COMMITS}`, '--format=%H%x1f%s%x1f%b%x1e']);
  } catch { return []; }
  return out.split('\x1e').map(s => s.trim()).filter(Boolean).map((rec) => {
    const [sha, subject, body] = rec.split('\x1f');
    let files = [];
    try {
      files = gitOut(['show', '--no-renames', '--name-only', '--format=', '-m', '--first-parent', sha])
        .split('\n').map(s => s.trim()).filter(Boolean);
    } catch { /* unreadable: no files, so it is not proof */ }
    return { sha, subject, body, files };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const unknown = argv.filter(a => !['--apply', '--dry-run', '--no-linear'].includes(a));
  if (unknown.length) { console.error(`unknown argument: ${unknown[0]}\n${USAGE}`); return 2; }
  const apply = argv.includes('--apply');
  const noLinear = argv.includes('--no-linear');

  try { gitOut(['fetch', '--quiet', 'origin', 'main']); } catch { console.error('warning: git fetch origin main failed; using local origin/main'); }

  const candidates = newestStrandedByRef(ledger.readEntries());
  console.error(`-> ${candidates.length} card(s) whose newest ledger row is job-stopped-short/job-stranded.`);
  const linear = noLinear ? null : require('./lib/linear-client.js');

  const rows = [];
  for (const { ref, row } of candidates) {
    let issue = null;
    if (linear) {
      try { issue = await linear.getIssue(ref); } catch (e) { console.error(`${ref}: Linear read failed: ${e.message}`); }
    }
    const verifyCmd = currentVerifyCmd(issue, text => extractVerifyCmd(text, isSafeCheckCommand, explainUnsafeCheckCommand));
    const d = triageCard({ ref, row, commits: namingCommits(ref), verifyCmd });
    let result = d.action;
    if (apply && d.action === 'ack') {
      const res = spawnSync('node', [path.join(__dirname, 'ack-landed.js'), ...d.ackArgs], { encoding: 'utf8', timeout: 10 * 60 * 1000 });
      result = res.status === 0 ? 'acked' : `ack-refused: ${`${res.stdout || ''}\n${res.stderr || ''}`.trim().split('\n').filter(Boolean).slice(-2).join(' | ')}`;
    } else if (apply && d.action === 'not-landed' && issue && hasTriageComment(issue)) {
      result = 'not-landed (already commented)';
    } else if (apply && d.action === 'not-landed' && issue && issue.id) {
      try { await linear.createComment(issue.id, d.comment); result = 'not-landed (commented)'; } catch (e) { result = `not-landed (comment failed: ${e.message})`; }
    }
    rows.push({ ref, event: row.event, result, detail: d.detail });
  }

  console.log('| ref | ledger | result | detail |\n|---|---|---|---|');
  for (const r of rows) console.log(`| ${r.ref} | ${r.event} | ${r.result} | ${String(r.detail).replace(/\|/g, '\\|')} |`);
  const counts = rows.reduce((a, r) => { const k = r.result.split(':')[0]; a[k] = (a[k] || 0) + 1; return a; }, {});
  console.log(`Summary (${apply ? '--apply' : '--dry-run'}): ${JSON.stringify(counts)}`);
  return 0;
}

if (require.main === module) {
  main().then(code => process.exit(code), (e) => { console.error(e); process.exit(1); });
}
