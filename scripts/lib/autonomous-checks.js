/**
 * autonomous-checks.js — the ONE check gauntlet the autonomous loop runs,
 * shared verbatim by the Mac-side executor (scripts/autonomous-run.js) and
 * the CI-side approve tap (scripts/autonomous-merge.js).
 *
 * Why this module exists (plan v2 Sprint 2, owner-approved 2026-07-25): the
 * two paths each carried their own copy of checksEnv() and their own call
 * shape around decideChecks(), so the approve tap's re-verification could
 * silently drift WEAKER than the overnight run that produced the evidence.
 * The owner taps Approve on the strength of the checks named in the email —
 * if the tap re-runs a different (smaller) set, that tap means less than it
 * says. One module, one env, one plan, one runner: parity by identity, not by
 * two implementations agreeing today.
 *
 * DEPENDENCY RULE: node built-ins only. Anything the runner needs from the
 * rest of the loop (isSafeCheckCommand, the file-exists probe) is INJECTED by
 * the caller, so this module can never pull the executor's world into the CI
 * merge process or vice versa.
 *
 * Tier-aware plan (S2-T4):
 *   every tier   colocated *.test.mjs for each changed file, then tsc if any
 *                .ts/.tsx changed
 *   tier 3 only  node --check on every changed scripts/**.js (syntax floor
 *                for files with no colocated test), and for any src/ change:
 *                `npx next lint` + a production `npx next build`. src/ is
 *                site code — a type error is not the failure mode that
 *                matters there, a page that no longer builds is.
 *
 * The build gets its OWN (much longer) timeout and its own env: checksEnv()
 * strips secrets, but a Next production build legitimately needs the
 * NEXT_PUBLIC_* feature flags, so those are explicitly whitelisted — never
 * inherited wholesale (autonomous-merge.js:238 P0 history: this CI-side path
 * once inherited the full secret env).
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// Per-check wall clock. The build is minutes, not seconds — a shared 5min cap
// would fail every src/ card on time rather than on merit.
const CHECK_TIMEOUT_MS = 5 * 60 * 1000;
const BUILD_TIMEOUT_MS = 20 * 60 * 1000;

// Checks execute implementer-AUTHORED code (a planted tests/x.test.mjs runs
// under node --test; a src/ change runs through the build). They must never
// see the session's secret-bearing environment: on the Mac side .env is
// loaded into process.env (Notion/Resend/HMAC/Vercel tokens), and in CI the
// workflow env carries NOTION_API_KEY / RESEND_API_KEY / a contents:write
// token. HOME points at a fresh empty temp dir so the git osxkeychain
// credential helper is unreachable (a malicious check can't push with the
// owner's credentials) and git prompting is disabled so it fails fast.
const KEEP_ENV = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', 'NODE_ENV'];

// The feature-flag set a production build needs to compile every route the
// live site serves. Mirrors package.json's build:ugc script (the auth-aware
// build test.yml/Vercel use); an explicit constant, not `NEXT_PUBLIC_*`
// inheritance from the ambient env, so a stray local flag can never change
// what the loop verifies.
const BUILD_ENV = Object.freeze({
  NEXT_PUBLIC_FEATURES: 'criticPages,castPages,westEnd,offBroadway,tonyPeople,tonyPredictions,userAccounts',
  NEXT_PUBLIC_SANITY_DATASET: 'production',
  SKIP_HEAVY_PREBUILD: 'true',
});

function checksEnv({ env = process.env, build = false } = {}) {
  const out = {};
  for (const k of KEEP_ENV) if (env[k] !== undefined) out[k] = env[k];
  out.HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-checks-home-'));
  out.GIT_TERMINAL_PROMPT = '0';
  if (build) Object.assign(out, BUILD_ENV);
  return out;
}

// ── The plan ────────────────────────────────────────────────────────────────

// The ONE tier reader. Works on either carrier of the tier — the triage
// queue item (executor side) or the Notion evidence comment (approve-tap
// side) — because the executor copies item.tier straight into the evidence.
// One function, both callers: the tap cannot resolve a different tier than
// the run did. Anything that isn't literally 3 reads as Tier 1 (fail closed).
function tierOf(carrier) {
  return carrier && carrier.tier === 3 ? 3 : 1;
}

const UI_PATH_RE = /^src\/.*\.(tsx|jsx|css|scss)$/;

// A UI diff is one a human should LOOK at, not just one that compiles — the
// approve tap for these carries screenshot evidence or no approve link at all
// (S2-T6). tailwind.config.* is site-wide styling even though it isn't under
// src/ (it is manifest-adjacent but not on the tier-3 exclusion list).
function isUiDiff(files) {
  return (files || []).some(f => UI_PATH_RE.test(String(f)) || /^tailwind\.config\.(js|ts|cjs|mjs)$/.test(String(f)));
}

function hasSrcChange(files) {
  return (files || []).some(f => String(f).startsWith('src/'));
}

/**
 * changedFiles → ordered check commands (argv arrays, ALWAYS exec'd with
 * shell=false). existsFn is injected for testability.
 *
 * @param {string[]} changedFiles
 * @param {(relPath:string)=>boolean} existsFn
 * @param {{tier?:number, buildCheck?:boolean}} [opts]
 * @returns {{name:string, argv:string[], timeoutMs?:number, build?:boolean}[]}
 */
