'use strict';
/**
 * codex-runner.js — pure helpers for the daily unattended Codex card runner
 * (scripts/codex/daily-runner.js, BRO-4745). No I/O here, so every decision
 * the runner makes is unit-tested (tests/unit/codex-runner.test.mjs).
 *
 * Pieces:
 *  - encryptAuth / decryptAuth / authCommentBody / parseAuthComment: the
 *    Codex ChatGPT login (~/.codex/auth.json) is stored AES-256-GCM encrypted
 *    in one comment on the storage card, so each fresh cloud session can
 *    restore it and save the refreshed one (refresh tokens rotate, so the
 *    newest file must always be the one stored).
 *  - parseVerdict: the Claude check's last `VERDICT:` line.
 *  - latestWeeklyPercent: Codex's weekly allowance use from a rollout file.
 *  - nextStep: what the runner does after a Codex attempt + Claude check.
 *  - looksLikeSecretLeak: refuse to push a diff carrying token material.
 */

const crypto = require('crypto');

const AUTH_MARKER = '<!-- codex-auth-v1 -->';
// Opens every comment the runner posts when Codex could not finish a card, so
// the next day's run leaves that card to the Claude worker instead of looping.
const BOUNCED_MARKER = '<!-- codex-runner-bounced -->';
const BOUNCE_MEMORY_MS = 14 * 24 * 3600_000;
const HKDF_SALT = 'bsc-codex-runner-auth-v1';

function deriveKey(keyMaterial) {
  if (!keyMaterial || typeof keyMaterial !== 'string') throw new Error('no key material for the Codex login store');
  return Buffer.from(crypto.hkdfSync('sha256', Buffer.from(keyMaterial), Buffer.from(HKDF_SALT), Buffer.from('auth.json'), 32));
}

/** Encrypt auth.json bytes. Returns base64 of iv(12) | tag(16) | ciphertext. */
function encryptAuth(plain, keyMaterial) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

