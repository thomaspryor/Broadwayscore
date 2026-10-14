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
// Opens every runner note about a landing that leaves card items undone, so whichever
// path settles the landing (this run, reconcileLanded, recoverOrphans) returns the card
// to Todo instead of closing it.
const PARTIAL_MARKER = '<!-- codex-runner-partial -->';
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

// Attempts a card may take: a plain REJECT gets one fix round (like before); a
// SHIP-WITH-FIXES verdict (right approach, specific findings left) gets one more.
const MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_SHIP_WITH_FIXES = 3;

/**
 * After a Codex attempt and its Claude check:
 *  - SHIP with a diff  -> 'land'
 *  - SHIP with no diff -> 'close-already-fixed' (Claude confirmed nothing was needed)
 *  - no diff because the environment blocked Codex (its ENVIRONMENT-BLOCKED line), once per
 *    card -> 'env-retry': the same attempt again with the findings; it does not use up a round
 *  - SHIP-WITH-FIXES -> 'fix-round' until attempt 3
 *  - anything else -> 'fix-round' on attempt 1, then 'bounce' (card back to Todo with the findings)
 */
function nextStep({ verdict, hasDiff, attempt, envBlocked = false, envRetryUsed = false }) {
  if (verdict === 'SHIP') return hasDiff ? 'land' : 'close-already-fixed';
  if (!hasDiff && envBlocked && !envRetryUsed) return 'env-retry';
  const cap = verdict === 'SHIP-WITH-FIXES' ? MAX_ATTEMPTS_SHIP_WITH_FIXES : MAX_ATTEMPTS;
  return attempt >= cap ? 'bounce' : 'fix-round';
}

