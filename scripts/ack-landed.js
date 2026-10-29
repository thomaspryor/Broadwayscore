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
 *      a job-stranded row it must be the stranded tip itself (or its rebased
 *      patch twin), the one case where the landing legitimately happens later;
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
 * --job-id also accepts a correlationId (BRO-4133): a legacy cmux dispatch
 * attempt never had a jobId at all — only a correlationId on its own
 * `launch` row. When the value passed doesn't match any row's jobId,
 * ack-landed-core.js's rowsForJobId falls back to treating it as a
 * correlationId and scopes to that launch row's own window (through the
 * next launch for this ref) — so a card whose real work landed under a
 * pre-jobId cmux attempt is no longer structurally unackable.
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
 * --landed-elsewhere (BRO-4662): the last cell of the matrix. Every attempt
 * produced nothing and the card's work landed LATER by a route that writes
 * no ledger rows (a crowned OWNER tab). The sha must name the card, be
 * authored after the earliest launch, and fall outside every attempt's own
 * window (so it can't relabel an attempt's work). Writes a distinct
 * `landed-outside-dispatch` row: the failed job stays recorded as failed,
 * the card is recorded satisfied. Real case: BRO-4137. decision logic:
 * ack-landed-core.js decideLandedElsewhere().
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

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawnSync } = require('child_process');
const { hasHelpFlag } = require('./lib/cli-help.js');
const ledger = require('./lib/dispatch-ledger.js');
const { checkLanded } = require('./lib/landing-verify.js');
const { isSafeCheckCommand, explainUnsafeCheckCommand } = require('./lib/autonomous-triage-core.js');
const core = require('./lib/ack-landed-core.js');
const { computeStrandedTie } = require('./lib/ack-landed-stranded-tie.js');

// Canonical checkout, hardcoded for the same reason dispatch-ledger.js
// hardcodes LEDGER_PATH: this is run from inside worktrees, and both the
// ledger and the origin/main ancestry check must refer to ONE repo.
const { MAIN_REPO_ROOT: MAIN } = require('./lib/repo-root');
// The repo the sha is checked in. Broadwayscore unless --data-repo points it at
// a private data repo (BRO-5219); main() reassigns it before any git call, so
// every git()/gitOk()/`opts.cwd || REPO` site below follows. The ledger, the
// verify run and the Linear update always stay in MAIN.
let REPO = MAIN;
// --data-repo names → clone paths. review-texts honours REVIEW_TEXTS_DIR (the
// same variable validate-data.js and the gap audit read); core-data is the
// clone data/shows.json etc. already symlink into.
const DATA_REPOS = {
  'review-texts': { slug: 'thomaspryor/broadway-review-texts', dir: (env) => env.REVIEW_TEXTS_DIR || path.join(os.homedir(), 'broadway-review-texts') },
  'core-data': { slug: 'thomaspryor/broadway-scorecard-data', dir: () => require('./lib/autonomous-data-workdir').scorecardDataRoot() },
};
// origin must be the real private repo, not any clone with an origin/main (a
// local dummy origin could otherwise host an in-window commit naming the
// card). Credentials embedded in the URL are stripped and never printed.
function originMatchesSlug(url, slug) {
  const m = /github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim().replace(/\/\/[^@/]+@/, '//'));
  return Boolean(m) && m[1].toLowerCase() === slug.toLowerCase();
}
const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;
const CODE_PATHS = ['scripts', 'src', '.github', 'package.json', 'next.config.js', 'tsconfig.json'];

