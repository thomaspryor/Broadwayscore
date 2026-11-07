'use strict';
// BRO-6263: the Codex trust ladder. Pure decisions only; scripts/codex-trust-ladder.js reads the
// sources and writes the state. Codex's access widens as its measured record holds and relocks one
// rung on a quality regression.
//
// Rungs (id, key, how it moves):
//   1 larger-cards      auto: codexCardFit's too-broad cap widens from -6 to -9
//   2 cloud-data-route  auto: cloud lane may pick data-route cards (granted at launch by BRO-6260)
//   3 review-texts-ro   auto: private review-texts linked read-only, no keys (granted at launch)
//   4 ios-app-repo      REPORT ONLY: needs a macOS verify path (owner file prerequisites.iosVerifyPath)
//   5 workflow-files    REPORT ONLY: stays locked until the owner gives a fresh yes (owner file ownerYes)
// NEVER, whatever the record says: keys, emails, spend, land refs.
//
// Two committed files: data/audit/codex-trust-ladder.json is written by the evaluator; the
// -owner.json file is human-only (kill switch, ownerYes, manual regressions, prerequisites), so a
// bot rebase that keeps its own copy of a state file cannot erase a human edit. Both are on
// Codex's blocked-path list in scripts/codex/daily-runner.js.
//
// Shadow first (CLAUDE.md 19): state.mode 'shadow' makes access() return the pre-ladder baseline
// and the evaluator report only. Promotion stays off until state.promoteEnabled is set by a
// committed edit (relock is always on).

const fs = require('fs');
const path = require('path');

const HOUR = 3600_000;
const DAY = 24 * HOUR;

// N=7 days, rejection under 40%, 30+ attempts: chosen from BRO-4745 summaries 2026-10-06..10-26
// (7-day pooled rejection 45%, best sustained 3-day stretch 36%, worst detection lag of a lane
// fault 36h), see the BRO-6263 outcome comment. Rung 1 does not qualify at the current record.
const POLICY = Object.freeze({ windowDays: 7, maxRejectRate: 0.40, minAttempts: 30 });
const BASELINE_MIN_SCORE = -6; // CODEX_MIN_SCORE in codex-runner.js
const WIDE_MIN_SCORE = -9;

const RUNGS = Object.freeze([
  { id: 1, key: 'larger-cards', auto: true },
  { id: 2, key: 'cloud-data-route', auto: true },
  { id: 3, key: 'review-texts-ro', auto: true },
  { id: 4, key: 'ios-app-repo', auto: false },
  { id: 5, key: 'workflow-files', auto: false },
]);
const AUTO = RUNGS.filter((r) => r.auto).map((r) => r.key);
const RELOCK_ORDER = ['review-texts-ro', 'cloud-data-route', 'larger-cards']; // when the cause is unknown
const NEVER = Object.freeze(['keys', 'emails', 'spend', 'land-refs']);

const STATE_FILE = 'data/audit/codex-trust-ladder.json';
const OWNER_FILE = 'data/audit/codex-trust-ladder-owner.json';

function seedState(nowIso) {
  return {
    version: 1,
    mode: 'shadow',
    promoteEnabled: false,
    rungs: {
      'larger-cards': { unlocked: false, since: null },
      'cloud-data-route': { unlocked: true, since: nowIso, grant: 'baseline (BRO-6260)' },
      'review-texts-ro': { unlocked: true, since: nowIso, grant: 'baseline (BRO-6260)' },
    },
    seededAt: nowIso,
    clock: { cleanSince: nowIso, lastEvalAt: null },
    handledRegressions: [],
    events: [],
  };
}

function seedOwner() {
  return { killSwitch: false, ownerYes: null, regressions: [], prerequisites: { iosVerifyPath: null } };
}

// -> { state, owner, ok } ; a missing file is "not set up" (baseline), a file that will not parse is
// "corrupt" (access() fails closed, narrowest, so a relock is never undone by a bad merge).
function validState(st) {
  return !!st && typeof st === 'object' && st.rungs && typeof st.rungs === 'object' && AUTO_KEYS.every((k) => st.rungs[k] && typeof st.rungs[k] === 'object')
    && st.clock && typeof st.clock === 'object' && Number.isFinite(Date.parse(st.clock.cleanSince))
    && Array.isArray(st.handledRegressions) && Array.isArray(st.events);
}
const AUTO_KEYS = ['larger-cards', 'cloud-data-route', 'review-texts-ro'];