/** Codex's `ENVIRONMENT-BLOCKED: <what>` report line (runner-prompt.md asks for it), or null. */
function parseEnvBlocked(report) {
  const m = /^[\s>*_#-]*ENVIRONMENT-BLOCKED:\**\s*(.+)$/m.exec(String(report || ''));
  if (!m) return null;
  const what = m[1].trim();
  return what && !/^(none|no|n\/a)\.?$/i.test(what) ? what.slice(0, 500) : null;
}

/**
 * The reviewer's `REMAINING: <item>` lines: card items a correct change leaves undone (a
 * backfill that needs the private data repos, a live scrape). `REMAINING: none` -> [].
 * A SHIP with items lands, then the card goes back to Todo with them, not to Done.
 */
function parseRemaining(text) {
  const out = [];
  const re = /^[\s>*_#-]*REMAINING:\**\s*(.+)$/gm;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const item = m[1].trim();
    if (item && !/^(none|nothing|n\/a)\.?$/i.test(item)) out.push(item.slice(0, 400));
  }
  return out;
}

/**
 * Private data the runner gives each fresh worktree (after `git clean -x` wipes it), by
 * explicit allow-list: never a blanket copy of every gitignored data/ entry (billing PII,
 * subscriber lists and aggregator archives sit there too, and a symlinked directory slips
 * past a trailing-slash .gitignore rule). Files are COPIED, so a test or Codex write never
 * reaches the shared clone; the one directory, review-texts, is a symlink (too big to copy).
 * The gitignored part of scripts/setup-local-data.sh's SYMLINK/COPY/GENERATED lists (tracked
 * ones such as awards.json come with the checkout).
 */
const DATA_FILES = [
  'shows.json', 'reviews.json', 'commercial.json', 'diary-shows.json', 'retired-show-ids.json', 'deleted-shows.json',
  'critic-slug-aliases.json', 'audience-buzz.json', 'critic-consensus.json',
  'critic-registry.json', 'grosses.json', 'grosses-history.json', 'mezzanine-productions-raw.json',
  'cast-manifest.json', 'actor-slugs.json',
];
const DATA_DIRS = ['review-texts'];

/**
 * Remove a worktree's data dir whether it is the symlink provideData() made or a real
 * directory a test created while the link was dropped (land-check batches and the reviewer
 * run without it). fs.rmSync(p, {force:true}) on a real directory throws EISDIR, which
 * bounced every card of the 2026-10-10 22:47 run. A real directory is removed only when it
 * resolves inside `root` (the disposable worktree); a symlink is unlinked, never followed,
 * so the shared clone it points at is never touched. -> 'none'|'unlinked'|'removed'|'skipped'
 */
function dropDataDir(p, root) {
  const fs = require('fs');
  const path = require('path');
  let st;
  try { st = fs.lstatSync(p); } catch { return 'none'; }
  if (st.isSymbolicLink() || !st.isDirectory()) { fs.unlinkSync(p); return 'unlinked'; }
  const real = fs.realpathSync(p);
  const base = fs.realpathSync(root) + path.sep;
  if (!real.startsWith(base)) return 'skipped';
  fs.rmSync(real, { recursive: true, force: true });
  return 'removed';
}

/** True when a git config text stores a credential in a remote URL (never hand that clone to Codex). */
function hasCredentialRemote(gitConfigText) {
  return /^\s*(?:url|pushurl)\s*=\s*\S*:\/\/[^/\s@]+@/m.test(String(gitConfigText || ''));
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

/**
 * Fill {{ID}} {{TITLE}} {{DATA}} {{EXTRA}} {{BODY}} in a prompt template. One pass, so text
 * inside a card body or report that looks like a placeholder is never expanded.
 */
function fillPrompt(template, { id, title, body, extra = '', data = '', worktree = '' }) {
  const vals = { ID: id, TITLE: title || '', BODY: body || '', EXTRA: extra || '', DATA: data || '', WORKTREE: worktree || '' };
  return template.replace(/\{\{(ID|TITLE|BODY|EXTRA|DATA|WORKTREE)\}\}/g, (_, k) => vals[k]);
}

/**
 * True when the runner posted a partial-landing note (PARTIAL_MARKER) on the card since
 * sinceMs (the claim's startedAt): that landing leaves card items undone, so whichever path
 * settles it sends the card back to Todo, never to Done. No sinceMs: nothing counts.
 */
function landingIsPartial(comments, sinceMs) {
  if (!Number.isFinite(sinceMs)) return false;
  return (Array.isArray(comments) ? comments : []).some((c) => c && String(c.body || '').includes(PARTIAL_MARKER)
    && Number.isFinite(Date.parse(c.createdAt)) && Date.parse(c.createdAt) >= sinceMs - ORPHAN_CLOCK_SKEW_MS);
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
 * Who stamped a lock: the session (or host) plus pid, written as a `Run: <id>` line in the
 * lock commit's body. The subject keeps its old shape so lockCards and older runners still
 * read it (BRO-5287: a stamp with no owner could not be told apart from another run's).
 */
function runnerId(env = process.env, host = require('os').hostname(), pid = process.pid) {
  const who = env.CLAUDE_CODE_REMOTE_SESSION_ID || (env.GITHUB_RUN_ID ? `gha-${env.GITHUB_RUN_ID}` : host);
  return `${String(who || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 80)}/${pid}`;
}
/** -> the `Run: <id>` of a lock commit body, or '' for an older stamp without one. */
function lockRun(body) {
  const m = String(body || '').match(/^Run: (\S+)\s*$/m);
  return m ? m[1] : '';
}

/**
 * After a failed lock push, what the remote tip says. The runner made every lock commit it
 * pushed (commit-tree), so a tip among ownShas is still this run's lock (its stamp landed
 * with the reply lost, or the push failed and the old stamp stands). Unreadable or empty:
 * 'retry'. Only a tip this run never made means another run moved it: 'lost'. Before
 * BRO-5287 three failed pushes alone read as lost, and the 2026-10-13 runs stopped with
 * "another run took the lock" while the tip was still their own stamp.
 */
function lockTipVerdict({ tip, ownShas }) {
  if (!tip) return 'retry';
  return ownShas && ownShas.has(tip) ? 'ours' : 'lost';
}

/**
 * True when a lock this run could not re-stamp may go stale (another run may then take it)
 * before the next blocking step ends: stop rather than run on unprotected. 5 min margin.
 */
function lockStampTooOld({ lastStampOkMs, nowMs, staleMs, nextBlockMs = 0 }) {
  if (!Number.isFinite(lastStampOkMs)) return true;
  return nowMs - lastStampOkMs + nextBlockMs >= staleMs - 5 * 60_000;
}

// A failed `codex exec` the next try may not hit: provider capacity, overload, rate limits,
// 5xx, dropped streams (2026-10-13 06:55: "Selected model is at capacity" stopped a whole run).
const CODEX_TRANSIENT_RE = /model is at capacity|\boverloaded\b|rate.?limit|\b(?:429|500|502|503|504)\b|stream (?:disconnected|error)|connection (?:reset|refused|closed)|ETIMEDOUT|ECONNRESET|temporarily unavailable|server_error/i;
/** The capacity/transient line of a failed Codex exec's full output, or null. */
function codexExitTransient(output) {
  // Codex's own ERROR lines near the end only: tool output (tests, curl) inside a long exec can
  // mention a 503 and must not make a timeout or crash look like a provider hiccup.
  const line = String(output || '').split('\n').slice(-40).find((l) => /^\s*(?:ERROR|error):/.test(l) && CODEX_TRANSIENT_RE.test(l));
  return line ? line.trim().slice(0, 200) : null;
}

/** Drop Codex's `hook: <Event>[ Completed]` progress lines, which crowd the real error out of a tail. */
function stripHookNoise(text) {
  return String(text || '').split('\n').filter((l) => !/^\s*hook: \w+(?: Completed| Failed)?\s*$/.test(l)).join('\n');
}

/**
 * How well a card suits an unattended Codex run (BRO-5287: 18 cards bounced on 2026-10-12/13,
 * most of them Mac-only, credential- or credit-bound, workflow wiring the runner never lands,
 * private-data or live-site work, or multi-phase). -> { skip: reason|null, score } where a
 * higher score goes first. Mac-only is a skip; the rest only lowers the score, and a score at
 * or under CODEX_MIN_SCORE is a skip ('too-broad').
 */
const CODEX_MIN_SCORE = -6;
const CODEX_MAC_RE = /\b(?:launchd|launchctl|LaunchAgents?|cmux|Keychain|Mac[- ]only|on the Mac|Mac launcher|~\/Library)\b/i;
const CODEX_PENALTIES = [
  [/\.github\/workflows\/|\b(?:new|weekly|daily|nightly) (?:cron|workflow)\b|\bwire\b[^.\n]{0,60}\b(?:cron|workflow)\b/i, 4, 'workflow'],
  [/\bcredentials?\b|\bcredits\b|\bAPI key\b|\bsecrets?\b/i, 3, 'credentials'],
  [/\bbackfill\b|corpus[- ]wide|\bevery (?:show|review)\b|\blifetime sweep\b|\bre-?scrape\b/i, 3, 'bulk-data'],
  [/\blive (?:site|page|pages|scrape|fetch)\b|\bprivate (?:data|repo)\b|review-texts\b|core-data\b/i, 3, 'private-or-live-data'],
  [/\bPhase \d\b|\bmulti-part\b|\bfollow-?ups?\b/i, 2, 'multi-phase'],
];
function codexCardFit({ title = '', description = '', verify = '' } = {}) {
  const text = `${title}\n${description}`;
  if (CODEX_MAC_RE.test(text)) return { skip: 'mac-only', score: -Infinity, why: ['mac-only'] };
  let score = 0;
  const why = [];
  if (/^node --test (?:--\S+ )*\S+\.test\.m?js$/.test(String(verify || '').trim())) { score += 3; why.push('single-test-verify'); }
  for (const [re, cost, name] of CODEX_PENALTIES) if (re.test(text)) { score -= cost; why.push(name); }
  const extraK = Math.floor(Math.max(0, String(description).length - 1500) / 1000);
  if (extraK) { score -= extraK; why.push(`long+${extraK}k`); }
  const accept = String(description).split(/^##+ *Acceptance[^\n]*$/im)[1] || '';
  const items = (accept.split(/^##+ /m)[0].match(/^\s*(?:[-*]|\d+\.)\s+/gm) || []).length;
  if (items > 3) { score -= 2; why.push(`acceptance-items:${items}`); }
  return { skip: score <= CODEX_MIN_SCORE ? 'too-broad' : null, score, why };
}

/**
 * Minutes a landing may be waited for: wait-for-land's usual 90, cut so the run still has
 * wrapUpMs before its hard stop (BRO-5287: the routine kills the runner at 120 min). < 1 = do not wait.
 */
function landWaitMinutes({ hardEndMs, wrapUpMs, nowMs }) {
  return Math.min(90, Math.floor((hardEndMs - wrapUpMs - nowMs) / 60_000));
}

/**
 * BRO-5287 acceptance over the runner's own "## Codex runner" summaries (BRO-4745 comments):
 * at least `minRuns` summaries, none whose "Stopped early" line names the lock, and at least one
 * card landed. -> { ok, runs, landed, problems[] }
 */
function assessRunnerSummaries(bodies, { minRuns = 3 } = {}) {
  const runs = (Array.isArray(bodies) ? bodies : []).filter((b) => /^## Codex runner \d{4}-\d{2}-\d{2}:/.test(String(b || '')));
  const problems = [];
  let landed = 0;
  for (const b of runs) {
    const stop = (b.match(/^- Stopped early: (.*)$/m) || [])[1] || '';
    if (/lock/i.test(stop)) problems.push(`stopped on the lock: ${stop}`);
    for (const label of ['Landed and Done', 'Landed part, back to Todo with what is left']) {
      const list = (b.match(new RegExp(`^- ${label}: (.*)$`, 'm')) || [])[1] || 'none';
      if (list !== 'none') landed += list.split(',').length;
    }
  }
  if (runs.length < minRuns) problems.push(`only ${runs.length} run summaries (want ${minRuns})`);
  if (!landed) problems.push('no card landed');
  return { ok: problems.length === 0, runs: runs.length, landed, problems };
}

/**
 * The daily health row for the Codex runner (BRO-5287: it broke for 19 hours on 2026-10-13
 * and nothing noticed until a session went looking). Reads the runner's own "## Codex runner"
 * summaries ({ createdAt, body }) from the last 24 h:
 *  - no summary at all          -> error (the runner is not running; it fires every 2 h)
 *  - a run stopped on the lock  -> error
 *  - nothing landed             -> error (the original "lands nothing" failure)
 *  - 2+ cards crashed mid-card  -> warn
 * -> { status: 'pass'|'warn'|'error', message }
 */
function runnerHealth(comments, nowMs, { windowMs = 24 * 3600_000 } = {}) {
  const recent = (Array.isArray(comments) ? comments : [])
    .filter((c) => c && /^## Codex runner \d{4}-\d{2}-\d{2}:/.test(String(c.body || ''))
      && Number.isFinite(Date.parse(c.createdAt)) && Date.parse(c.createdAt) <= nowMs && nowMs - Date.parse(c.createdAt) <= windowMs);
  if (!recent.length) {
    const noLogin = (Array.isArray(comments) ? comments : []).some((c) => c && String(c.body || '').startsWith('## Codex runner did not start')
      && Date.parse(c.createdAt) <= nowMs && nowMs - Date.parse(c.createdAt) <= windowMs);
    return { status: 'error', message: noLogin
      ? 'Codex runner could not start in the last 24h: its Codex login is not usable (see "## Codex runner did not start" on BRO-4745).'
      : 'No Codex runner summary in the last 24h: the runner is not running (it should post one every 2 hours).' };
  }
  const list = (b, label) => {
    const v = (String(b).match(new RegExp(`^- ${label}: (.*)$`, 'm')) || [])[1] || 'none';
    return v === 'none' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean);
  };
  let landed = 0; let crashed = 0; const lockStops = [];
  for (const c of recent) {
    landed += list(c.body, 'Landed and Done').length + list(c.body, 'Landed part, back to Todo with what is left').length;
    crashed += list(c.body, 'Runner error mid-card \\(back to Todo\\)').length;
    const stop = (String(c.body).match(/^- Stopped early: (.*)$/m) || [])[1] || '';
    if (/lock/i.test(stop)) lockStops.push(c.createdAt.slice(0, 16));
  }
  const facts = `${recent.length} run(s), ${landed} card(s) landed, ${crashed} crashed mid-card in the last 24h`;
  if (lockStops.length) return { status: 'error', message: `Codex runner stopped on its run lock (${lockStops.join(', ')}): ${facts}.` };
  if (!landed) return { status: 'error', message: `Codex runner landed nothing: ${facts}.` };
  if (crashed >= 2) return { status: 'warn', message: `Codex runner crashed on ${crashed} cards: ${facts}.` };
  return { status: 'pass', message: `${facts}.` };
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

/**
 * BRO-2483: what a land batch with NO files means. The node unit batch can
 * never legitimately be empty (an empty collection means the collector or the
 * tree is broken), so it fails closed; the other file batches (scripts/lib)
 * read as clean, as before. null = the batch has files (or none are listed
 * because the gate is not file-based): run it.
 */
function emptyBatchVerdict(gate, files) {
  if (!Array.isArray(files) || files.length > 0) return null;
  if (gate === 'unit-tests-node') {
    return { exit: 1, text: '::error::the node unit batch is empty: scripts/lib/unit-test-collection.js (or, in a pre-BRO-2483 tree, tests/unit-test-manifest.txt) returned no files\n' };
  }
  return { exit: 0, text: '' };
}

module.exports = {
  emptyBatchVerdict,
  parseCheckOutput,
  lockMessage,
  lockCards,
  runnerId,
  lockRun,
  lockTipVerdict,
  lockStampTooOld,
  landWaitMinutes,
  assessRunnerSummaries,
  runnerHealth,
  codexExitTransient,
  stripHookNoise,
  codexCardFit,
  CODEX_MIN_SCORE,
  orphanAction,
  keepEnvVar,
  scrubEnv,
  redactSecrets,
  cardBody,
  AUTH_MARKER,
  BOUNCED_MARKER,
  PARTIAL_MARKER,
  landingIsPartial,
  parseEnvBlocked,
  parseRemaining,
  DATA_FILES,
  DATA_DIRS,
  dropDataDir,
  hasCredentialRemote,
  MAX_ATTEMPTS_SHIP_WITH_FIXES,
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