function decideChecks(changedFiles, existsFn, opts = {}) {
  const { tier = 1, buildCheck = true } = opts;
  const files = (changedFiles || []).map(String);
  const checks = [];
  const seen = new Set();
  const add = (name, argv, extra = {}) => {
    if (seen.has(name)) return;
    seen.add(name);
    checks.push({ name, argv, ...extra });
  };

  const testFiles = new Set();
  for (const f of files) {
    if (/\.test\.mjs$/.test(f)) { testFiles.add(f); continue; }
    // Colocated test convention: scripts/lib/x.js → scripts/lib/x.test.mjs
    const colocated = f.replace(/\.(js|mjs|ts|tsx)$/, '.test.mjs');
    if (colocated !== f && existsFn(colocated)) testFiles.add(colocated);
  }
  if (testFiles.size) add('colocated-tests', ['node', '--test', ...[...testFiles].sort()]);

  // Syntax floor for tier-3 script edits: most scripts/ files have no
  // colocated test, and "it parses" is the cheapest true statement we can
  // make about one. Never a substitute for a test — an addition to it.
  if (tier === 3) {
    for (const f of files.filter(f => /^scripts\/.*\.(js|mjs|cjs)$/.test(f) && !/\.test\.m?js$/.test(f)).sort()) {
      add(`node --check ${f}`, ['node', '--check', f]);
    }
  }

  if (files.some(f => /\.(ts|tsx)$/.test(f))) add('tsc', ['npx', 'tsc', '--noEmit']);

  if (tier === 3 && hasSrcChange(files)) {
    add('next lint', ['npx', 'next', 'lint']);
    // The build is the check that actually describes the live site. Skippable
    // by config (tier3BuildCheck:false) for an owner who wants the loop
    // cheaper, never by an implementer or a card.
    if (buildCheck) add('next build', ['npx', 'next', 'build'], { timeoutMs: BUILD_TIMEOUT_MS, build: true });
  }

  return checks;
}

// The card's own checkableDone command, revalidated at EXECUTION time (the
// queue file is not trusted either) and split into argv for shell-free exec.
function cardCheckArgv(checkableDone, isSafeCheckCommand) {
  const cmd = String(checkableDone || '').trim();
  if (!cmd) return null;
  if (!isSafeCheckCommand(cmd)) return null;
  return cmd.split(/\s+/);
}

// ── Workdir preparation ─────────────────────────────────────────────────────