function loadFiles(root = process.cwd(), readFile = (p) => fs.readFileSync(p, 'utf8')) {
  const one = (rel) => {
    try { return { value: JSON.parse(readFile(path.join(root, rel))) }; } catch (e) {
      return e && e.code === 'ENOENT' ? { missing: true } : { corrupt: true };
    }
  };
  const s = one(STATE_FILE); const o = one(OWNER_FILE);
  // Valid JSON of the wrong shape is corrupt too: evaluate() would throw on it.
  if (s.value !== undefined && s.value !== null && !validState(s.value)) { delete s.value; s.corrupt = true; }
  if (o.value !== undefined && o.value !== null && (typeof o.value !== 'object' || Array.isArray(o.value))) { delete o.value; o.corrupt = true; }
  return {
    state: s.value || null, owner: o.value || null,
    stateMissing: !!s.missing, corrupt: !!(s.corrupt || o.corrupt),
  };
}

const killed = (owner, env) => !!(owner && owner.killSwitch) || /^(1|true|yes)$/i.test(String((env || {}).CODEX_TRUST_LADDER_DISABLED || '').trim());

/**
 * What the runner may do right now. Callers read this through the existing default-parameter
 * pattern (codexCardFit minScore), so none can forget to ask.
 * -> { source, minScore, cloudDataRouteLocked, reviewTextsLocked }
 */
function access({ state, owner, corrupt = false, env = process.env } = {}) {
  const baseline = { source: 'baseline', minScore: BASELINE_MIN_SCORE, cloudDataRouteLocked: false, reviewTextsLocked: false };
  if (killed(owner, env)) return { ...baseline, source: 'killed' };
  if (corrupt) return { source: 'corrupt-locked', minScore: BASELINE_MIN_SCORE, cloudDataRouteLocked: true, reviewTextsLocked: true };
  if (!state || state.mode !== 'live') return baseline;
  const r = state.rungs || {};
  const on = (k) => !!(r[k] && r[k].unlocked);
  return {
    source: 'ladder',
    minScore: on('larger-cards') ? WIDE_MIN_SCORE : BASELINE_MIN_SCORE,
    cloudDataRouteLocked: !on('cloud-data-route'),
    reviewTextsLocked: !on('review-texts-ro'),
  };
}

/**
 * access() as the runner sees it now: the two ladder files read from one origin/main commit (so a
 * Codex worktree's own copy never counts, an owner flip on main is seen without a pull, and both
 * files come from the same commit while another slot fetches), else from the working tree when
 * there is no origin/main ref at all (a fresh or detached checkout). Fails closed: a git error
 * other than "no such ref" or "no such file on main" reads as corrupt (every rung locked), never
 * as "not set up". Cached ACCESS_TTL_MS per root: the picker is a fresh process per pick, and a
 * ~2h runner still sees a relock within minutes.
 * -> access() + { mode, ref: 'origin/main@<sha7>'|'worktree'|'env' }
 */
const ACCESS_TTL_MS = 5 * 60_000;
const accessCache = new Map();
function ladderAccess({ root = path.resolve(__dirname, '..', '..'), env = process.env, nowMs = Date.now(), git = null } = {}) {
  // The env kill switch needs no file read (and is never cached either way).
  if (killed(null, env)) return { ...access({ env }), mode: 'killed', ref: 'env' };
  const hit = accessCache.get(root);
  if (hit && nowMs - hit.at < ACCESS_TTL_MS) return hit.value;
  const run = git || ((args) => require('child_process').execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15_000 }));
  let value;
  try {
    let sha = null;
    // --verify --quiet exits 1 with no output for a missing ref; anything else is a git failure (throws below).
    try { sha = run(['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']).trim(); } catch (e) { if (e && e.status !== 1) throw e; }
    let readFile;
    if (sha) {
      readFile = (p) => {
        const rel = path.relative(root, p).split(path.sep).join('/');
        // ls-tree succeeds with empty output for a path not on main: that alone is "not set up".
        if (!run(['ls-tree', '--name-only', sha, '--', rel]).trim()) { const e = new Error(`${rel} not on origin/main`); e.code = 'ENOENT'; throw e; }
        return run(['show', `${sha}:${rel}`]); // on main but unreadable: throws, which loadFiles reads as corrupt
      };
    }
    const files = loadFiles(root, readFile);
    value = { ...access({ ...files, env }), mode: files.corrupt ? 'corrupt' : files.state ? String(files.state.mode || 'shadow') : 'not set up', ref: sha ? `origin/main@${sha.slice(0, 7)}` : 'worktree' };
  } catch {
    value = { ...access({ corrupt: true, env }), mode: 'unreadable', ref: 'git failed' };
  }
  accessCache.set(root, { at: nowMs, value });
  return value;
}
ladderAccess.clearCache = () => accessCache.clear();