/** Inverse of encryptAuth. Throws on a wrong key or a tampered blob. */
function decryptAuth(b64, keyMaterial) {
  const buf = Buffer.from(String(b64).trim(), 'base64');
  if (buf.length < 29) throw new Error('stored Codex login is truncated');
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(keyMaterial), buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

/** `last_refresh` of an auth.json text, or '' when absent/unparseable. */
function authLastRefresh(text) {
  try { return String(JSON.parse(text).last_refresh || ''); } catch { return ''; }
}

function authCommentBody(blob, lastRefresh, nowIso) {
  return [
    AUTH_MARKER,
    'Encrypted Codex login for the daily Codex runner (scripts/codex/auth-store.js). Do not edit or delete.',
    `last_refresh: ${lastRefresh || 'unknown'} · saved: ${nowIso}`,
    '```',
    blob,
    '```',
  ].join('\n');
}

/** { blob, lastRefresh } from a storage comment body, or null if not one. */
function parseAuthComment(body) {
  if (typeof body !== 'string' || !body.startsWith(AUTH_MARKER)) return null;
  const m = body.match(/```\n([A-Za-z0-9+/=\n]+?)\n```/);
  if (!m) return null;
  const lr = body.match(/last_refresh: (\S+)/);
  return { blob: m[1].replace(/\n/g, ''), lastRefresh: lr && lr[1] !== 'unknown' ? lr[1] : '' };
}

/**
 * Which way to sync. Refresh tokens rotate, so the copy with the newer
 * last_refresh wins; equal stamps mean nothing to do.
 */
function syncDirection(localLastRefresh, storedLastRefresh) {
  if (!localLastRefresh && !storedLastRefresh) return 'none';
  if (!storedLastRefresh) return 'save';
  if (!localLastRefresh) return 'restore';
  if (localLastRefresh === storedLastRefresh) return 'none';
  return localLastRefresh > storedLastRefresh ? 'save' : 'restore';
}

const VERDICTS = ['SHIP-WITH-FIXES', 'SHIP', 'REJECT'];

/** Last `VERDICT: X` line in a reviewer's text, or 'NONE'. Bold/markdown tolerated. */
function parseVerdict(text) {
  // Line-anchored only: a blocking line that mentions "VERDICT: SHIP" mid-sentence must not count.
  const re = /^[\s>*_#-]*VERDICT:\**\s*\**\s*(SHIP-WITH-FIXES|SHIP|REJECT)\b/gm;
  let m; let last = 'NONE';
  while ((m = re.exec(String(text || ''))) !== null) last = m[1];
  return VERDICTS.includes(last) ? last : 'NONE';
}

/** Highest weekly (secondary or primary 10080-minute) used_percent in rollout JSONL text. */
function latestWeeklyPercent(rolloutText) {
  let pct = null;
  for (const line of String(rolloutText || '').split('\n')) {
    if (!line.includes('rate_limits')) continue;
    let row; try { row = JSON.parse(line); } catch { continue; }
    const rl = findRateLimits(row);
    if (!rl) continue;
    for (const w of [rl.primary, rl.secondary]) {
      if (w && Number.isFinite(w.used_percent) && (w.window_minutes == null || w.window_minutes >= 10080)) pct = w.used_percent;
    }
  }
  return pct;
}

function findRateLimits(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (obj.rate_limits && typeof obj.rate_limits === 'object') return obj.rate_limits;
  for (const v of Object.values(obj)) {
    const r = findRateLimits(v, depth + 1);
    if (r) return r;
  }
  return null;
}

/**
 * After a Codex attempt and its Claude check:
 *  - SHIP with a diff  -> 'land'
 *  - SHIP with no diff -> 'close-already-fixed' (Claude confirmed nothing was needed)
 *  - anything else on attempt 1 -> 'fix-round' (findings go back to Codex once)
 *  - anything else on attempt 2 -> 'bounce' (card back to Todo with the findings)
 */
function nextStep({ verdict, hasDiff, attempt }) {
  if (verdict === 'SHIP') return hasDiff ? 'land' : 'close-already-fixed';
  return attempt >= 2 ? 'bounce' : 'fix-round';
}

const SECRET_PATTERNS = [
  /"refresh_token"\s*:/,
  /"access_token"\s*:\s*"ey/,
  /\beyJhbGciOi[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, // a JWT
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/,
  /\blin_api_[A-Za-z0-9]{20,}/,
];

/** True when an added diff line carries token material (refuse to push). */
// Env vars Codex and the reviewer must not see. GIT_CONFIG_KEY_n/VALUE_n are git's own
// env config (the proxy's github URL rewrites); dropping KEY_n while GIT_CONFIG_COUNT stays
// makes every git command fail, which silently blinded the reviewer.
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|COOKIE|CREDENTIAL|WEBHOOK|ASKPASS|AUTH|PRIVATE|DSN/i;
// The Claude reviewer authenticates with its own session vars; Codex never gets them.
function keepEnvVar(name, { reviewer = false } = {}) {
  if (/^GIT_CONFIG_/.test(name)) return true;
  if (reviewer && /^(CLAUDE_|ANTHROPIC_)/.test(name)) return true;
  return !SECRET_ENV.test(name);
}

// Pushes from the Codex or reviewer shells go nowhere: only the runner lands, after the check.
const PUSH_BLOCK = 'https://push-blocked.invalid/';
const PUSH_PREFIXES = ['https://github.com/', 'http://github.com/', 'git@github.com:', 'ssh://git@github.com/'];

function scrubEnv(env, opts = {}) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (keepEnvVar(k, opts)) out[k] = v;
  let n = Number(out.GIT_CONFIG_COUNT) || 0;
  for (const prefix of PUSH_PREFIXES) {
    out[`GIT_CONFIG_KEY_${n}`] = `url.${PUSH_BLOCK}.pushInsteadOf`;
    out[`GIT_CONFIG_VALUE_${n}`] = prefix;
    n += 1;
  }
  out.GIT_CONFIG_COUNT = String(n);
  return out;
}

/** Replace known secret values (from env) and token-shaped strings before text is posted anywhere. */
function redactSecrets(text, env = {}) {
  let s = String(text || '');
  const values = Object.entries(env)
    .filter(([k, v]) => SECRET_ENV.test(k) && !/^GIT_CONFIG_/.test(k) && typeof v === 'string' && v.length >= 12)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length);
  for (const v of values) s = s.split(v).join('[redacted]');
  return s
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '[redacted-jwt]')
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, '[redacted-key]')
    .replace(/\blin_api_[A-Za-z0-9]{20,}/g, '[redacted-key]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted-key]')
    .replace(/("(?:refresh_token|access_token|id_token)"\s*:\s*")[^"]+/g, '$1[redacted]');
}

/** Card description plus its comments (oldest first), so acceptance corrections in comments reach both models. */
function cardBody(description, comments, { maxDesc = 30000, maxComments = 14000, maxEach = 2500 } = {}) {
  const desc = String(description || '').slice(0, maxDesc);
  const list = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && String(c.body || '').trim())
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const parts = [];
  let used = 0;
  for (const c of list.slice().reverse()) { // keep the newest when over budget
    const one = `--- comment ${String(c.createdAt || '').slice(0, 16)} ---\n${String(c.body).slice(0, maxEach)}`;
    if (used + one.length > maxComments) break;
    parts.unshift(one);
    used += one.length;
  }
  if (!parts.length) return desc;
  const skipped = list.length - parts.length;
  return `${desc}\n\n## Card comments (oldest first${skipped ? `; ${skipped} older omitted` : ''}; a newer comment can correct the description)\n\n${parts.join('\n\n')}`;
}

function looksLikeSecretLeak(diffText) {
  return String(diffText || '').split('\n')
    .filter((l) => l.startsWith('+') && !l.startsWith('+++'))
    .some((l) => SECRET_PATTERNS.some((re) => re.test(l)));
}

