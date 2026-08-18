/**
 * claude-cli — the ONE shared "spawn a headless Claude session" primitive.
 *
 * Extracted 2026-07-26 (Autopilot v5 R1, task #459) so the repo stops growing
 * spawn implementations: autonomous-run.js has runImplementer(), notion-action-
 * poll.js has runClaude(), and every new dispatcher was about to add a third.
 * New callers (bsc-runner.js) use this from day one; migrating the two existing
 * battle-tested callers is a later, parity-gated change — do NOT rewire them
 * casually (plan-review design finding P0-1).
 *
 * Design constraints carried over from the precedents:
 * - Prompt via stdin, spawn targets `claude` directly (never a shell pipe):
 *   a piped grandchild survives the shell's timeout kill with repo write
 *   access (notion-action-poll.js:508 comment).
 * - `--output-format json` always: the envelope is the only reliable source
 *   of session_id + result text (all precedents).
 * - Wall-clock timeout enforced HERE with SIGKILL, never trusted to Claude.
 * - Stripped env by default: headless implementers are untrusted and never
 *   see Notion/Resend/Vercel secrets (autonomous-run.js implementerEnv(),
 *   ship-check P0 2026-07-13).
 * - Expensive interactive tiers can never leak into unattended runs
 *   (FORBIDDEN_MODEL_RE, autonomous-budget.js).
 * - ASYNC spawn (not execFileSync): the caller must be able to record the
 *   PID and write state while the child runs — synchronous spawn is what
 *   made heartbeat-style liveness impossible (plan-review consensus P0).
 * - "Exit 0 + parseable JSON" is NOT success: an auth-expired CLI returns a
 *   thin valid envelope. Success additionally requires non-empty result text
 *   (pre-mortem secondary scenario).
 */

'use strict';

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readEnvKeys } = require('./load-env.js');

// Same guard as autonomous-budget.js: checked on the OUTPUT of model choice so
// no config edit can route an unattended run onto the interactive default tier.
const FORBIDDEN_MODEL_RE = /fable|mythos/i;

// Failure-stage vocabulary is shared with scripts/lib/autonomous-run-core.js
// (CONTENT_STAGES/INFRA_STAGES/classifyFailure) — do not invent new spellings.
const STAGES = Object.freeze({
  TIMEOUT: 'timeout',
  ERROR: 'implementer-error',
  PARSE: 'parse-error',
  EMPTY: 'empty-result',
  FORBIDDEN_MODEL: 'forbidden-model',
});

// The credential keys this primitive forwards to the child. Named constant so
// the .env top-up and the forward allow-list below can never drift apart —
// filling a key we don't forward, or forwarding one we never fill, both
// reproduce task #713 silently.
const AUTH_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'];

/**
 * Resolve the auth credentials a spawned `claude` needs, WITHOUT mutating
 * process.env.
 *
 * Task #713: under launchd, process.env carries only the plist's
 * EnvironmentVariables block — no .env, no login shell. Both auth keys were
 * therefore undefined, nothing got forwarded, and `claude` ran logged out. The
 * child then exits 1 with a VALID envelope whose result text is
 * "Not logged in · Please run /login" (reproduced 2026-08-01 under the drain
 * plist's exact PATH), so every launchd-parented headless dispatch died in
 * ~40ms at zero cost. Measured 2026-07-31: the first-ever backlog-drain tick
 * dispatched card #5 and the job died exactly this way (5-ms98zoic, 48ms).
 *
 * readEnvKeys returns ONLY these two keys and never writes to process.env —
 * loadEnv() would publish all 75 .env keys globally and leak Resend/Notion/
 * scraper secrets into any later non-stripped spawn in the same process, which
 * is precisely the containment strippedEnv exists to provide (Codex P0).
 *
 * @returns {Record<string,string>} the auth keys .env supplies that the
 *   environment did not already carry — often empty (interactive shell, CI).
 */
function resolveAuthEnv() {
  return readEnvKeys(AUTH_KEYS);
}

