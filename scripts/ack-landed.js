#!/usr/bin/env node
/**
 * ack-landed.js — the sanctioned way for the OWNING session to record that a
 * dispatched job's work landed when bsc-runner classified the job
 * job-stopped-short / job-stranded (or the tab died) but the commits really
 * reached origin/main.
 *
 * Gate O v2 (~/.claude/hooks/exit-status-gate.sh) blocks CLOSE ME / IDLE
 * while a DISPATCHED: ref's newest dispatch-ledger row is a bad one. Before
 * this script the only "fix" was editing the ledger by hand. Now the gate
 * accepts a `landed-acked` row that is newer than the last bad row, and this
 * script is the only thing that writes one — after re-verifying every claim
 * itself (decision logic: scripts/lib/ack-landed-core.js, pure + tested):
 *
 *   1. the ref's newest ledger row is terminal (stopped-short, stranded,
 *      blocked, failed, orphaned, prune-closed, dead, vanished) — never a
 *      live launch/job-spawned, never job-done (nothing to ack), never an
 *      earlier landed-acked (no double-acks);
 *   2. `git fetch origin main`, then --sha is an ancestor of origin/main
 *      (scripts/lib/landing-verify.js checkLanded — shallow-safe);
 *   3. the sha is THIS job's work: committed after the launch row and naming
 *      the ref in its message, or descending from a job-stranded row's sha;
 *   4. --verify is a safe-form command (the same allowlist linear-next.js
 *      applies to acceptance criteria) and it is RUN here, in the canonical
 *      checkout — which must already contain the sha and have no uncommitted
 *      changes under scripts/ src/ .github/ — and must exit 0;
 *   5. --reason is at least 15 characters.
 *
 * Then it appends {event:'landed-acked', taskId, jobId, sha, verifyCmd,
 * reason, ackedBy, ts} via dispatch-ledger.js appendEntry, best-effort posts
 * the same text as a Linear comment (--no-linear to skip), and prints one
 * line:  ACKED: BRO-N — <sha> on origin/main, <verifyCmd> exit 0
 *
 * Usage:
 *   node scripts/ack-landed.js --id BRO-3535 --sha c88cdf6c126 \
 *     --verify "node scripts/audit-workflow-concurrency.js" \
 *     --reason "owning session verified the split landed on origin/main"
 *   Options: --no-linear   skip the Linear comment
 *            --acked-by X  override the ackedBy stamp (default: $CLAUDE_CODE_SESSION_ID or 'manual')
 * Exit: 0 acked, 1 refused (every failed precondition is printed), 2 usage.
 */
'use strict';

