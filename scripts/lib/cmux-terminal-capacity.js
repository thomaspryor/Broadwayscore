'use strict';

/**
 * cmux-terminal-capacity — can cmux attach a terminal to ONE MORE workspace
 * right now?
 *
 * ── The defect this exists for (task #1904, root-caused live 2026-08-26) ───
 * The cmux workspace lane was losing 31-58% of every dispatch while the
 * headless lane lost 0/158 over the same window. Every previous fix in this
 * lineage (#849, #900, #1199, #1812) treated it as a DEFERRED RENDER — cmux
 * backgrounded, surface not drawn, so the `--command` handed to
 * `new-workspace` never executed — and each shipped a way to poke the app
 * awake. None of them moved the rate, because the app's focus state is not
 * the mechanism.
 *
 * The mechanism is a CEILING on live terminal runtimes. Past it, cmux still
 * creates the workspace, still creates a surface OBJECT for it, and still
 * accepts the `--command` — but never attaches a terminal runtime, so the
 * command cannot ever run in that workspace. `cmux debug-terminals` shows
 * the two shapes side by side:
 *
 *     healthy:  runtime=1  ghostty=0x0000000bee99c000  runtimeCreated=873.9s
 *     doomed:   runtime=0  ghostty=nil                 runtimeCreated=nil
 *
 * Measured on this machine at 14:20Z: 43 surfaces, runtime=1 on exactly 29,
 * runtime=0 on 14, and every workspace created during the session landed in
 * the runtime=0 bucket — including one that was visible=1 inWindow=1
 * hidden=0 firstResponder=1, i.e. on screen and focused. Not a render
 * deferral.
 *
 * Every documented rescue was tested against a doomed workspace and did
 * nothing: `set-app-focus active` (before AND after create), `open -a`,
 * `simulate-app-active`, `refresh-surfaces`, `select-workspace`,
 * `new-surface`, `send`, and creating the workspace in a brand-new cmux
 * WINDOW. The cap is app-wide and there is no in-cmux way out of it — only a
 * runtime FREEING (a tab closing) lets a pending one attach. That is why
 * production deaths arrive in back-to-back runs, why they cluster overnight
 * when tabs accumulate and nobody prunes, and why a "dead" command fires
 * much later: task #1898's wrapper touched its start-marker at 12:31Z, 53
 * minutes after the launcher had declared it dead at 11:38Z.
 *
 * ── Why the ceiling is LEARNED and not a constant ─────────────────────────
 * 29 is what THIS cmux build (0.64.6) does on THIS machine. A constant would
 * be wrong on the next upgrade in whichever direction hurts more: too high
 * and the gate never fires, too low and it refuses healthy dispatches
 * forever. So the number is observed — recorded when a launch's workspace is
 * confirmed to have got no runtime, and raised again the moment a launch
 * succeeds at or above it (see learnCeiling). Both directions are one pure
 * function, unit-tested, with no clock and no I/O.
 *
 * Pure decisions and the parser are exported separately from the cmux/fs
 * calls (CLAUDE.md rule 15) — the tests require() these directly rather than
 * re-deriving the counting.
 *
 * FAIL-OPEN EVERYWHERE. `debug-terminals` is an undocumented debug command;
 * if it disappears, changes shape, times out, or cmux isn't installed, this
 * module reports "capacity unknown" and callers launch exactly as they do
 * today. A capacity gate that starts refusing dispatches because cmux
 * renamed a field would be a far worse bug than the one it closes.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const CMUX = '/Applications/cmux.app/Contents/Resources/bin/cmux';

// os.tmpdir(), NOT data/audit/ (pre-implementation review, 2026-08-26).
// data/audit/ is git-TRACKED apart from the one explicit .gitignore line for
// dispatch-ledger.jsonl, so a ceiling file there would be committed and
// shipped to CI and to every other machine — and this number is a property of
// ONE cmux install on ONE host. tmpdir is also exactly where cmux-launch.js
// already keeps its per-machine launch state (LAST_LAUNCH_MARKER, the seed and
// cmd wrappers). Losing the file to a tmp reap costs one re-learning launch.
const CEILING_PATH = path.join(os.tmpdir(), 'bsc-cmux-terminal-ceiling.json');

// A learned ceiling goes stale. If cmux ships a build with a higher cap, the
// gate would otherwise refuse every dispatch above the OLD number forever —
// and it could never be disproved, because learnCeiling only raises the
// ceiling on a success at or above it, and the gate is what stops that
// success from ever being attempted. Expiry is the escape hatch that does not
// depend on anyone noticing: after this long the ceiling reads as unknown,
// the next launch runs ungated, and whatever it proves is re-learned. A day
// is long enough that a real ceiling still suppresses a whole bad night, and
// short enough that a stale one costs at most one dead launch per day.
const CEILING_TTL_MS = 24 * 60 * 60 * 1000;

// Below this many live runtimes, a launch failure is NEVER attributed to the
// ceiling. A cmux carrying 7 terminals is not at a resource cap, so a
// runtime-missing observation down there is some other fault (a crashed app,
// a bad cwd) and recording it would latch the gate shut on a number that
// refuses every future dispatch. Deliberately far below the 29 measured
// here: this is a floor against absurdity, not a tuned threshold.
const MIN_PLAUSIBLE_CEILING = 8;

// `debug-terminals` prints one block per surface, each starting with an
// index in square brackets at column 0, e.g.
//   [4] surface:62 "Terminal" mapped=1 tree=1 window=window:1 workspace=workspace:60 pane=pane:60 ctx=split
//       runtime=0 focused=1 ... ghostty=nil ...
//       ...
//       created=473.8s runtimeCreated=nil lastWorkspace=workspace:60 ...
const BLOCK_SPLIT_RE = /\n(?=\[\d+\])/;

/**
 * Parse `cmux debug-terminals` into one record per surface.
 *
 * Deliberately tolerant: a block missing a field yields null for that field
 * rather than throwing, and an unrecognised block is dropped. The caller's
 * fail-open contract depends on this never raising on unfamiliar output.
 *
 * @param {string} text raw stdout of `cmux debug-terminals`
 * @returns {Array<{surfaceRef:string, workspaceRef:string|null, mapped:boolean|null,
 *                  runtime:boolean|null, createdSec:number|null, runtimeCreatedSec:number|null}>}
 */