const USAGE = `ack-landed.js — record that a stopped-short/stranded dispatch's work landed (writes the ledger row Gate O v2 accepts).

Usage:
  node scripts/ack-landed.js --id BRO-N [--sha <commit>] --verify "<safe-form acceptance command>" --reason "<why you are sure, >=15 chars>" [--job-id <jobId>] [--no-linear] [--acked-by <id>] [--data-repo review-texts|core-data]

  --data-repo <name> the work landed in a private data repo, not Broadwayscore
                     (BRO-5219): review-texts (~/broadway-review-texts, or
                     $REVIEW_TEXTS_DIR) or core-data (~/broadway-scorecard-data).
                     Every git check (fetch, ancestry, naming, timing) runs in
                     that clone; --verify still runs in the main checkout, with
                     REVIEW_TEXTS_DIR set to the clone for review-texts (core
                     data is already symlinked into it). A job-stranded row's
                     sha is then not usable as the tie, so the sha must instead
                     be authored inside the job's window AND name the card.
                     Checks derived from reviews.json may lag the clone until
                     the next CI rebuild.

  --sha <commit>    optional. Omitted: derived from origin/main — the newest
                     commit naming BRO-N inside the window the chosen mode
                     judges by; refuses if there is none (BRO-4071).
  --job-id <jobId>  scope every precondition to ONE dispatch attempt (its own
                     launch/job-spawned + terminal rows) instead of the ref's
                     latest — for acking an EARLIER attempt that landed after
                     the card was re-dispatched. Must be a jobId already on
                     this ref's ledger rows, OR a correlationId on one of its
                     launch rows (legacy cmux attempts have no jobId at all).
  --already-landed  assert the sha was authored BEFORE the ref's EARLIEST
                     dispatch launch (the opposite of the default tie) —
                     for a card whose work already existed before it was
                     ever (mistakenly) dispatched. Writes a distinct
                     landed-before-dispatch row. Cannot combine with --job-id.
  --landed-elsewhere every dispatch attempt produced nothing and the card's
                     work landed LATER by a route that writes no ledger rows
                     (an owner tab, a hand fix). The sha must name the card
                     and be authored after the earliest launch but outside
                     every attempt's own window. Writes a distinct
                     landed-outside-dispatch row (the failed job stays failed).
                     Cannot combine with --job-id or --already-landed.
`;

function parseArgs(argv) {
  const out = { noLinear: false, alreadyLanded: false, landedElsewhere: false };
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
      case '--landed-elsewhere': out.landedElsewhere = true; break;
      case '--data-repo': out.dataRepo = val(); break;
      default:
        return { error: `unknown argument: ${a}` };
    }
  }
  if (out.landedElsewhere && (out.alreadyLanded || out.jobId)) {
    return { error: '--landed-elsewhere cannot be combined with --already-landed or --job-id — it judges the sha against EVERY dispatch attempt on the card, not one' };
  }
  if (out.alreadyLanded && out.jobId) {
    return { error: '--already-landed cannot be combined with --job-id — "before ANY dispatch" is ledger-wide, not attempt-scoped' };
  }
  return out;
}

// Resolve a --data-repo name to its clone, refusing anything that is not a git
// work tree with an origin/main (a missing clone must not silently fall back
// to Broadwayscore). Exported for tests.
function resolveDataRepo(name, env = process.env, opts = {}) {
  const spec = Object.prototype.hasOwnProperty.call(DATA_REPOS, name) ? DATA_REPOS[name] : null;
  if (!spec) return { error: `--data-repo must be one of: ${Object.keys(DATA_REPOS).join(', ')} (got ${JSON.stringify(name)})` };
  const dir = spec.dir(env);
  const inside = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: dir, encoding: 'utf8' });
  if (inside.status !== 0 || String(inside.stdout).trim() !== 'true') return { error: `--data-repo ${name}: ${dir} is not a git work tree` };
  const top = String(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8' }).stdout || '').trim();
  const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
  if (real(top) !== real(dir)) return { error: `--data-repo ${name}: ${dir} is inside ${top}, not its own clone` };
  if (real(dir) === real(opts.main || MAIN)) return { error: `--data-repo ${name}: ${dir} is the main checkout, not a data repo` };
  const origin = spawnSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' });
  if (!originMatchesSlug(origin.stdout, spec.slug)) {
    return { error: `--data-repo ${name}: ${dir}'s origin is not github.com/${spec.slug}` };
  }
  if (spawnSync('git', ['rev-parse', '--verify', 'refs/remotes/origin/main'], { cwd: dir, encoding: 'utf8' }).status !== 0) {
    return { error: `--data-repo ${name}: ${dir} has no origin/main` };
  }
  return { name, path: dir };
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
    // --landed-elsewhere: drop shas its own decision would refuse (inside an
    // attempt window, bookkeeping-only), BEFORE the 5-cap, so a refused newer
    // commit cannot crowd out a valid older one (ship-check P2).
    if (typeof opts.accept === 'function' && !opts.accept(sha, at)) continue;
    out.push({ sha, authored, subject });
    if (out.length >= 5) break;
  }
  return out;
}