// Absolute-path candidates for the `claude` binary, in preference order —
// mirrors BASH5_CANDIDATES/modernBash() in infra-gate-registration-check.js
// (same launchd-minimal-PATH class of bug, there for bash 5 vs macOS's
// PATH-resolved bash 3.2). Deliberately not resolved via PATH.
function claudeBinCandidates(env) {
  const home = env.HOME || os.homedir();
  return [
    path.join(home, '.local/bin/claude'),
    '/Applications/cmux.app/Contents/Resources/bin/claude',
    '/opt/homebrew/bin/claude',   // Apple Silicon Homebrew — absent from the
                                  // original list, so a brew-only machine fell
                                  // through to bare 'claude' and kept the ENOENT
                                  // exposure this resolver exists to close.
    '/usr/local/bin/claude',
  ];
}

function isExecutablePath(p) {
  try {
    // statSync BEFORE accessSync: a DIRECTORY passes X_OK whenever it has
    // search permission (verified 2026-08-18 — `fs.accessSync(dir, X_OK)`
    // returns cleanly, then spawning it fails EACCES). Without the isFile
    // guard a directory named `claude` at an earlier candidate path would
    // shadow the real binary later in the list, and the resulting EACCES
    // would point at the wrong cause — the exact silent-misresolution this
    // resolver exists to prevent (ship-check finding, gpt-5.4-mini).
    if (!fs.statSync(p).isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an absolute path to the `claude` binary instead of relying on
 * spawning the bare name and letting Node resolve it through PATH.
 *
 * Task #1768: launchd-parented plists carry only the plist's
 * EnvironmentVariables PATH (no ~/.local/bin), so bare-name spawn died
 * `ENOENT` — 9 failures across 8 days, reproduced with a control test:
 * a bare-name spawn under a minimal PATH fails, the same call with the
 * absolute path succeeds. Same launchd-minimal-env class as AUTH_KEYS
 * above (#713), left unaddressed for PATH until now.
 *
 * env.CLAUDE_BIN wins if set and executable — a bad/stale value is ignored
 * (fail open), not thrown on. Otherwise probes the fixed candidate list.
 * Falls back to the bare 'claude' string, unchanged from today's behavior,
 * so an environment where PATH already resolves it is never regressed.
 *
 * @param {NodeJS.ProcessEnv} [env] injectable for tests; defaults to the
 *   real process env for actual spawns.
 * @param {string[]} [candidates] injectable for tests; defaults to
 *   claudeBinCandidates(env) for actual spawns.
 * @returns {string} an absolute path, or 'claude' if nothing resolved.
 */
function resolveClaudeBin(env = process.env, candidates = claudeBinCandidates(env)) {
  if (env.CLAUDE_BIN) {
    // CLAUDE_BIN is an OPERATOR PIN — the documented way to force a specific
    // build for a rollback. Silently discarding a bad pin and running some
    // other candidate is the worst outcome: the operator believes they rolled
    // back, the run says Done, and the wrong binary produced it. Both
    // ship-check reviewers (Codex + gpt-5.4-mini) flagged this independently.
    // Still fail OPEN so a typo can never take the whole dispatcher down —
    // but never fail SILENT.
    if (!path.isAbsolute(env.CLAUDE_BIN)) {
      console.error(`[claude-cli] IGNORING CLAUDE_BIN="${env.CLAUDE_BIN}": not an absolute path (it would resolve against the cwd, which differs per dispatch). Falling back to candidate probing.`);
    } else if (!isExecutablePath(env.CLAUDE_BIN)) {
      console.error(`[claude-cli] IGNORING CLAUDE_BIN="${env.CLAUDE_BIN}": not an executable file. Falling back to candidate probing — if you set this to pin a version for a rollback, that pin is NOT in effect.`);
    } else {
      return env.CLAUDE_BIN;
    }
  }
  for (const c of candidates) {
    if (isExecutablePath(c)) return c;
  }
  return 'claude';
}

/**
 * Prepend the resolved binary's directory to a PATH string, so a nested
 * `claude` the child itself invokes resolves under the same minimal-PATH
 * parent that made the outer spawn need an absolute path (task #1768).
 *
 * Shared so callers building their own env (notion-action-poll.js's runEnv)
 * get the identical treatment instead of re-deriving it — CLAUDE.md rule 15.
 *
 * @param {string} [pathValue] the PATH being forwarded to the child.
 * @returns {string} PATH with the resolved binary's dir first (deduped).
 */
function pathWithClaudeBinDir(pathValue = process.env.PATH) {
  const bin = resolveClaudeBin();
  if (!path.isAbsolute(bin)) return pathValue || '';
  const dir = path.dirname(bin);
  const parts = (pathValue || '').split(path.delimiter).filter(Boolean);
  if (parts.includes(dir)) return parts.join(path.delimiter);
  return [dir, ...parts].join(path.delimiter);
}

function strippedEnv(extra = {}) {
  const keep = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', ...AUTH_KEYS];
  const env = {};
  for (const k of keep) { if (process.env[k] !== undefined) env[k] = process.env[k]; }
  env.HOME = env.HOME || os.homedir();
  // Same #1768 fix as the spawn call sites: if resolution found an absolute
  // path, put its directory on the forwarded PATH too, so a nested `claude`
  // invocation the child itself makes (not just this module's own spawns)
  // also resolves under the same minimal-PATH parent.
  env.PATH = pathWithClaudeBinDir(env.PATH);
  // Precedence, weakest first: process.env < .env top-up < caller's `extra`.
  // The top-up sits ABOVE `env` on purpose: readEnvKeys only returns keys the
  // environment left absent OR EMPTY, and an inherited `FOO=` empty string
  // copied into `env` above would otherwise shadow the real .env value — the
  // exact silent-no-credential shape #713 is about.
  // `extra` still wins outright: preflightAuth proves the oauth path by
  // spawning with ANTHROPIC_API_KEY:'' and the real spawn has to reproduce that
  // exact shape, so a .env key can never re-populate it.
  return { ...env, ...resolveAuthEnv(), ...extra };
}

// Auth preflight (task #713 — generalized from opening-night-monitor-launch.js's
// authPing/resolvePassAuth/preflightAuth, task #457). Root cause: a launchd- or
// cron-parented `claude` can't reach the macOS Keychain, so a pass that expects
// stored OAuth login dies "Not logged in" — but the CLI exits 0 with a VALID
// envelope (subtype:"success", result:"Not logged in · Please run /login"), so
// callers that only check exit code + JSON-parseability treat it as a real,
// successful run. Probe the actual auth shape BEFORE spawning the real session
// so a doomed pass never silently "succeeds" with a login prompt as its output.
function authPing(extraEnv) {
  const r = spawnSync(resolveClaudeBin(), ['-p', 'Reply with exactly: pong', '--model', 'sonnet', '--output-format', 'json'],
    // resolveAuthEnv() sits above process.env for the same reason as in
    // strippedEnv: under launchd the keys are absent, and the probe has to
    // exercise the SAME credentials the real spawn will get or it proves
    // nothing. extraEnv still wins so probe 1 can force the no-API-key shape.
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, ...resolveAuthEnv(), ...extraEnv } });
  // A spawn error (e.g. ENOENT) sets r.error and leaves status/stdout/stderr
  // null — falling through to `exit ${r.status}` would print the
  // uninformative "exit null" for exactly the failure this module exists to
  // make legible (task #1768).
  if (r.error) return { ok: false, detail: String(r.error.message || r.error).slice(0, 300) };
  if (r.status !== 0) return { ok: false, detail: (r.stderr || r.stdout || `exit ${r.status}`).slice(0, 300) };
  // Positive validation, never a grep for the error string (it may get reworded):
  // require the envelope to actually contain the pong.
  try {
    const body = JSON.parse(r.stdout);
    if (body.is_error === false && /pong/i.test(String(body.result || ''))) return { ok: true };
    return { ok: false, detail: `ping returned no pong: ${String(body.result || r.stdout).slice(0, 200)}` };
  } catch {
    return { ok: false, detail: `unparseable ping output: ${String(r.stdout || r.stderr).slice(0, 200)}` };
  }
}

// Pure decision, extracted for tests (CLAUDE.md rule 15): which auth mode
// should the pass use given the two probe outcomes and key availability?
function resolvePassAuth({ storedLoginOk, apiKeyPresent, apiKeyPingOk }) {
  if (storedLoginOk) return { mode: 'oauth' };
  if (apiKeyPresent && apiKeyPingOk) return { mode: 'api-key' };
  return { mode: 'fail' };
}

/**
 * Probe which auth mode a headless spawn can actually use, before spending a
 * real session attempt on a pass that's doomed to a silent "Not logged in".
 * @param {object} [opts]
 * @param {boolean} [opts.allowApiKeyFallback=true] set false to require OAuth only
 * @param {(msg:string)=>void} [opts.log] optional logger for the fallback notice
 * @returns {{ok:boolean, mode:'oauth'|'api-key'|'fail', detail?:string}}
 */
function preflightAuth({ allowApiKeyFallback = true, log = () => {} } = {}) {
  // Probe 1: the real pass shape — API key cleared, stored login only.
  const stored = authPing({ ANTHROPIC_API_KEY: '' });
  // envForMode is the env override the caller MUST spread into the real spawn
  // so it reproduces the shape that was actually proven. Task #713 made this
  // load-bearing: before the fix a launchd pass had no API key at all, so
  // "oauth proven" and "oauth used" coincided by accident. Now that .env can
  // supply ANTHROPIC_API_KEY, strippedEnv() would restore it and a pass proven
  // on the subscription would silently bill pay-per-token instead (ship-check
  // finding, codex 2026-08-01). Empty string, not delete — that is the exact
  // shape authPing probed with.
  if (stored.ok) return { ok: true, mode: 'oauth', envForMode: { ANTHROPIC_API_KEY: '' } };
  // Must consult the SAME resolution the spawn uses, not process.env alone:
  // under launchd the key lives only in .env, and reading process.env here
  // reported "no ANTHROPIC_API_KEY in env" and failed the preflight closed
  // even once the spawn path could have used it (task #713).
  const apiKeyPresent = allowApiKeyFallback
    && Boolean(process.env.ANTHROPIC_API_KEY || resolveAuthEnv().ANTHROPIC_API_KEY);
  // Probe 2: only if a key exists — can the key path carry the pass?
  const keyed = apiKeyPresent ? authPing({}) : { ok: false, detail: allowApiKeyFallback ? 'no ANTHROPIC_API_KEY in env' : 'API fallback disabled' };
  const decision = resolvePassAuth({ storedLoginOk: false, apiKeyPresent, apiKeyPingOk: keyed.ok });
  if (decision.mode === 'api-key') {
    log(`preflight: stored login unreachable (${stored.detail.slice(0, 120)}) — falling back to ANTHROPIC_API_KEY (pay-per-token). Run \`claude setup-token\` + add CLAUDE_CODE_OAUTH_TOKEN to restore subscription billing.`);
    return { ok: true, mode: 'api-key', envForMode: {}, storedDetail: stored.detail };
  }
  return { ok: false, mode: 'fail', envForMode: {}, detail: `stored-login: ${stored.detail} | api-key: ${keyed.detail}` };
}

function parseEnvelope(raw) {
  try {
    const parsed = JSON.parse(raw);
    return {
      resultText: typeof parsed.result === 'string' ? parsed.result : '',
      sessionId: parsed.session_id || null,
      usage: parsed.usage || null,
      costUSD: typeof parsed.total_cost_usd === 'number' ? parsed.total_cost_usd : null,
      parsed: true,
    };
  } catch {
    return { resultText: '', sessionId: null, usage: null, costUSD: null, parsed: false };
  }
}

// ── stream-json parsing (task #1184 S1) ─────────────────────────────────────
// `--output-format json` only prints its envelope on a CLEAN exit, so a
// timed-out session left an empty log, no session_id, and no cost — the
// 30 minutes of work was unresumable and invisible to the spend breaker
// (observed live: every digest-autofix timeout on 8/8-8/9). stream-json
// (requires --verbose with --print — CLI errors without it, verified against
// the real CLI 2026-08-10) emits JSONL events as the session runs: session_id
// arrives on the FIRST event (~350ms in), assistant events carry per-message
// usage, and the final `result` event matches the old envelope's fields.

// One parsed stream event, reduced to the fields this module consumes.
// Returns null for blank/corrupt lines (a SIGKILL can sever the last line
// mid-write — same skip-corrupt invariant as dispatch-ledger.readEntries).
function parseStreamLine(line) {
  const t = String(line || '').trim();
  if (!t) return null;
  let j;
  try { j = JSON.parse(t); } catch { return null; }
  const out = { type: j.type || null, sessionId: j.session_id || null, usage: null, result: null };
  if (j.type === 'assistant' && j.message && j.message.usage) out.usage = j.message.usage;
  if (j.type === 'result') {
    out.result = {
      resultText: typeof j.result === 'string' ? j.result : '',
      sessionId: j.session_id || null,
      usage: j.usage || null,
      costUSD: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
    };
  } else if (j.type === undefined && typeof j.result === 'string' && j.session_id) {
    // Legacy `--output-format json` single-envelope shape: no `type` field,
    // the whole session in one JSON object. Still emitted by fake-claude test
    // binaries (and any CLI version speaking the old contract) — the
    // stream-json switch broke opening-night-monitor's runMonitorPass tests
    // with stage parse-error on main (P0, task #1231, 2026-08-10). Accept it
    // as a result event; empty resultText still routes to the EMPTY stage.
    out.result = {
      resultText: j.result,
      sessionId: j.session_id || null,
      usage: j.usage || null,
      costUSD: typeof j.total_cost_usd === 'number' ? j.total_cost_usd : null,
    };
    out.sessionId = j.session_id || null;
  }
  return out;
}

// Running usage totals across assistant events — the only cost signal that
// survives a kill (the authoritative result-event totals never arrive).
function addUsage(total, usage) {
  const t = total || { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  if (!usage) return t;
  for (const k of ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens']) {
    if (typeof usage[k] === 'number') t[k] += usage[k];
  }
  return t;
}

// Rough per-Mtok USD rates for killed-session cost ESTIMATES only — the
// result event's total_cost_usd is always preferred when the session ends
// cleanly. Deliberately coarse: the point is that the spend circuit breaker
// sees ~$2 instead of $0 for a killed session (Codex plan-review finding),
// not billing-grade accuracy. Unknown models estimate as sonnet.
const APPROX_MODEL_RATES_PER_MTOK = Object.freeze({
  opus: { in: 15, out: 75 },
  sonnet: { in: 3, out: 15 },
  haiku: { in: 1, out: 5 },
});

function estimateCostUSD(usage, model) {
  if (!usage) return null;
  const key = Object.keys(APPROX_MODEL_RATES_PER_MTOK).find(k => String(model || '').includes(k)) || 'sonnet';
  const r = APPROX_MODEL_RATES_PER_MTOK[key];
  const inTok = (usage.input_tokens || 0) + 1.25 * (usage.cache_creation_input_tokens || 0) + 0.1 * (usage.cache_read_input_tokens || 0);
  const usd = (inTok * r.in + (usage.output_tokens || 0) * r.out) / 1e6;
  return Math.round(usd * 10000) / 10000;
}

/**
 * Run one headless Claude session.
 *
 * Task #1184 S1: runs `--output-format stream-json` (not `json`) so that
 * session_id, usage, and live progress survive a timeout kill. Three
 * consequences callers rely on:
 *  - `onSessionId` fires within ~1s of spawn — the caller can persist the
 *    session id BEFORE anything can kill the run, making resume possible.
 *  - Timeout is SIGTERM + `graceMs` grace, then SIGKILL. Either way the
 *    result carries sessionId + aggregated usage + an ESTIMATED costUSD
 *    (`costEstimated: true`) so killed sessions stop reading as $0.
 *  - `logFile` is appended INCREMENTALLY (one line per stream event), so a
 *    killed session's log shows what it was doing, not an empty file.
 *
 * @param {object} opts
 * @param {string} opts.prompt            prompt text (sent via stdin)
 * @param {string} opts.cwd               working directory (resume is cwd-scoped)
 * @param {string} [opts.model]           model slug; refused if it matches FORBIDDEN_MODEL_RE
 * @param {string} [opts.resumeSessionId] continue a prior session by id
 * @param {number} [opts.timeoutMs]       wall clock, default 30 min, SIGTERM+grace then SIGKILL
 * @param {number} [opts.graceMs]         SIGTERM→SIGKILL grace, default 60s
 * @param {number} [opts.maxBufferBytes]  retained stream tail cap, default 16 MB
 * @param {string} [opts.logFile]         stream events appended here live (created if absent)
 * @param {string} [opts.settingsPath]    optional --settings deny-list file
 * @param {object} [opts.env]             extra env merged over the stripped base
 * @param {(pid:number)=>void} [opts.onSpawn]      called with the child PID immediately
 * @param {(sessionId:string)=>void} [opts.onSessionId] called once, on the first event carrying one
 * @returns {Promise<{ok:boolean, stage:string|null, resultText:string, sessionId:string|null,
 *                    exitCode:number|null, pid:number|null, durationMs:number,
 *                    usage:object|null, costUSD:number|null, costEstimated:boolean,
 *                    errorDetail:string|null}>}
 * Never rejects — failures come back as {ok:false, stage}.
 */
function runClaudeCli(opts) {
  const {
    prompt, cwd, model, resumeSessionId,
    timeoutMs = 30 * 60 * 1000,
    graceMs = 60 * 1000,
    maxBufferBytes = 16 * 1024 * 1024,
    logFile = null,
    settingsPath = null,
    env = {},
    onSpawn = null,
    onSessionId = null,
  } = opts;

  const started = Date.now();
  const done = (r) => ({
    ok: false, stage: null, resultText: '', sessionId: resumeSessionId || null,
    exitCode: null, pid: null, usage: null, costUSD: null, costEstimated: false, errorDetail: null,
    ...r, durationMs: Date.now() - started,
  });

  if (!prompt || !cwd) {
    return Promise.resolve(done({ stage: STAGES.ERROR, errorDetail: 'prompt and cwd are required' }));
  }
  if (model && FORBIDDEN_MODEL_RE.test(model)) {
    return Promise.resolve(done({ stage: STAGES.FORBIDDEN_MODEL, errorDetail: `refused model "${model}" for unattended run` }));
  }

  // stream-json REQUIRES --verbose under --print (CLI hard-errors without it).
  const args = ['--print', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (model) args.push('--model', model);
  if (settingsPath) args.push('--settings', settingsPath);
  if (resumeSessionId) args.push('--resume', resumeSessionId);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(resolveClaudeBin(), args, { cwd, env: strippedEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve(done({ stage: STAGES.ERROR, errorDetail: `spawn failed: ${e.message}` }));
    }

    const pid = child.pid || null;
    if (onSpawn && pid) { try { onSpawn(pid); } catch { /* caller's problem, not the job's */ } }

    // Incremental log: open once, append per event. A 2h session's stream can
    // run tens of MB — appending live (instead of buffering the whole stream
    // for one final write) is also what keeps memory bounded below.
    let logFd = null;
    if (logFile) {
      try {
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        logFd = fs.openSync(logFile, 'a');
        fs.writeSync(logFd, `\n===== ${new Date().toISOString()} spawn pid=${pid}${resumeSessionId ? ` resume=${resumeSessionId}` : ''} =====\n`);
      } catch { logFd = null; /* logging must never fail the job */ }
    }
    const logLine = (s) => { if (logFd !== null) { try { fs.writeSync(logFd, s + '\n'); } catch { /* ignore */ } } };

    child.stdout.setEncoding('utf8'); // multibyte chars must never split across chunks
    child.stderr.setEncoding('utf8');
    let lineBuf = '';
    let tail = '';           // last chunk of raw stream, for errorDetail only
    let stderr = '';
    let sessionId = resumeSessionId || null;
    let sessionNotified = false;
    let usageTotal = null;
    let resultEvent = null;
    let timedOut = false;
    let settled = false;
    let graceTimer = null;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGTERM first: lets in-flight child processes (a git commit, a test
      // run) wind down. The session transcript is already on disk either way
      // — resume works after ANY kill — so the grace is short.
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      graceTimer = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }, graceMs);
    }, timeoutMs);

    const handleLine = (line) => {
      logLine(line);
      const ev = parseStreamLine(line);
      if (!ev) return;
      if (ev.sessionId) {
        // A resume gets a FRESH session id from the CLI — always track the
        // stream's own id, and notify exactly once, on the first event.
        sessionId = ev.sessionId;
        if (!sessionNotified && onSessionId) { try { onSessionId(sessionId); } catch { /* caller's problem */ } }
        sessionNotified = true;
      }
      if (ev.usage) usageTotal = addUsage(usageTotal, ev.usage);
      if (ev.result) resultEvent = ev.result;
    };

    child.stdout.on('data', (d) => {
      tail = (tail + d).slice(-8192);
      lineBuf += d;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) !== -1) {
        handleLine(lineBuf.slice(0, idx));
        lineBuf = lineBuf.slice(idx + 1);
      }
      // A malformed stream with no newlines must not grow unboundedly.
      if (lineBuf.length > maxBufferBytes) lineBuf = lineBuf.slice(-1024);
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(graceTimer);
      if (logFd !== null) { try { fs.closeSync(logFd); } catch { /* ignore */ } }
      resolve(done({ stage: STAGES.ERROR, pid, errorDetail: `child error: ${e.message}` }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(graceTimer);
      if (lineBuf.trim()) handleLine(lineBuf); // last line may lack a newline
      if (logFd !== null) {
        try {
          fs.writeSync(logFd, `===== ${new Date().toISOString()} exit=${code}${timedOut ? ' TIMEOUT' : ''} =====\n${stderr ? `--- stderr ---\n${stderr}\n` : ''}`);
          fs.closeSync(logFd);
        } catch { /* logging must never fail the job */ }
      }
      // Prefer the CLI's own total when a result event made it out before the
      // kill (a session can finish its turn and still get wall-clock-killed
      // during cleanup — observed live on the #810 fault-injection drill,
      // where the estimate path discarded a known-real total_cost_usd).
      const realCost = resultEvent && resultEvent.costUSD != null ? resultEvent.costUSD : null;
      const est = realCost != null ? null : estimateCostUSD(usageTotal, model);
      const cost = { costUSD: realCost != null ? realCost : est, costEstimated: realCost == null && est != null };
      if (timedOut) {
        return resolve(done({
          stage: STAGES.TIMEOUT, pid, exitCode: code, sessionId,
          usage: (resultEvent && resultEvent.usage) || usageTotal, ...cost,
          errorDetail: `killed at ${timeoutMs}ms (SIGTERM + ${graceMs}ms grace)`,
        }));
      }
      if (code !== 0) {
        return resolve(done({
          stage: STAGES.ERROR, pid, exitCode: code, sessionId,
          usage: usageTotal, ...cost,
          errorDetail: (stderr || tail).slice(-500) || `exit ${code}`,
        }));
      }
      // Every exit below carries `...cost` (code-review finding on the S1-S3
      // merge: PARSE and success omitted it — a PARSE exit hid its spend from
      // the breaker, and a result event lacking total_cost_usd shipped null
      // instead of the estimate).
      if (!resultEvent) {
        // Exit 0 with no result event: stream ended without the terminal
        // envelope — same trust-nothing stance as the old PARSE stage.
        return resolve(done({ stage: STAGES.PARSE, pid, exitCode: code, sessionId, usage: usageTotal, ...cost, errorDetail: tail.slice(-300) }));
      }
      if (!resultEvent.resultText.trim()) {
        // Auth-expiry / silent no-op class: valid envelope, nothing produced.
        return resolve(done({ stage: STAGES.EMPTY, pid, exitCode: code, sessionId: resultEvent.sessionId || sessionId, usage: resultEvent.usage || usageTotal, ...cost, errorDetail: 'result event parsed but result text is empty' }));
      }
      resolve(done({
        ok: true, stage: null, pid, exitCode: code,
        resultText: resultEvent.resultText, sessionId: resultEvent.sessionId || sessionId,
        usage: resultEvent.usage || usageTotal, ...cost,
      }));
    });

    child.stdin.on('error', () => { /* EPIPE if child died instantly; close handler reports */ });
    child.stdin.end(prompt);
  });
}

module.exports = {
  runClaudeCli, parseEnvelope, strippedEnv, STAGES, FORBIDDEN_MODEL_RE,
  authPing, resolvePassAuth, preflightAuth, resolveAuthEnv, AUTH_KEYS,
  parseStreamLine, addUsage, estimateCostUSD, APPROX_MODEL_RATES_PER_MTOK,
  resolveClaudeBin, pathWithClaudeBinDir,
};