// A fresh `git worktree add` has NO node_modules and none of the gitignored
// core-data symlinks (data/shows.json et al are symlinks into the private
// repo). Without them `npx tsc --noEmit` fails TS2307 on every JSON import
// and `npx next build` cannot run at all — so a tier-3 src/ card would fail
// its checks on environment, not on merit, every single night.
//
// Fills GAPS ONLY: a path that already exists in the workdir (i.e. is tracked
// in git) is never touched, so this can't shadow the implementer's own work.
// Everything it links is gitignored, so nothing it creates can reach a diff.
function prepareCheckWorkdir(workdir, repoRoot) {
  const linked = [];
  const link = (from, to) => {
    if (fs.existsSync(to) || !fs.existsSync(from)) return;
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.symlinkSync(fs.realpathSync(from), to);
      linked.push(path.relative(workdir, to));
    } catch { /* best effort — a missing link surfaces as a failed check */ }
  };

  link(path.join(repoRoot, 'node_modules'), path.join(workdir, 'node_modules'));
  for (const dir of ['data', path.join('public', 'data'), path.join('data', 'cast')]) {
    const src = path.join(repoRoot, dir);
    let names;
    try { names = fs.readdirSync(src); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      link(path.join(src, name), path.join(workdir, dir, name));
    }
  }
  return linked;
}

// ── The runner ──────────────────────────────────────────────────────────────

/**
 * Run the full gauntlet for a diff. The ONE implementation both the executor
 * and the approve tap call — see this file's header.
 *
 * @param {object} o
 * @param {string} o.cwd - worktree (executor) or repo checkout (merge)
 * @param {string[]} o.changedFiles
 * @param {string|null} [o.checkableDone] - the card's own LLM-authored check
 * @param {(cmd:string)=>boolean} o.isSafeCheckCommand - injected validator
 * @param {number} [o.tier]
 * @param {boolean} [o.buildCheck]
 * @param {(relPath:string)=>boolean} [o.existsFn]
 * @param {string|null} [o.prepareFrom] - repo root to fill node_modules/data from
 * @returns {{name:string, pass:boolean, detail?:string}[]}
 */
function runSafeChecks(o) {
  const {
    cwd, changedFiles, checkableDone = null, isSafeCheckCommand,
    tier = 1, buildCheck = true, prepareFrom = null,
  } = o;
  const existsFn = o.existsFn || (f => fs.existsSync(path.join(cwd, f)));
  const results = [];

  const checks = decideChecks(changedFiles, existsFn, { tier, buildCheck });
  if (checkableDone) {
    const cardArgv = cardCheckArgv(checkableDone, isSafeCheckCommand);
    if (cardArgv) checks.push({ name: `card-check (${checkableDone})`, argv: cardArgv });
    // An unsafe/invalid checkableDone FAILS CLOSED — it must never silently
    // vanish from the gauntlet (the merge path used to drop it).
    else results.push({ name: 'card-check', pass: false, detail: `checkableDone failed safe-form validation: ${String(checkableDone).slice(0, 120)}` });
  }
  if (!checks.length) return results;

  if (prepareFrom) {
    const linked = prepareCheckWorkdir(cwd, prepareFrom);
    if (linked.length) console.error(`[checks] linked ${linked.length} gitignored path(s) into the check workdir (node_modules/core data)`);
  }

  const plainEnv = checksEnv();
  const buildEnv = checks.some(c => c.build) ? checksEnv({ build: true }) : null;
  for (const c of checks) {
    try {
      execFileSync(c.argv[0], c.argv.slice(1), {
        cwd, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8',
        timeout: c.timeoutMs || CHECK_TIMEOUT_MS,
        env: c.build ? buildEnv : plainEnv,
      });
      results.push({ name: c.name, pass: true });
    } catch (err) {
      results.push({ name: c.name, pass: false, detail: String(err.stderr || err.stdout || err.message).slice(0, 400) });
    }
  }
  return results;
}

module.exports = {
  CHECK_TIMEOUT_MS,
  BUILD_TIMEOUT_MS,
  KEEP_ENV,
  BUILD_ENV,
  checksEnv,
  tierOf,
  decideChecks,
  cardCheckArgv,
  isUiDiff,
  hasSrcChange,
  prepareCheckWorkdir,
  runSafeChecks,
};