// Commits on origin/main that name `ref` inside the window the decision will
// judge them by (ctx = main()'s hintCtx). Shared by the refusal hint and by
// --sha derivation (BRO-4071) so the two can never disagree. undefined = no
// sha can pass --already-landed's timing check (unreadable launch ts);
// null = the search itself failed; [] = searched, none.
function candidatesFor(ref, ctx, refusals = [], opts = {}) {
  // decideAlreadyLanded refuses EVERY sha while any launch row has an
  // unreadable ts, so offering candidates then would only trade refusals.
  const noTiming = ctx.alreadyLanded && (!Number.isFinite(Date.parse(ctx.beforeTs || ''))
    || refusals.some(r => /unreadable ts/.test(String(r))));
  const accept = ctx.landedElsewhere ? (sha, at) => landedElsewhereCandidateOk(sha, at, ctx.windows, opts.cwd) : undefined;
  return noTiming ? undefined : namingCandidates(ref, ctx.launchTs, ctx.terminalTs, { ...opts, beforeTs: ctx.beforeTs, accept });
}

// Same window + bookkeeping rules decideLandedElsewhere applies, so a derived
// or suggested sha is never one the decision then refuses.
function landedElsewhereCandidateOk(sha, at, windows, cwd) {
  const inside = (windows || []).some((w) => {
    const lo = Date.parse(w.launchTs || '');
    const end = w.endTs == null ? NaN : Date.parse(w.endTs);
    const hi = Number.isFinite(end) ? end + core.COMMIT_AFTER_TERMINAL_GRACE_MS : Infinity;
    return Number.isFinite(lo) && at >= lo && at <= hi;
  });
  if (inside) return false;
  const r = spawnSync('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', '--first-parent', sha], { cwd: cwd || REPO, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return false;
  return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).some((f) => !core.isBookkeepingPath(f));
}

function whereFor(ref, ctx) {
  if (ctx.alreadyLanded) return `before ${ref}'s earliest dispatch launch (${ctx.beforeTs})`;
  if (ctx.landedElsewhere) return `after ${ref}'s earliest dispatch launch (${ctx.launchTs})`;
  return "inside this job's window";
}

function refuse(ref, refusals, ctx = {}) {
  console.error(`❌ REFUSED: ${ref} not acked — ${refusals.length} failed precondition(s):`);
  for (const r of refusals) console.error(`   - ${r}`);
  if (refusals.some(r => /does not name/.test(String(r)))) {
    const where = whereFor(ref, ctx);
    const cands = candidatesFor(ref, ctx, refusals);
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
        : ctx.landedElsewhere
          ? '     under commits that never mention the card, --landed-elsewhere cannot certify it (by design) — say so on the card.'
          : '     after every dispatch attempt ended, by a route outside the ledger, use --landed-elsewhere.');
    }
  }
  console.error('   Nothing was written to the dispatch ledger.');
  process.exit(1);
}

// The verify command is RUN here and its real exit code — never an assumed
// 0 — is what the final decision sees. Extracted (BRO-4662) so a test can
// prove the accepted path actually executes the command, against a throwaway
// cwd, through the same function main() uses.
function runVerifyAndDecide(decide, verify, opts = {}) {
  const run = spawnSync('bash', ['-c', verify.cmd], { cwd: opts.cwd || MAIN, env: opts.env ? { ...process.env, ...opts.env } : process.env, encoding: 'utf8', timeout: opts.timeoutMs || VERIFY_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 });
  verify.exitCode = run.status === null ? -1 : run.status;
  if (verify.exitCode !== 0) {
    const tail = `${run.stdout || ''}\n${run.stderr || ''}`.trim().split('\n').slice(-15).join('\n   | ');
    console.error(`   | ${tail}`);
  }
  return decide({ verify });
}