function parseDebugTerminals(text) {
  const out = [];
  for (const block of String(text || '').split(BLOCK_SPLIT_RE)) {
    const head = /^\[\d+\]\s+(surface:\d+)/.exec(block);
    if (!head) continue;
    const ws = /\bworkspace=(workspace:\d+)/.exec(block);
    const rt = /\bruntime=([01])\b/.exec(block);
    const mapped = /\bmapped=([01])\b/.exec(block);
    const created = /\bcreated=([\d.]+)s/.exec(block);
    const runtimeCreated = /\bruntimeCreated=([\d.]+)s/.exec(block);
    out.push({
      surfaceRef: head[1],
      workspaceRef: ws ? ws[1] : null,
      mapped: mapped ? mapped[1] === '1' : null,
      runtime: rt ? rt[1] === '1' : null,
      createdSec: created ? Number(created[1]) : null,
      runtimeCreatedSec: runtimeCreated ? Number(runtimeCreated[1]) : null,
    });
  }
  return out;
}

/**
 * Live terminal runtimes = SURFACES cmux has actually attached a terminal to.
 *
 * Surfaces, not workspaces, and the two must never be cross-referenced
 * (pre-implementation review): one workspace can hold several surfaces via
 * splits (`ctx=split`), and `cmux list-workspaces` is scoped to the CURRENT
 * window — it returned 3 rows against 41 real workspaces on this machine the
 * moment a second window existed. The cap being measured here is on terminal
 * runtimes, which is a surface-level resource, so surfaces is also the
 * correct unit on its own terms.
 */
function countLiveRuntimes(surfaces) {
  return (Array.isArray(surfaces) ? surfaces : []).filter(s => s && s.runtime === true).length;
}

/**
 * Does the workspace `ref` currently have a live terminal runtime?
 * null = unknown (ref absent from the dump, or the dump had no runtime field)
 * — never false, so a caller can't read "I didn't see it" as "it's dead".
 */
function workspaceRuntimeState(surfaces, ref) {
  const mine = (Array.isArray(surfaces) ? surfaces : []).filter(s => s && s.workspaceRef === ref);
  if (!mine.length) return null;
  if (mine.some(s => s.runtime === true)) return true;
  return mine.some(s => s.runtime === false) ? false : null;
}

