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
 * --already-landed (BRO-4069): the sibling case --job-id cannot fix — the
 * ref's real work landed BEFORE ANY dispatch attempt on its ledger even
 * launched (every attempt was a mistaken re-dispatch of an already-done
 * card, so no jobId's own window can ever tie the sha to it). Asserts the
 * OPPOSITE timing: --sha must be authored before the ref's EARLIEST
 * launch/job-spawned row, not after some attempt's. Writes a distinct
 * `landed-before-dispatch` row (never `landed-acked`, so the no-op
 * re-dispatch isn't misrecorded as productive work). Cannot be combined
 * with --job-id — "before ANY dispatch" is ledger-wide, not attempt-scoped.
 * decision logic: scripts/lib/ack-landed-core.js decideAlreadyLanded().
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
  --already-landed  assert the sha was authored BEFORE the ref's EARLIEST
                     dispatch launch (the opposite of the default tie) —
                     for a card whose work already existed before it was
                     ever (mistakenly) dispatched. Writes a distinct
                     landed-before-dispatch row. Cannot combine with --job-id.
`;

function parseArgs(argv) {
  const out = { noLinear: false, alreadyLanded: false };
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
      case '--already-landed': out.alreadyLanded = true; break;
      default:
        return { error: `unknown argument: ${a}` };
    }
  }
  if (out.alreadyLanded && out.jobId) {
    return { error: '--already-landed cannot be combined with --job-id — "before ANY dispatch" is ledger-wide, not attempt-scoped' };
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

// BRO-4068: the naming refusal used to say only "pass the job's own commit,
// not an unrelated one" — true, but it never said WHICH commit would do. A
// session hit it on BRO-4066, concluded from the bare refusal that the card
// "can never be acked", and filed a P2 asking to relax the precondition. Two
// of that landing's three shas named the card and would have been accepted
// immediately; the one being passed named no card at all. A refusal that can
// be mistaken for a dead end is how a correct guard gets argued away, so the
// refusal now does the lookup itself and prints the shas that WOULD satisfy
// it.
//
// Returns null = the lookup could not run, [] = it ran and matched nothing,
// rows = candidates. Never throws, and never blocks the refusal it decorates.
function namingCandidates(ref, launchTs, terminalTs, opts = {}) {
  if (!ref) return [];
  // cwd/base are injectable so this can be tested against a throwaway repo.
  // The repo's own CI checks out at actions/checkout's default depth of 1, so
  // a test that reads real history here would pass locally and fail in CI --
  // worse than no test. Defaults are the production values.
  const cwd = opts.cwd || REPO;
  const base = opts.base || 'origin/main';
  // The window is filtered HERE, not with --since/--until: those bound the
  // COMMIT date, while the timing precondition above judges the AUTHOR date.
  // On a rebase-landed branch those differ by minutes, and using git's own
  // flags silently returned zero candidates for exactly the case this hint
  // exists to serve (BRO-4066's commits were authored inside the window and
  // committed ~2 min after the terminal row).
  // -z gives NUL-separated records, which is what lets %B (the FULL message)
  // ride along: a card id is routinely in the body, not the subject, so
  // matching on %s alone would reject the very commits this hint exists to
  // offer. Fields stay tab-separated inside each record.
  const args = ['log', base, '--no-merges', '-z', '--format=%h%x09%aI%x09%s%x09%B',
    // --max-count applies AFTER --grep, so this is 1000 MATCHING commits, not
    // 1000 commits scanned. It is raised well past any plausible real count
    // because the anchored filter below thins these further: a card id that
    // shares a prefix with noisier siblings would otherwise see the true
    // match crowded out of the window (review P2).
    '-n', '1000', `--grep=${ref}`, '-i'];
  // maxBuffer is NOT optional here. %B pulls full commit bodies, so -n 1000
  // can exceed spawnSync's 1 MiB default: measured on this repo, --grep=BRO-3
  // returns 817 records / 1,198,347 bytes and overflows, while -n 400 fits at
  // 550,319. Overflow sets status null + ENOBUFS, which lands in the null
  // branch below -- honest, but it turns a working hint into "could not
  // search" for exactly the high-match ids the cap was raised to serve. The
  // threshold also moves as history grows, so this is sized well past it.
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  // null = the lookup could not run (no origin/main, shallow clone, git
  // missing, a ref git's own regex rejects); [] = it ran and found nothing.
  // Collapsing the two let the caller print "no commit names this card" on a
  // lookup that never happened — a confident dead end it had not established,
  // which is the same false conclusion that produced BRO-4068 in the first
  // place (adversarial review catch).
  if (r.status !== 0) return null;
  if (!r.stdout) return [];
  const lo = Date.parse(launchTs || '');
  const hi = Date.parse(terminalTs || '');
  // --already-landed mode: decideAlreadyLanded wants the sha authored
  // STRICTLY before the ref's earliest launch, with no lower bound.
  const before = Date.parse(opts.beforeTs || '');
  const out = [];
  for (const record of r.stdout.split('\0')) {
    if (!record.trim()) continue;
    const [sha, authored, subject, ...bodyParts] = record.split('\t');
    const fullMessage = bodyParts.join('\t');
    // --grep is an unanchored SUBSTRING match, so BRO-406 also matches
    // BRO-4066/BRO-4060. Re-test each hit with core's own anchored predicate
    // so the hint can never offer a sha the guard would then refuse.
    if (!core.messageNamesRef(fullMessage, ref)) continue;
    const at = Date.parse(authored || '');
    // An unreadable author date is refused by both decide functions, so it
    // is never a usable suggestion.
    if (!Number.isFinite(at)) continue;
    // Mirror the deciding function's own bounds, so a suggestion can never
    // trade the naming refusal for the timing one.
    if (Number.isFinite(before) && at >= before) continue;
    if (Number.isFinite(lo) && Number.isFinite(at) && at <= lo) continue;
    if (Number.isFinite(hi) && Number.isFinite(at) && at > hi + core.COMMIT_AFTER_TERMINAL_GRACE_MS) continue;
    out.push({ sha, authored, subject });
    if (out.length >= 5) break;
  }
  return out;
}

function refuse(ref, refusals, ctx = {}) {
  console.error(`❌ REFUSED: ${ref} not acked — ${refusals.length} failed precondition(s):`);
  for (const r of refusals) console.error(`   - ${r}`);
  if (refusals.some(r => /does not name/.test(String(r)))) {
    const where = ctx.alreadyLanded ? `before ${ref}'s earliest dispatch launch (${ctx.beforeTs})` : "inside this job's window";
    // decideAlreadyLanded refuses EVERY sha while any launch row has an
    // unreadable ts, so offering candidates then would only trade refusals.
    const noTiming = ctx.alreadyLanded && (!Number.isFinite(Date.parse(ctx.beforeTs || ''))
      || refusals.some(r => /unreadable ts/.test(String(r))));
    const cands = noTiming
      ? undefined
      : namingCandidates(ref, ctx.launchTs, ctx.terminalTs, { beforeTs: ctx.beforeTs });
    if (cands === undefined) {
      console.error(`   → ${ref}'s dispatch launch timestamps are not all readable, so no sha can satisfy --already-landed's timing check — no candidates offered.`);
    } else if (cands === null) {
      console.error('   → could not search origin/main for commits naming it (no origin/main here, a shallow');
      console.error('     clone, or git refused the query) — this is NOT evidence that no such commit exists.');
    } else if (cands.length) {
      console.error(`   → these commits on origin/main DO name ${ref} and fall ${where} — pass one as --sha:`);
      for (const c of cands) console.error(`       ${c.sha}  ${c.authored}  ${String(c.subject).slice(0, 62)}`);
    } else {
      console.error(`   → no commit on origin/main names ${ref} ${where}. If the work really did land`);
      console.error(ctx.alreadyLanded
        ? '     after a dispatch launched, drop --already-landed (optionally pass --job-id) and ack that attempt instead.'
        : '     under commits that never mention the card, that is the case --job-id does not cover — say so on the card.');
    }
  }
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
  const alreadyLanded = Boolean(args.alreadyLanded);
  // core.decideAck / core.decideAlreadyLanded, picked once up front — the
  // two share every step below except which decision function ultimately
  // runs (BRO-4069: decideAlreadyLanded asserts the OPPOSITE sha timing and
  // never accepts a jobId — see its header in ack-landed-core.js).
  const decide = (extra) => (alreadyLanded
    ? core.decideAlreadyLanded({ ref, rows, landing, checkout, reason: args.reason, ackedBy, ...extra })
    : core.decideAck({ ref, rows, jobId, landing, checkout, reason: args.reason, ackedBy, ...extra }));

  // 1. Ledger precondition first — cheap, and a plainly un-ackable ref must
  //    not trigger a fetch or a 10-minute verify run. When --job-id is given,
  //    scope to that ONE dispatch attempt (BRO-4066) so a later attempt's own
  //    terminal row (job-done/landed-acked/another bad row) never masks an
  //    earlier attempt's landing. --already-landed never scopes by jobId —
  //    "before ANY dispatch" is ledger-wide (parseArgs already refuses the
  //    combination).
  const rows = core.rowsForRef(ledger.readEntries(), ref);
  const scoped = core.rowsForJobId(rows, jobId, ref);
  if (scoped.refusal) refuse(ref, [scoped.refusal]);
  const pre = core.ledgerPrecondition(scoped.rows);
  if (pre.refusals.length) refuse(ref, pre.refusals);
  // core.earliestLaunch(rows) can be null (or resolve to a launch row with a
  // malformed ts) even when ledgerPrecondition's own coarser `!launch` check
  // above passed — that check only asks "does a launch/job-spawned row exist
  // at all", not "does the EARLIEST one have a readable ts". Guard here so a
  // corrupt ledger row degrades this informational log line, not a crash;
  // decide() below still refuses cleanly either way (decideAlreadyLanded's
  // own !launch / malformedLaunchTs checks).
  const earliestLaunchRow = alreadyLanded ? core.earliestLaunch(rows) : null;
  const earliestLaunchTs = alreadyLanded ? (earliestLaunchRow ? earliestLaunchRow.ts : '(none readable)') : pre.launch.ts;
  console.error(`→ ledger: newest row for ${ref}${jobId ? ` (job ${jobId})` : ''} is ${pre.newest.event} (${pre.newest.ts}); ${alreadyLanded ? 'earliest launch' : 'launch'} ${earliestLaunchTs}`);
  // The naming hint's window must mirror the decision that will judge the
  // suggested sha, or a suggestion just trades the naming refusal for a
  // timing one. decideAck: (launch, terminal + grace]. decideAlreadyLanded:
  // strictly before the EARLIEST launch — pre.launch is the latest one here,
  // because --already-landed never scopes rows by jobId.
  const hintCtx = alreadyLanded
    ? { alreadyLanded: true, beforeTs: earliestLaunchRow ? earliestLaunchRow.ts : null }
    : { launchTs: pre.launch.ts, terminalTs: pre.newest.ts };

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
  const dryRun = decide({ verify: { ...verify, exitCode: 0 } });
  if (!dryRun.ok) refuse(ref, dryRun.refusals, hintCtx);

  console.error(`→ running verify in ${REPO}: ${verify.cmd}`);
  const run = spawnSync('bash', ['-c', verify.cmd], { cwd: REPO, encoding: 'utf8', timeout: VERIFY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  verify.exitCode = run.status === null ? -1 : run.status;
  if (verify.exitCode !== 0) {
    const tail = `${run.stdout || ''}\n${run.stderr || ''}`.trim().split('\n').slice(-15).join('\n   | ');
    console.error(`   | ${tail}`);
  }

  const decision = decide({ verify });
  if (!decision.ok) refuse(ref, decision.refusals, hintCtx);

  // 5. Write the row. appendEntry self-stamps ts (never backdated).
  const written = ledger.appendEntry(decision.row);
  console.error(`→ ledger row appended: ${JSON.stringify(written)}`);

  if (!args.noLinear) {
    const comment = `${decision.row.event} by ${ackedBy} (${written.ts}): ${sha} is on origin/main; \`${verify.cmd}\` exit 0. Reason: ${decision.row.reason}. Prior ledger row: ${decision.row.priorEvent}.`;
    const lb = spawnSync('node', [path.join(REPO, 'scripts', 'linear-brain.js'), 'update', ref, '--comment', comment], { cwd: REPO, encoding: 'utf8', timeout: 60000 });
    console.error(lb.status === 0
      ? `→ Linear comment posted on ${ref}`
      : `⚠️  Linear comment NOT posted on ${ref} (exit ${lb.status}): ${String(lb.stderr || lb.stdout || '').trim().split('\n').slice(-2).join(' ')} — the ledger row is the source of truth; re-post by hand if you want it on the card.`);
  }

  console.log(core.formatAckLine(ref, decision.row));
}

if (require.main === module) main();

module.exports = { parseArgs, CODE_PATHS, VERIFY_TIMEOUT_MS, namingCandidates };