function main() {
  const argv = process.argv.slice(2);
  if (hasHelpFlag(argv)) { console.log(USAGE); process.exit(0); }
  const args = parseArgs(argv);
  if (args.error) { console.error(args.error); console.error(USAGE); process.exit(2); }
  const ref = core.normalizeRef(args.id);
  if (!ref || !args.verify || !args.reason) {
    console.error('missing or malformed --id/--verify/--reason (id must be BRO-N)');
    console.error(USAGE);
    process.exit(2);
  }
  const ackedBy = args.ackedBy || process.env.CLAUDE_CODE_SESSION_ID || 'manual';
  let dataRepo = null;
  if (args.dataRepo !== undefined) {
    dataRepo = resolveDataRepo(args.dataRepo);
    if (dataRepo.error) { console.error(dataRepo.error); process.exit(2); }
    REPO = dataRepo.path;
    console.error(`→ --data-repo ${dataRepo.name}: git checks run in ${REPO}; verify runs in ${MAIN}`);
  }
  const dataRepoName = dataRepo ? dataRepo.name : undefined;
  const jobId = args.jobId || null;
  const alreadyLanded = Boolean(args.alreadyLanded);
  const landedElsewhere = Boolean(args.landedElsewhere);
  // core.decideAck / core.decideAlreadyLanded, picked once up front — the
  // two share every step below except which decision function ultimately
  // runs (BRO-4069: decideAlreadyLanded asserts the OPPOSITE sha timing and
  // never accepts a jobId — see its header in ack-landed-core.js).
  const decide = (extra) => {
    if (landedElsewhere) return core.decideLandedElsewhere({ ref, rows, landing, checkout, reason: args.reason, ackedBy, dataRepo: dataRepoName, ...extra });
    if (alreadyLanded) return core.decideAlreadyLanded({ ref, rows, landing, checkout, reason: args.reason, ackedBy, dataRepo: dataRepoName, ...extra });
    return core.decideAck({ ref, rows, jobId, landing, checkout, reason: args.reason, ackedBy, dataRepo: dataRepoName, ...extra });
  };

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
  const ledgerWide = alreadyLanded || landedElsewhere;
  const earliestLaunchRow = ledgerWide ? core.earliestLaunch(rows) : null;
  const earliestLaunchTs = ledgerWide ? (earliestLaunchRow ? earliestLaunchRow.ts : '(none readable)') : pre.launch.ts;
  console.error(`→ ledger: newest row for ${ref}${jobId ? ` (job ${jobId})` : ''} is ${pre.newest.event} (${pre.newest.ts}); ${ledgerWide ? 'earliest launch' : 'launch'} ${earliestLaunchTs}`);
  // The naming hint's window must mirror the decision that will judge the
  // suggested sha, or a suggestion just trades the naming refusal for a
  // timing one. decideAck: (launch, terminal + grace]. decideAlreadyLanded:
  // strictly before the EARLIEST launch — pre.launch is the latest one here,
  // because --already-landed never scopes rows by jobId.
  // decideLandedElsewhere: after the EARLIEST launch, no upper bound (its own
  // per-attempt window check then refuses a sha inside any attempt).
  const hintCtx = alreadyLanded
    ? { alreadyLanded: true, beforeTs: earliestLaunchRow ? earliestLaunchRow.ts : null }
    : landedElsewhere
      ? { landedElsewhere: true, launchTs: earliestLaunchRow ? earliestLaunchRow.ts : null, terminalTs: null, windows: core.attemptWindows(rows) }
      : { launchTs: pre.launch.ts, terminalTs: pre.newest.ts };

  // 2. Fresh origin/main + ancestry (shallow-safe).
  try {
    git(['fetch', '--quiet', 'origin', 'main'], { timeout: 120000 });
  } catch (e) {
    refuse(ref, [`git fetch origin main failed: ${String(e.stderr || e.message).trim()}`]);
  }
  // 2b. No --sha: derive it (BRO-4071) from the same candidate search the
  //     refusal hint uses, AFTER the fetch so it sees current origin/main.
  //     The derived sha then runs every precondition below exactly as a
  //     typed one would — derivation only removes the guess, never a check.
  if (!args.sha) {
    const cands = candidatesFor(ref, hintCtx);
    const where = whereFor(ref, hintCtx);
    if (cands === undefined) refuse(ref, [`--sha not given and it cannot be derived: ${ref}'s dispatch launch timestamps are not all readable, so no sha can satisfy --already-landed's timing check`]);
    if (cands === null) refuse(ref, [`--sha not given and it cannot be derived: searching origin/main for commits naming ${ref} failed (no origin/main, a shallow clone, or git refused the query) — pass --sha explicitly`]);
    if (!cands.length) refuse(ref, [`--sha not given and no commit on origin/main names ${ref} ${where} — nothing to derive${hintCtx.landedElsewhere ? ' (--landed-elsewhere only accepts a commit that names the card, changes a non-bookkeeping path, and falls outside every attempt window)' : '; pass --sha if the work landed under commits that never mention the card'}`]);
    // namingCandidates keeps git log order (newest commit first; --no-merges
    // over land.yml's linear rebases, capped at 5), so [0] is the most
    // recently landed naming commit. Every candidate passes the same naming + window guard,
    // so the choice only affects which sha the ledger row cites.
    args.sha = cands[0].sha;
    console.error(`→ --sha not given: derived ${args.sha} — the newest of ${cands.length}${cands.length >= 5 ? '+' : ''} commit(s) on origin/main naming ${ref} ${where}`);
    for (const c of cands.slice(1)) console.error(`     also naming it: ${c.sha}  ${c.authored}  ${String(c.subject).slice(0, 62)}`);
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
    // --landed-elsewhere refuses an empty / bookkeeping-only sha (first-parent
    // diff, so a merge commit reports what it brought in).
    landing.changedPaths = git(['diff-tree', '--no-commit-id', '--name-only', '-r', '--root', '-m', '--first-parent', sha], { maxBuffer: 64 * 1024 * 1024 })
      .split('\n').map((l) => l.trim()).filter(Boolean);
  } catch (e) {
    refuse(ref, [`could not read commit ${sha}: ${String(e.stderr || e.message).trim()}`]);
  }
  // A job-stranded row's sha is a Broadwayscore worktree HEAD: it cannot tie
  // to a data-repo commit, so --data-repo skips the tie (core then requires
  // window + naming instead) rather than probing the clone for a foreign sha.
  // Elsewhere checks ownership of ANY dispatch work; default ack requires its tip.
  const noTie = { tiedToStranded: false, tiedToStrandedByPatch: false };
  const tie = dataRepo ? noTie : computeStrandedTie(sha, pre.stranded && pre.stranded.sha, { cwd: REPO, landed: landing.verdict === 'LANDED', includeEarlierCommits: landedElsewhere });
  landing.tiedToStranded = tie.tiedToStranded;
  landing.tiedToStrandedByPatch = tie.tiedToStrandedByPatch;
  if (landedElsewhere && !dataRepo) {
    for (const st of rows.filter((r) => String(r.event) === 'job-stranded' && r.sha)) {
      if (landing.tiedToStranded || landing.tiedToStrandedByPatch) break;
      if (pre.stranded && st.sha === pre.stranded.sha) continue;
      const t = computeStrandedTie(sha, st.sha, { cwd: REPO, landed: landing.verdict === 'LANDED', includeEarlierCommits: true });
      landing.tiedToStranded = t.tiedToStranded;
      landing.tiedToStrandedByPatch = t.tiedToStrandedByPatch;
    }
  }
  console.error(`→ git: ${sha.slice(0, 11)} ${landing.verdict} on origin/main; authored ${landing.authorTs}, committed ${landing.commitTs}`);
  if (pre.launchVerifyCmd && pre.launchVerifyCmd !== args.verify.trim()) {
    console.error(`⚠️  --verify differs from the command recorded at dispatch (${pre.launchVerifyCmd}); both are kept on the ledger row`);
  }

  // 3. The checkout the verify command runs in must already prove origin/main.
  //    In --data-repo mode that is the clone verify reads, and "dirty" means the
  //    files this sha changed (CODE_PATHS are Broadwayscore's, meaningless there).
  //    Verify always runs MAIN's scripts, so MAIN's CODE_PATHS must be clean
  //    in both modes; in --data-repo mode the clone verify reads must also have
  //    no uncommitted tracked change anywhere (a stray edit could make an
  //    aggregate check pass on a state origin/main does not have).
  const porcelain = (out) => out.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => l.replace(/^\S+\s+/, ''));
  const mainDirty = porcelain(git(['status', '--porcelain', '--', ...CODE_PATHS], { cwd: MAIN }));
  const cloneDirty = dataRepo ? porcelain(git(['status', '--porcelain', '--untracked-files=no'])).map((p) => `${dataRepo.name}:${p}`) : [];
  const checkout = {
    containsSha: gitOk(['merge-base', '--is-ancestor', sha, 'HEAD']),
    dirtyCodePaths: [...mainDirty, ...cloneDirty],
  };
  // core-data verify reads MAIN's data/*.json, which must be the symlinks into
  // this clone — a copied or foreign dataset would certify the wrong state.
  if (dataRepo && dataRepo.name === 'core-data') {
    const realRoot = fs.realpathSync(REPO);
    let target = '';
    try { target = fs.realpathSync(path.join(MAIN, 'data', 'shows.json')); } catch { /* missing */ }
    if (path.dirname(target) !== realRoot) refuse(ref, [`--data-repo core-data: ${path.join(MAIN, 'data', 'shows.json')} does not resolve into ${REPO}, so verify would not read the clone being certified`]);
  }
  if (dataRepo && !checkout.containsSha) console.error(`→ the clone's HEAD does not contain ${sha.slice(0, 11)} — run: git -C ${REPO} pull --ff-only origin main`);

  // 4. Safe-form gate, then the real run. Everything above is decided BEFORE
  //    spending the run so an unsafe/untied ack never executes anything.
  const verify = { cmd: args.verify.trim(), safe: isSafeCheckCommand(args.verify.trim()), unsafeReason: null, exitCode: null };
  if (!verify.safe) verify.unsafeReason = (explainUnsafeCheckCommand(verify.cmd) || {}).reason || null;
  const dryRun = decide({ verify: { ...verify, exitCode: 0 } });
  if (!dryRun.ok) refuse(ref, dryRun.refusals, hintCtx);

  console.error(`→ running verify in ${MAIN}: ${verify.cmd}`);
  const verifyEnv = dataRepo && dataRepo.name === 'review-texts' ? { REVIEW_TEXTS_DIR: REPO } : undefined;
  if (verifyEnv && !/validate-data|audit-show-review-gap/.test(verify.cmd)) {
    console.error(`⚠️  verify reads review texts via REVIEW_TEXTS_DIR=${REPO}; a command that ignores that variable reads ${path.join(MAIN, 'data', 'review-texts')} instead, which may not be the clone`);
  }
  const decision = runVerifyAndDecide(decide, verify, { cwd: MAIN, env: verifyEnv });
  if (!decision.ok) refuse(ref, decision.refusals, hintCtx);

  // 5. Write the row. appendEntry self-stamps ts (never backdated).
  // The verify run can take minutes; a relaunch or another ack landing in that
  // window would make this row certify a stale picture (Codex ship-check P1).
  const raced = core.ledgerChangedSince(rows, core.rowsForRef(ledger.readEntries(), ref));
  if (raced) refuse(ref, [raced]);
  const written = ledger.appendEntry(decision.row);
  console.error(`→ ledger row appended: ${JSON.stringify(written)}`);

  if (!args.noLinear) {
    const comment = `${decision.row.event} by ${ackedBy} (${written.ts}): ${sha} is on ${dataRepo ? `${dataRepo.name}'s ` : ''}origin/main; \`${verify.cmd}\` exit 0. Reason: ${decision.row.reason}. Prior ledger row: ${decision.row.priorEvent}.`;
    const lb = spawnSync('node', [path.join(MAIN, 'scripts', 'linear-brain.js'), 'update', ref, '--comment', comment], { cwd: MAIN, encoding: 'utf8', timeout: 60000 });
    console.error(lb.status === 0
      ? `→ Linear comment posted on ${ref}`
      : `⚠️  Linear comment NOT posted on ${ref} (exit ${lb.status}): ${String(lb.stderr || lb.stdout || '').trim().split('\n').slice(-2).join(' ')} — the ledger row is the source of truth; re-post by hand if you want it on the card.`);
  }

  console.log(core.formatAckLine(ref, decision.row));
}

if (require.main === module) main();

module.exports = { parseArgs, resolveDataRepo, originMatchesSlug, DATA_REPOS, CODE_PATHS, VERIFY_TIMEOUT_MS, namingCandidates, candidatesFor, computeStrandedTie, runVerifyAndDecide };