/** The BRO-4745 summary line: what access the ladder gave this run. */
function accessLine(a) {
  const open = (locked) => (locked ? 'locked' : 'open');
  return `- Trust ladder: ${a.mode || '?'} (${a.source}${a.ref ? `, read from ${a.ref}` : ''}); min score ${a.minScore}, cloud data route ${open(a.cloudDataRouteLocked)}, review-texts ${open(a.reviewTextsLocked)}`;
}

// ---------- the record ----------

/** Rejection stats over the last windowDays from the BRO-4745 runner summaries (facts from runnerSummaryFacts). */
function rejectionStats(summaries, nowMs, windowDays, summaryFacts) {
  let landed = 0; let rejected = 0;
  for (const c of Array.isArray(summaries) ? summaries : []) {
    const t = Date.parse(c && c.createdAt);
    if (!Number.isFinite(t) || nowMs - t > windowDays * DAY || t > nowMs) continue;
    const f = summaryFacts(c.body);
    landed += f.landed; rejected += f.rejected || 0;
  }
  const attempts = landed + rejected;
  return { landed, rejected, attempts, rate: attempts ? rejected / attempts : null };
}

/**
 * Quality regressions from one `git log` dump. Record separator \x1e, fields \x1f:
 *   %H %an %ct %s %b   (use GIT_LOG_FORMAT). Returns [{id, at, why, sha}] ; null input = unknown.
 * - revert: a commit whose body says "This reverts commit <sha>" or whose subject is Revert "<codex subject>"
 * - forward fix: a non-Codex commit naming a Codex-landed BRO-N within 7 days of it with regress/revert/rollback/broke/undo
 * A revert of a revert is not a regression.
 */