/**
 * PURE. Should a caller open another cmux workspace right now?
 *
 * @param {object} o
 * @param {number|null} o.liveRuntimes surfaces with a terminal attached, or null if unknown
 * @param {number|null} o.ceiling learned cap, or null if never observed
 * @returns {{hasCapacity:boolean, known:boolean, liveRuntimes:number|null, ceiling:number|null, reason:string}}
 */
function decideCapacity({ liveRuntimes = null, ceiling = null } = {}) {
  const live = Number.isInteger(liveRuntimes) ? liveRuntimes : null;
  const cap = Number.isInteger(ceiling) && ceiling >= MIN_PLAUSIBLE_CEILING ? ceiling : null;

  if (live === null) {
    return {
      hasCapacity: true, known: false, liveRuntimes: null, ceiling: cap,
      reason: 'cmux terminal capacity unknown (debug-terminals unavailable or unparseable) — launching anyway',
    };
  }
  if (cap === null) {
    return {
      hasCapacity: true, known: false, liveRuntimes: live, ceiling: null,
      reason: `${live} live cmux terminal(s); no ceiling observed yet — launching anyway`,
    };
  }
  if (live >= cap) {
    return {
      hasCapacity: false, known: true, liveRuntimes: live, ceiling: cap,
      reason: `cmux is at its terminal-runtime ceiling: ${live} live terminal(s), cap observed at ${cap}. `
        + 'A workspace opened now gets a surface but NEVER a terminal, so its command can never run '
        + '(task #1904). Close finished tabs (bsc-prune) or restart cmux to free a runtime.',
    };
  }
  return {
    hasCapacity: true, known: true, liveRuntimes: live, ceiling: cap,
    reason: `${live}/${cap} cmux terminal runtimes in use`,
  };
}

/**
 * PURE. Fold one launch observation into the learned ceiling.
 *
 * `liveRuntimesBefore` is the count measured BEFORE the workspace was
 * created, which is the number that actually decides the outcome — counting
 * after would include this launch's own runtime on the success path and not
 * on the failure path, i.e. compare two different things.
 *
 * @param {object} o
 * @param {number|null} o.ceiling      current learned ceiling (null = none yet)
 * @param {number} o.liveRuntimesBefore
 * @param {'runtime-missing'|'runtime-created'} o.outcome
 * @returns {{ceiling:number|null, changed:boolean, reason:string}}
 */
function learnCeiling({ ceiling = null, liveRuntimesBefore, outcome } = {}) {
  const cur = Number.isInteger(ceiling) ? ceiling : null;
  const before = Number.isInteger(liveRuntimesBefore) ? liveRuntimesBefore : null;
  if (before === null) return { ceiling: cur, changed: false, reason: 'no live-runtime count observed — nothing to learn' };

  if (outcome === 'runtime-missing') {
    // Creation at `before` demonstrably fails, so the cap is at most `before`.
    if (before < MIN_PLAUSIBLE_CEILING) {
      return {
        ceiling: cur, changed: false,
        reason: `runtime-missing at only ${before} live terminal(s) — below the ${MIN_PLAUSIBLE_CEILING} plausibility floor, so this is some other fault, not the ceiling. Not recorded.`,
      };
    }
    if (cur !== null && cur <= before) return { ceiling: cur, changed: false, reason: `ceiling already ${cur} (<= ${before})` };
    return { ceiling: before, changed: true, reason: `cmux failed to attach a terminal at ${before} live runtime(s) — ceiling recorded as ${before}` };
  }

  if (outcome === 'runtime-created') {
    // Creation at `before` demonstrably works, so the cap is above `before`.
    // This is the ONLY path that raises a stale-low ceiling, which is why
    // the capacity gate must stay bypassable (--force) — otherwise a ceiling
    // learned too low could never be disproved.
    if (cur === null || cur > before) return { ceiling: cur, changed: false, reason: 'success below the known ceiling — nothing to learn' };
    return { ceiling: before + 1, changed: true, reason: `cmux attached a terminal at ${before} live runtime(s), at or above the recorded ceiling ${cur} — raised to ${before + 1}` };
  }

  return { ceiling: cur, changed: false, reason: `unknown outcome ${JSON.stringify(outcome)}` };
}

// ── I/O (thin; everything above is pure) ───────────────────────────────────

