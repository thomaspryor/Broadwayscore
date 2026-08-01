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

function strippedEnv(extra = {}) {
  const keep = ['PATH', 'HOME', 'TERM', 'LANG', 'LC_ALL', ...AUTH_KEYS];
  const env = {};
  for (const k of keep) { if (process.env[k] !== undefined) env[k] = process.env[k]; }
  env.HOME = env.HOME || os.homedir();
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
  const r = spawnSync('claude', ['-p', 'Reply with exactly: pong', '--model', 'sonnet', '--output-format', 'json'],
    // resolveAuthEnv() sits above process.env for the same reason as in
    // strippedEnv: under launchd the keys are absent, and the probe has to
    // exercise the SAME credentials the real spawn will get or it proves
    // nothing. extraEnv still wins so probe 1 can force the no-API-key shape.
    { encoding: 'utf8', timeout: 120000, env: { ...process.env, ...resolveAuthEnv(), ...extraEnv } });
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
  if (stored.ok) return { ok: true, mode: 'oauth' };
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
    return { ok: true, mode: 'api-key', storedDetail: stored.detail };
  }
  return { ok: false, mode: 'fail', detail: `stored-login: ${stored.detail} | api-key: ${keyed.detail}` };
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

/**
 * Run one headless Claude session.
 *
 * @param {object} opts
 * @param {string} opts.prompt            prompt text (sent via stdin)
 * @param {string} opts.cwd               working directory (resume is cwd-scoped)
 * @param {string} [opts.model]           model slug; refused if it matches FORBIDDEN_MODEL_RE
 * @param {string} [opts.resumeSessionId] continue a prior session by id
 * @param {number} [opts.timeoutMs]       wall clock, default 30 min, SIGKILL on expiry
 * @param {number} [opts.maxBufferBytes]  stdout cap, default 16 MB
 * @param {string} [opts.logFile]         raw envelope appended here (created if absent)
 * @param {string} [opts.settingsPath]    optional --settings deny-list file
 * @param {object} [opts.env]             extra env merged over the stripped base
 * @param {(pid:number)=>void} [opts.onSpawn]  called with the child PID immediately
 * @returns {Promise<{ok:boolean, stage:string|null, resultText:string, sessionId:string|null,
 *                    exitCode:number|null, pid:number|null, durationMs:number,
 *                    usage:object|null, costUSD:number|null, errorDetail:string|null}>}
 * Never rejects — failures come back as {ok:false, stage}.
 */
function runClaudeCli(opts) {
  const {
    prompt, cwd, model, resumeSessionId,
    timeoutMs = 30 * 60 * 1000,
    maxBufferBytes = 16 * 1024 * 1024,
    logFile = null,
    settingsPath = null,
    env = {},
    onSpawn = null,
  } = opts;

  const started = Date.now();
  const done = (r) => ({
    ok: false, stage: null, resultText: '', sessionId: resumeSessionId || null,
    exitCode: null, pid: null, usage: null, costUSD: null, errorDetail: null,
    ...r, durationMs: Date.now() - started,
  });

  if (!prompt || !cwd) {
    return Promise.resolve(done({ stage: STAGES.ERROR, errorDetail: 'prompt and cwd are required' }));
  }
  if (model && FORBIDDEN_MODEL_RE.test(model)) {
    return Promise.resolve(done({ stage: STAGES.FORBIDDEN_MODEL, errorDetail: `refused model "${model}" for unattended run` }));
  }

  const args = ['--print', '--output-format', 'json', '--dangerously-skip-permissions'];
  if (model) args.push('--model', model);
  if (settingsPath) args.push('--settings', settingsPath);
  if (resumeSessionId) args.push('--resume', resumeSessionId);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('claude', args, { cwd, env: strippedEnv(env), stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve(done({ stage: STAGES.ERROR, errorDetail: `spawn failed: ${e.message}` }));
    }

    const pid = child.pid || null;
    if (onSpawn && pid) { try { onSpawn(pid); } catch { /* caller's problem, not the job's */ } }

    child.stdout.setEncoding('utf8'); // multibyte chars must never split across chunks
    child.stderr.setEncoding('utf8');
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (d) => {
      if (stdout.length < maxBufferBytes) stdout += d;
    });
    child.stderr.on('data', (d) => {
      if (stderr.length < 64 * 1024) stderr += d;
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(done({ stage: STAGES.ERROR, pid, errorDetail: `child error: ${e.message}` }));
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (logFile) {
        try {
          fs.mkdirSync(path.dirname(logFile), { recursive: true });
          fs.appendFileSync(logFile, `\n===== ${new Date().toISOString()} exit=${code}${timedOut ? ' TIMEOUT' : ''} =====\n${stdout}${stderr ? `\n--- stderr ---\n${stderr}` : ''}`);
        } catch { /* logging must never fail the job */ }
      }
      if (timedOut) return resolve(done({ stage: STAGES.TIMEOUT, pid, exitCode: code, errorDetail: `killed at ${timeoutMs}ms` }));

      const env2 = parseEnvelope(stdout);
      if (code !== 0) {
        return resolve(done({
          stage: STAGES.ERROR, pid, exitCode: code,
          sessionId: env2.sessionId || resumeSessionId || null,
          errorDetail: (stderr || stdout).slice(-500) || `exit ${code}`,
        }));
      }
      if (!env2.parsed) return resolve(done({ stage: STAGES.PARSE, pid, exitCode: code, errorDetail: stdout.slice(-300) }));
      if (!env2.resultText.trim()) {
        // Auth-expiry / silent no-op class: valid envelope, nothing produced.
        return resolve(done({ stage: STAGES.EMPTY, pid, exitCode: code, sessionId: env2.sessionId, errorDetail: 'envelope parsed but result text is empty' }));
      }
      resolve(done({
        ok: true, stage: null, pid, exitCode: code,
        resultText: env2.resultText, sessionId: env2.sessionId,
        usage: env2.usage, costUSD: env2.costUSD,
      }));
    });

    child.stdin.on('error', () => { /* EPIPE if child died instantly; close handler reports */ });
    child.stdin.end(prompt);
  });
}

module.exports = {
  runClaudeCli, parseEnvelope, strippedEnv, STAGES, FORBIDDEN_MODEL_RE,
  authPing, resolvePassAuth, preflightAuth, resolveAuthEnv, AUTH_KEYS,
};