/** Fill {{ID}} {{TITLE}} {{BODY}} {{EXTRA}} in a prompt template. */
function fillPrompt(template, { id, title, body, extra = '' }) {
  return template
    .replace(/\{\{ID\}\}/g, id)
    .replace(/\{\{TITLE\}\}/g, title || '')
    .replace(/\{\{BODY\}\}/g, body || '')
    .replace(/\{\{EXTRA\}\}/g, extra || '');
}

/** True when the runner bounced this card within the last 14 days. */
function codexBouncedRecently(comments, nowMs) {
  return (Array.isArray(comments) ? comments : []).some((c) => c && String(c.body || '').startsWith(BOUNCED_MARKER)
    && Number.isFinite(Date.parse(c.createdAt)) && nowMs - Date.parse(c.createdAt) < BOUNCE_MEMORY_MS);
}

/**
 * Run-lock commit message. It names the cards the run has claimed but not finished, so a
 * run that takes over a dead run's stale lock knows which cards to land or hand back.
 */
function lockMessage(iso, cardIds = [], verb = 'locked') {
  const ids = [...new Set(cardIds)].filter((id) => /^BRO-\d+$/.test(id));
  return `${verb} ${iso}${ids.length ? ` cards=${ids.join(',')}` : ''}`;
}
/**
 * -> card ids named by a lock message ([] for "unlocked" or an older message without them).
 * "released <iso> cards=..." is a free lock left by a run that stopped with landings
 * unfinished: the next run takes it at once and adopts those cards.
 */
function lockCards(message) {
  const m = String(message || '').match(/^(?:locked|released) \S+ cards=([A-Z0-9,-]+)\s*$/);
  return m ? m[1].split(',').filter((id) => /^BRO-\d+$/.test(id)) : [];
}

/**
 * What to do with a card a dead run's stale lock names. Only a card still In Progress from
 * a start no later than that lock stamp is the dead run's (Linear clears startedAt when a
 * card goes back to Todo, so a later re-claim by anyone moves startedAt past the stamp).
 * A land ref counts as that run's landing only if it was committed after that start;
 * an older one is a refused ref from an earlier attempt.
 * -> 'skip' | 'done' (fix on main) | 'park' (landing pending) | 'todo' (hand back)
 */
// Linear's clock vs the container's (lock commit time, whole seconds): a claim stamped
// right after the claim can read a few seconds "earlier" than startedAt.
const ORPHAN_CLOCK_SKEW_MS = 120_000;

function orphanAction({ stateName, startedAtMs, lockMs, onMain, landRefMs }) {
  if (stateName !== 'In Progress') return 'skip';
  if (!Number.isFinite(startedAtMs) || !Number.isFinite(lockMs) || startedAtMs > lockMs + ORPHAN_CLOCK_SKEW_MS) return 'skip';
  if (onMain) return 'done';
  if (Number.isFinite(landRefMs) && landRefMs >= startedAtMs) return 'park';
  return 'todo';
}

/** Stop the run early (like close-stuck-verified-cards' closeRunStopReason). */
function stopReason({ startedMs, nowMs, maxMinutes, weeklyPct, maxWeeklyPct, rejectStreak, doneRefusals, checkSpentUsd = 0, checkBudgetUsd = null }) {
  if (checkBudgetUsd != null && checkSpentUsd >= checkBudgetUsd) return `Claude check spend $${checkSpentUsd.toFixed(2)} reached the run cap of $${checkBudgetUsd}`;
  if (maxMinutes && nowMs - startedMs > maxMinutes * 60_000) return `time budget of ${maxMinutes} min used`;
  if (weeklyPct != null && maxWeeklyPct != null && weeklyPct >= maxWeeklyPct) return `Codex weekly allowance at ${weeklyPct}% (cap ${maxWeeklyPct}%)`;
  if (rejectStreak >= 3) return '3 Claude REJECTs in a row';
  if (doneRefusals >= 1) return 'the Done gate refused a card the Claude check passed';
  return null;
}

/**
 * `claude -p --output-format json` -> { text, costUsd }. The JSON carries the review text in
 * `result` and the API cost in `total_cost_usd`; anything else (a crash banner) is kept as text.
 */
function parseCheckOutput(stdout) {
  const s = String(stdout || '').trim();
  try {
    const j = JSON.parse(s.slice(s.indexOf('{')));
    if (j && typeof j === 'object') {
      return { text: typeof j.result === 'string' ? j.result : '', costUsd: Number(j.total_cost_usd) || 0, error: j.is_error ? String(j.subtype || 'error') : null };
    }
  } catch { /* not JSON */ }
  return { text: s, costUsd: 0, error: null };
}

module.exports = {
  parseCheckOutput,
  lockMessage,
  lockCards,
  orphanAction,
  keepEnvVar,
  scrubEnv,
  redactSecrets,
  cardBody,
  AUTH_MARKER,
  BOUNCED_MARKER,
  codexBouncedRecently,
  encryptAuth,
  decryptAuth,
  authLastRefresh,
  authCommentBody,
  parseAuthComment,
  syncDirection,
  parseVerdict,
  latestWeeklyPercent,
  nextStep,
  looksLikeSecretLeak,
  fillPrompt,
  stopReason,
};