const path = require('path');
const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const ledger = require('./lib/dispatch-ledger.js');
const { checkLanded } = require('./lib/landing-verify.js');
const { isSafeCheckCommand, explainUnsafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const core = require('./lib/ack-landed-core.js');

// Canonical checkout, hardcoded for the same reason dispatch-ledger.js
// hardcodes LEDGER_PATH: this is run from inside worktrees, and both the
// ledger and the origin/main ancestry check must refer to ONE repo.
const REPO = '/Users/tompryor/Broadwayscore';
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const CODE_PATHS = ['scripts', 'src', '.github', 'package.json', 'next.config.js', 'tsconfig.json'];

const USAGE = `ack-landed.js — record that a stopped-short/stranded dispatch's work landed (writes the ledger row Gate O v2 accepts).

Usage:
  node scripts/ack-landed.js --id BRO-N --sha <commit> --verify "<safe-form acceptance command>" --reason "<why you are sure, >=15 chars>" [--no-linear] [--acked-by <id>]
`;

function parseArgs(argv) {
  const out = { noLinear: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = eq > 0 ? a.slice(0, eq) : a;
    const val = () => (eq > 0 ? a.slice(eq + 1) : argv[++i]);
    switch (key) {
      case '--id': out.id = val(); break;
      case '--sha': out.sha = val(); break;
      case '--verify': out.verify = val(); break;
      case '--reason': out.reason = val(); break;
      case '--acked-by': out.ackedBy = val(); break;
      case '--no-linear': out.noLinear = true; break;
      default:
        return { error: `unknown argument: ${a}` };
    }
  }
  return out;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();
}

function gitOk(args) {
  const r = spawnSync('git', args, { cwd: REPO, encoding: 'utf8' });
  return r.status === 0;
}

function refuse(ref, refusals) {
  console.error(`❌ REFUSED: ${ref} not acked — ${refusals.length} failed precondition(s):`);
  for (const r of refusals) console.error(`   - ${r}`);
  console.error('   Nothing was written to the dispatch ledger.');
  process.exit(1);
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
  const args = parseArgs(argv);
  if (args.error) { console.error(args.error); console.error(USAGE); process.exit(2); }
  const ref = core.normalizeRef(args.id);
  if (!ref || !args.sha || !args.verify || !args.reason) {
    console.error('missing or malformed --id/--sha/--verify/--reason (id must be BRO-N)');
    console.error(USAGE);
    process.exit(2);
  }
  const ackedBy = args.ackedBy || process.env.CLAUDE_CODE_SESSION_ID || 'manual';

  // 1. Ledger precondition first — cheap, and a plainly un-ackable ref must
  //    not trigger a fetch or a 10-minute verify run.
  const rows = core.rowsForRef(ledger.readEntries(), ref);
  const pre = core.ledgerPrecondition(rows);
  if (pre.refusals.length) refuse(ref, pre.refusals);
  console.error(`→ ledger: newest row for ${ref} is ${pre.newest.event} (${pre.newest.ts}); launch ${pre.launch.ts}`);

  // 2. Fresh origin/main + ancestry (shallow-safe).
  try {
    git(['fetch', '--quiet', 'origin', 'main'], { timeout: 120000 });
  } catch (e) {
    refuse(ref, [`git fetch origin main failed: ${String(e.stderr || e.message).trim()}`]);
  }
  let sha;
  try {
    sha = git(['rev-parse', '--verify', `${args.sha}^{commit}`]);
  } catch {
    refuse(ref, [`${args.sha} is not a commit in ${REPO} (after fetching origin/main)`]);
  }
  const landing = checkLanded({ sha, cwd: REPO, log: (m) => console.error(`→ ${m}`) });
  landing.sha = sha;
  landing.commitTs = git(['show', '-s', '--format=%cI', sha]);
  landing.message = git(['show', '-s', '--format=%B', sha]);
  landing.descendsFromStranded = Boolean(
    pre.stranded && pre.stranded.sha && gitOk(['merge-base', '--is-ancestor', String(pre.stranded.sha), sha])
  );
  console.error(`→ git: ${sha.slice(0, 11)} ${landing.verdict} on origin/main; committed ${landing.commitTs}`);

  // 3. The checkout the verify command runs in must already prove origin/main.
  const checkout = {
    containsSha: gitOk(['merge-base', '--is-ancestor', sha, 'HEAD']),
    dirtyCodePaths: git(['status', '--porcelain', '--', ...CODE_PATHS])
      .split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/, '')),
  };

  // 4. Safe-form gate, then the real run. Everything above is decided BEFORE
  //    spending the run so an unsafe/untied ack never executes anything.
  const verify = { cmd: args.verify.trim(), safe: isSafeCheckCommand(args.verify.trim()), unsafeReason: null, exitCode: null };
  if (!verify.safe) verify.unsafeReason = (explainUnsafeCheckCommand(verify.cmd) || {}).reason || null;
  const dryRun = core.decideAck({ ref, rows, landing, checkout, verify: { ...verify, exitCode: 0 }, reason: args.reason, ackedBy });
  if (!dryRun.ok) refuse(ref, dryRun.refusals);

  console.error(`→ running verify in ${REPO}: ${verify.cmd}`);
  const run = spawnSync('bash', ['-c', verify.cmd], { cwd: REPO, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  verify.exitCode = run.status === null ? -1 : run.status;
  if (verify.exitCode !== 0) {
    const tail = `${run.stdout || ''}\n${run.stderr || ''}`.trim().split('\n').slice(-15).join('\n   | ');
    console.error(`   | ${tail}`);
  }

  const decision = core.decideAck({ ref, rows, landing, checkout, verify, reason: args.reason, ackedBy });
  if (!decision.ok) refuse(ref, decision.refusals);

  // 5. Write the row. appendEntry self-stamps ts (never backdated).
  const written = ledger.appendEntry(decision.row);
  console.error(`→ ledger row appended: ${JSON.stringify(written)}`);

  if (!args.noLinear) {
    const comment = `landed-acked by ${ackedBy} (${written.ts}): ${sha} is on origin/main; \`${verify.cmd}\` exit 0. Reason: ${decision.row.reason}. Prior ledger row: ${decision.row.priorEvent}.`;
    const lb = spawnSync('node', [path.join(REPO, 'scripts', 'linear-brain.js'), 'update', ref, '--comment', comment], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
    console.error(lb.status === 0
      ? `→ Linear comment posted on ${ref}`
      : `⚠️  Linear comment NOT posted on ${ref} (exit ${lb.status}): ${String(lb.stderr || lb.stdout || '').trim().split('\n').slice(-2).join(' ')} — the ledger row is the source of truth; re-post by hand if you want it on the card.`);
  }

  console.log(core.formatAckLine(ref, decision.row));
}

if (require.main === module) main();

module.exports = { parseArgs, CODE_PATHS, VERIFY_TIMEOUT_MS };