const GIT_LOG_FORMAT = '%H%x1f%an%x1f%ct%x1f%s%x1f%b%x1e';
const CODEX_AUTHOR = 'Codex runner';
function parseCommits(raw) {
  return String(raw || '').split('\x1e').map((r) => r.replace(/^\n+/, '')).filter(Boolean).map((r) => {
    const [sha, author, ct, subject, body] = r.split('\x1f');
    return { sha, author, at: Number(ct) * 1000, subject: subject || '', body: body || '' };
  }).filter((c) => c.sha && Number.isFinite(c.at));
}
function gitRegressions(raw) {
  if (raw === null || raw === undefined) return null;
  const commits = parseCommits(raw);
  const codex = commits.filter((c) => c.author === CODEX_AUTHOR);
  const bySha = (s) => codex.find((c) => c.sha.startsWith(s));
  const out = []; const seen = new Set();
  const add = (id, c, why) => { if (!seen.has(id)) { seen.add(id); out.push({ id, at: c.at, why, sha: c.sha }); } };
  for (const c of commits) {
    if (c.author === CODEX_AUTHOR) continue;
    const m = c.body.match(/This reverts commit ([0-9a-f]{7,40})/);
    const target = m && bySha(m[1].slice(0, 7));
    if (target && !/^Revert "Revert /.test(c.subject)) { add(`revert:${target.sha.slice(0, 7)}`, c, `reverts Codex landing ${target.sha.slice(0, 7)}`); continue; }
    const rs = c.subject.match(/^Revert "(.*)"$/);
    if (rs && !/^Revert "/.test(rs[1])) {
      const t = codex.find((x) => x.subject === rs[1]);
      if (t) { add(`revert:${t.sha.slice(0, 7)}`, c, `reverts Codex landing ${t.sha.slice(0, 7)}`); continue; }
    }
    if (/^Revert "/.test(c.subject)) continue; // a revert of something that is not a Codex landing, or of a revert
    if (/\b(regress\w*|revert\w*|rollback|broke|undo)\b/i.test(c.subject)) {
      const cited = (c.subject.match(/\bBRO-\d+\b/g) || []);
      const t = codex.find((x) => cited.some((id) => new RegExp(`\\b${id}\\b`).test(x.subject)) && c.at >= x.at && c.at - x.at <= 7 * DAY);
      if (t) add(`fwd:${c.sha.slice(0, 7)}`, c, `forward fix after Codex landing ${t.sha.slice(0, 7)}: ${c.subject.slice(0, 80)}`);
    }
  }
  return out;
}

// ---------- the decision ----------

const toIso = (ms) => new Date(ms).toISOString();

/**
 * @param {object} p
 *  state, owner      the two committed files (see seedState / seedOwner)
 *  record.stats      rejectionStats() or null (unknown)
 *  record.regressions  [{id, at, why, capability?}] from gitRegressions + any other source, or null (unknown)
 *  record.breaches   confirmed lane-health breaches (confirmedBreaches().confirmed) or null (unknown)
 *  nowMs
 * @returns {{state, events, report}} state is a new object; nothing is written here.
 */
function evaluate({ state, owner, record, nowMs }) {
  const next = JSON.parse(JSON.stringify(state));
  const rec = record || {};
  const events = []; const holds = [];
  const ev = (type, rung, why) => { const e = { at: toIso(nowMs), type, rung: rung || null, why }; events.push(e); next.events.push(e); };

  if (owner && owner.killSwitch) {
    return { state: next, events, report: { status: 'killed', holds: ['kill switch on'], promoted: null, relocked: [], rungs: summarize(next, owner, null, nowMs) } };
  }

  // 1. regressions: relock one rung each, once per id. Unknown source = hold, never "clean".
  const ownerRegs = ((owner && owner.regressions) || []).filter((r) => r && typeof r.id === 'string' && r.id).map((r) => ({ ...r, at: Date.parse(r.at) || nowMs }));
  const bad = ((owner && owner.regressions) || []).length - ownerRegs.length;
  if (bad) holds.push(`${bad} owner regression(s) ignored: each needs a string id`);
  // Commits from before the ladder was seeded predate its record; they must not relock on the first live run.
  const seededAt = Date.parse(next.seededAt || next.clock.cleanSince);
  const regs = [...((rec.regressions) || []), ...ownerRegs].filter((r) => r.at >= seededAt);
  const fresh = regs.filter((r) => !next.handledRegressions.includes(r.id)).sort((a, b) => a.at - b.at);
  const relocked = [];
  for (const r of fresh) {
    const cap = r.capability && AUTO.includes(r.capability) ? r.capability : null;
    // A known cause relocks only its own rung (already locked = nothing more to take); an unknown one takes the highest unlocked.
    const target = cap ? (next.rungs[cap].unlocked ? cap : null) : (RELOCK_ORDER.find((k) => next.rungs[k] && next.rungs[k].unlocked) || null);
    next.handledRegressions.push(r.id);
    if (target) {
      next.rungs[target] = { unlocked: false, since: null, relockedAt: toIso(nowMs), relockedBy: r.id };
      relocked.push({ rung: target, regression: r });
      ev('relock', target, `${r.id}: ${r.why}`);
    } else ev('regression-no-rung', null, `${r.id}: ${r.why} (nothing unlocked to relock)`);
    next.clock.cleanSince = toIso(nowMs);
  }

  // 2. clock: a confirmed lane-health breach restarts it; an unreadable source pauses it.
  const unknown = [];
  if (!rec.stats) unknown.push('runner summaries');
  if (rec.regressions === null || rec.regressions === undefined) unknown.push('git history');
  if (rec.breaches === null || rec.breaches === undefined) unknown.push('lane health');
  const last = next.clock.lastEvalAt ? Date.parse(next.clock.lastEvalAt) : null;
  if (unknown.length && last && nowMs > last) next.clock.cleanSince = toIso(Math.min(nowMs, Date.parse(next.clock.cleanSince) + (nowMs - last)));
  if (rec.breaches && rec.breaches.length && !relocked.length) { next.clock.cleanSince = toIso(nowMs); holds.push(`confirmed lane-health breach: ${rec.breaches.map((b) => `${b.lane}:${b.cls}`).join(', ')}`); }
  next.clock.lastEvalAt = toIso(nowMs);
  if (unknown.length) holds.push(`unreadable source: ${unknown.join(', ')}`);

  // 3. promotion: at most one auto rung, only on a full clean record.
  const cleanDays = (nowMs - Date.parse(next.clock.cleanSince)) / DAY;
  const stats = rec.stats || { attempts: 0, rate: null };
  const missing = [];
  if (cleanDays < POLICY.windowDays) missing.push(`${POLICY.windowDays - Math.floor(cleanDays)} more clean day(s) (clean ${cleanDays.toFixed(1)}d of ${POLICY.windowDays})`);
  if (stats.attempts < POLICY.minAttempts) missing.push(`${POLICY.minAttempts - stats.attempts} more attempts (have ${stats.attempts}, need ${POLICY.minAttempts})`);
  if (stats.rate !== null && stats.rate >= POLICY.maxRejectRate) missing.push(`rejection ${(stats.rate * 100).toFixed(0)}% must be under ${POLICY.maxRejectRate * 100}%`);
  const qualifies = !missing.length && !unknown.length && !(rec.breaches && rec.breaches.length) && !relocked.length;
  const nextRung = RELOCK_ORDER.slice().reverse().find((k) => !(next.rungs[k] && next.rungs[k].unlocked)) || null; // larger-cards first
  let promoted = null;
  if (qualifies && nextRung) {
    if (next.promoteEnabled) {
      next.rungs[nextRung] = { unlocked: true, since: toIso(nowMs), grant: 'earned' };
      next.clock.cleanSince = toIso(nowMs); // the next rung is earned on its own record
      promoted = nextRung; ev('promote', nextRung, `${stats.attempts} attempts, ${(stats.rate * 100).toFixed(0)}% rejected, ${cleanDays.toFixed(1)} clean days`);
    } else holds.push(`qualifies for ${nextRung} but promoteEnabled is false (shadow)`);
  }

  return { state: next, events, report: { status: relocked.length ? 'relocked' : promoted ? 'promoted' : unknown.length ? 'hold' : qualifies ? 'qualifies' : 'idle', holds, missing, promoted, relocked, stats, cleanDays, nextRung, rungs: summarize(next, owner, !missing.length && !unknown.length, nowMs) } };
}

// Rungs 4 and 5 are report-only: the ladder says when the record would qualify, never unlocks them.
function summarize(state, owner, recordQualifies, nowMs) {
  const r = state.rungs;
  const own = owner || seedOwner();
  return {
    'larger-cards': r['larger-cards'].unlocked ? 'unlocked' : 'locked',
    'cloud-data-route': r['cloud-data-route'].unlocked ? 'unlocked' : 'locked',
    'review-texts-ro': r['review-texts-ro'].unlocked ? 'unlocked' : 'locked',
    'ios-app-repo': own.prerequisites && own.prerequisites.iosVerifyPath
      ? (recordQualifies ? 'record qualifies; picker wiring for the app repo is not built' : 'prerequisite met, record not yet qualifying')
      : 'locked: waiting on a macOS verify path for the app repo (prerequisite, not a fault)',
    'workflow-files': own.ownerYes && own.ownerYes.by && own.ownerYes.date
      ? 'owner yes on file; the runner still hard-skips workflow edits'
      : (recordQualifies ? 'record qualifies; locked until the owner gives a fresh yes' : 'locked: owner gate'),
  };
}

/**
 * Files the runner must never land: Codex cannot edit the rules that grade it, nor the inputs they
 * read (BRO-6303): the run-summary format and parser, the summary reader and the lane-health breaches.
 */
const PROTECTED_FILES = new Set([
  'scripts/lib/codex-trust-ladder.js', 'scripts/codex-trust-ladder.js',
  'scripts/lib/codex-runner-grading.js', 'scripts/codex-lane-alarm.js', 'scripts/lib/codex-lane-health.js',
]);
function isProtectedPath(name) {
  const n = String(name || '');
  return PROTECTED_FILES.has(n) || n.startsWith('data/audit/codex-trust-ladder');
}
// A card that names a protected file: Codex's change to it would be refused at commit, so it never starts.
const PROTECTED_CARD_RE = /\b(?:codex-trust-ladder|codex-runner-grading|codex-lane-alarm|codex-lane-health)(?:-owner)?\.(?:js|json)\b/i;

module.exports = {
  isProtectedPath, PROTECTED_CARD_RE, PROTECTED_FILES, ladderAccess, accessLine, ACCESS_TTL_MS,
  POLICY, RUNGS, NEVER, STATE_FILE, OWNER_FILE, BASELINE_MIN_SCORE, WIDE_MIN_SCORE, GIT_LOG_FORMAT,
  seedState, seedOwner, loadFiles, access, rejectionStats, gitRegressions, parseCommits, evaluate,
};
