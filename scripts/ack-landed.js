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
 *      blocked, failed, orphaned, prune-closed, dead, vanished, or
 *      watchdog-park — the watchdog's retries are exhausted and the job is
 *      dead until an owner relaunches it) — never a live launch/job-spawned,
 *      never job-done (nothing to ack), never an earlier landed-acked (no
 *      double-acks);
 *   2. `git fetch origin main`, then --sha is an ancestor of origin/main
 *      (scripts/lib/landing-verify.js checkLanded — shallow-safe);
 *   3. the sha is THIS job's work: AUTHORED after the launch row and before
 *      the terminal row (+5 min skew) — author date, because scripts/land.js
 *      rebases before pushing and only the committer date moves — and naming
 *      the ref in its message; for
 *      a job-stranded row it must be the stranded sha itself (or an ancestor
 *      of it) — the one case where the landing legitimately happens later;
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
 * --job-id (BRO-4066): every precondition above is normally evaluated
 * against the ref's LATEST ledger row, which breaks when a card is
 * re-dispatched after an EARLIER attempt had already landed — the latest
 * attempt's own terminal row (which may itself be job-done, landed-acked, or
 * another bad row) buries the earlier attempt's launch/terminal window, so
 * nothing can ever tie a sha to it again. Pass --job-id <jobId> (the jobId
 * from that attempt's own job-spawned/job-* rows) to scope every
 * precondition to THAT attempt instead; --id still validates the jobId
 * actually belongs to the card. Omit it for today's default (latest
 * attempt).
 *
 * Usage:
 *   node scripts/ack-landed.js --id BRO-3535 --sha c88cdf6c126 \
 *     --verify "node scripts/audit-workflow-concurrency.js" \
 *     --reason "owning session verified the split landed on origin/main"
 *   Options: --job-id X   scope preconditions to one dispatch attempt (see above)
 *            --no-linear   skip the Linear comment
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
  node scripts/ack-landed.js --id BRO-N --sha <commit> --verify "<safe-form acceptance command>" --reason "<why you are sure, >=15 chars>" [--job-id <jobId>] [--no-linear] [--acked-by <id>]

  --job-id <jobId>  scope every precondition to ONE dispatch attempt (its own
                     launch/job-spawned + terminal rows) instead of the ref's
                     latest — for acking an EARLIER attempt that landed after
                     the card was re-dispatched. Must be a jobId already on
                     this ref's ledger rows.
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
      case '--job-id': out.jobId = val(); break;
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
  const jobId = args.jobId || null;

  // 1. Ledger precondition first — cheap, and a plainly un-ackable ref must
  //    not trigger a fetch or a 10-minute verify run. When --job-id is given,
  //    scope to that ONE dispatch attempt (BRO-4066) so a later attempt's own
  //    terminal row (job-done/landed-acked/another bad row) never masks an
  //    earlier attempt's landing.
  const rows = core.rowsForRef(ledger.readEntries(), ref);
  const scoped = core.rowsForJobId(rows, jobId, ref);
  if (scoped.refusal) refuse(ref, [scoped.refusal]);
  const pre = core.ledgerPrecondition(scoped.rows);
  if (pre.refusals.length) refuse(ref, pre.refusals);
  console.error(`→ ledger: newest row for ${ref}${jobId ? ` (job ${jobId})` : ''} is ${pre.newest.event} (${pre.newest.ts}); launch ${pre.launch.ts}`);

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
  try {
    landing.commitTs = git(['show', '-s', '--format=%cI', sha]);
    landing.authorTs = git(['show', '-s', '--format=%aI', sha]);
    landing.message = git(['show', '-s', '--format=%B', sha]);
  } catch (e) {
    refuse(ref, [`could not read commit ${sha}: ${String(e.stderr || e.message).trim()}`]);
  }
  // job-stranded tie: --sha is the stranded sha itself, or an ancestor of it.
  landing.tiedToStranded = Boolean(
    pre.stranded && pre.stranded.sha
      && (String(pre.stranded.sha).startsWith(sha) || sha.startsWith(String(pre.stranded.sha))
        || gitOk(['merge-base', '--is-ancestor', sha, String(pre.stranded.sha)]))
  );
  console.error(`→ git: ${sha.slice(0, 11)} ${landing.verdict} on origin/main; authored ${landing.authorTs}, committed ${landing.commitTs}`);
  if (pre.launchVerifyCmd && pre.launchVerifyCmd !== args.verify.trim()) {
    console.error(`⚠️  --verify differs from the command recorded at dispatch (${pre.launchVerifyCmd}); both are kept on the ledger row`);
  }

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
  const dryRun = core.decideAck({ ref, rows, jobId, landing, checkout, verify: { ...verify, exitCode: 0 }, reason: args.reason, ackedBy });
  if (!dryRun.ok) refuse(ref, dryRun.refusals);

  console.error(`→ running verify in ${REPO}: ${verify.cmd}`);
  const run = spawnSync('bash', ['-c', verify.cmd], { cwd: REPO, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  verify.exitCode = run.status === null ? -1 : run.status;
  if (verify.exitCode !== 0) {
    const tail = `${run.stdout || ''}\n${run.stderr || ''}`.trim().split('\n').slice(-15).join('\n   | ');
    console.error(`   | ${tail}`);
  }

  const decision = core.decideAck({ ref, rows, jobId, landing, checkout, verify, reason: args.reason, ackedBy });
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