// ONE retry, found by running this against the real machine (2026-08-26):
// four consecutive probes returned nothing in the seconds right after two
// launch attempts, then the identical call succeeded in 268ms a minute later
// — the cmux socket is briefly unavailable while it is busy creating
// workspaces. That is precisely the moment this probe is called, and a
// transient miss reads as "capacity unknown", which silently disables the
// gate for exactly the dispatch it exists to stop. A single ~300ms retry
// costs nothing on the happy path (~270ms, no retry) and removes the common
// case. It stays fail-open after that: a genuinely broken/renamed command
// must never block dispatch.
function runCmuxDebugTerminals({ attempts = 2, backoffMs = 300 } = {}) {
  for (let i = 0; i < attempts; i++) {
    try {
      if (!fs.existsSync(CMUX)) return null;
      const r = spawnSync(CMUX, ['debug-terminals'], { encoding: 'utf8', timeout: 5000, maxBuffer: 32 * 1024 * 1024 });
      if (!r.error && r.status === 0 && r.stdout) return r.stdout;
    } catch { /* fall through to the retry / the null below */ }
    // Synchronous: every caller of this module is in a sync dispatch path.
    if (i < attempts - 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, backoffMs);
  }
  return null;
}

/**
 * The learned ceiling, or null if there isn't one / it has expired.
 * nowMs is a parameter rather than a Date.now() call so the expiry is
 * testable without a clock (rule 15's reasoning applied to the I/O half).
 */
function readCeiling(ceilingPath = CEILING_PATH, { nowMs = Date.now(), ttlMs = CEILING_TTL_MS } = {}) {
  try {
    const raw = JSON.parse(fs.readFileSync(ceilingPath, 'utf8'));
    if (!Number.isInteger(raw && raw.ceiling)) return null;
    const observedAt = Date.parse(raw.observedAt);
    // An unparseable/absent observedAt is treated as expired, never as
    // eternally fresh: the failure direction has to be "stop refusing", not
    // "refuse forever off a timestamp nobody can read".
    if (!Number.isFinite(observedAt) || nowMs - observedAt > ttlMs) return null;
    return raw.ceiling;
  } catch { return null; }
}

function writeCeiling(ceiling, { ceilingPath = CEILING_PATH, note = null, nowIso = new Date().toISOString() } = {}) {
  try {
    fs.mkdirSync(path.dirname(ceilingPath), { recursive: true });
    fs.writeFileSync(ceilingPath, JSON.stringify({ ceiling, observedAt: nowIso, note }, null, 2) + '\n');
    return true;
  } catch { return false; }
}

/**
 * One cmux round trip (~100ms) answering "can I open another workspace?".
 * Returns decideCapacity()'s shape plus the parsed surfaces, so a caller
 * that is about to create a workspace can reuse the same snapshot for its
 * before-count instead of probing twice.
 */
function probeTerminalCapacity({ debugTerminals = runCmuxDebugTerminals, ceilingPath = CEILING_PATH, nowMs = Date.now() } = {}) {
  const text = debugTerminals();
  const surfaces = text === null ? null : parseDebugTerminals(text);
  // An EMPTY parse from non-empty output means the format changed — that is
  // "unknown", not "zero live terminals". Reporting 0 there would make the
  // gate think capacity is wide open, which is the harmless direction, but
  // it would also poison learnCeiling with a bogus before-count.
  const live = surfaces && surfaces.length ? countLiveRuntimes(surfaces) : null;
  return { ...decideCapacity({ liveRuntimes: live, ceiling: readCeiling(ceilingPath, { nowMs }) }), surfaces };
}

/**
 * Record what a launch proved about the ceiling. Best-effort: a failure to
 * persist must never break a dispatch.
 */
function recordLaunchOutcome({ liveRuntimesBefore, outcome, ceilingPath = CEILING_PATH, nowMs = Date.now() }) {
  const next = learnCeiling({ ceiling: readCeiling(ceilingPath, { nowMs }), liveRuntimesBefore, outcome });
  if (next.changed) writeCeiling(next.ceiling, { ceilingPath, note: next.reason, nowIso: new Date(nowMs).toISOString() });
  return next;
}

module.exports = {
  parseDebugTerminals,
  countLiveRuntimes,
  workspaceRuntimeState,
  decideCapacity,
  learnCeiling,
  probeTerminalCapacity,
  recordLaunchOutcome,
  readCeiling,
  writeCeiling,
  runCmuxDebugTerminals,
  MIN_PLAUSIBLE_CEILING,
  CEILING_TTL_MS,
  CEILING_PATH,
};
