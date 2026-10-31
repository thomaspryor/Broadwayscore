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
const { dataFixesEnabled, canDispatchWorkflows } = require('./codex-data-fixes.js');
// BRO-6303: the summary format and parser are what the trust ladder grades Codex on, so they live in a
// file Codex can never land an edit to (codex-trust-ladder.js isProtectedPath).
const { LANES, summaryHeading, parseSummaryHeading, laneOfSummary, runnerSummaryFacts, runnerSummaryText } = require('./codex-runner-grading.js');
const TL = require('./codex-trust-ladder.js');

const AUTH_MARKER = '<!-- codex-auth-v1 -->';
// Opens every comment the runner posts when Codex could not finish a card, so
// the next day's run leaves that card to the Claude worker instead of looping.
const BOUNCED_MARKER = '<!-- codex-runner-bounced -->';
const BOUNCE_MEMORY_MS = 14 * 24 * 3600_000;
// A partial landing made progress, so the remainder returns to Codex sooner (BRO-6129: 40 of the
// 109 cards banned for 14 days were partials); a card that lands only part twice stays out the full 14 days.
const PARTIAL_HEADING = '## Codex runner: landed part of this card';
const PARTIAL_MEMORY_MS = 3 * 24 * 3600_000;
const PARTIAL_MAX_PER_MEMORY = 2;
// BRO-6144: a card Codex cannot work for a structural reason (the work needs the owner, the Mac,
// a credential the runner lacks, or files Codex may not edit; or it is already fixed) was offered
// again whenever the 14-day timer ran out: 5 of 6 cards of the 2026-10-24 live run. The runner writes
// the class on the bounce note, on its own line AFTER the heading (the marker + heading prefix is
// what isPartial/isCrashNote match). A structural bounce keeps the card away from Codex for
// STRUCTURAL_MEMORY_MS, or until a person comments on the card or a CODEX-OK line says go.
const BOUNCE_CLASS_RE = /^<!-- codex-bounce-class: ([a-z-]+) -->[ \t]*$/m;
const STRUCTURAL_BOUNCE_CLASSES = new Set(['already-fixed', 'owner-decision', 'mac-or-private', 'missing-credential', 'forbidden-files']);
const STRUCTURAL_MEMORY_MS = 60 * 24 * 3600_000;
// Opens every runner note about a landing that leaves card items undone, so whichever
// path settles the landing (this run, reconcileLanded, recoverOrphans) returns the card
// to Todo instead of closing it.
const PARTIAL_MARKER = '<!-- codex-runner-partial -->';
// BRO-6260: one more Codex try for a card Codex bounced. A retry note lifts the bounce memory for every note
// before it (a bounce after it counts as usual), so a card gets one retry per note; scripts/codex-retry-backfill.js
// posts them once. And a plain bounce nobody touched for UNCLAIMED_RETRY_MS returns the card to Codex, once per
// STRUCTURAL_MEMORY_MS: the Claude lane did not take it, so leaving it banned only leaves it undone.
const RETRY_MARKER = '<!-- codex-runner-retry -->';
const UNCLAIMED_RETRY_MS = 7 * 24 * 3600_000;
const HKDF_SALT = 'bsc-codex-runner-auth-v1';

/** Bound card runs to their host; PR landings keep an unlimited default. */
function runnerTimeLimits({ lane = 'cloud', pr = false, maxMinutes, hardStopMinutes } = {}) {
  const limits = {
    maxMinutes: Number(maxMinutes ?? (lane === 'gha' ? 240 : 105)),
    hardStopMinutes: Number(hardStopMinutes ?? (pr ? 0 : lane === 'gha' ? 290 : 112)),
  };
  if (!Number.isFinite(limits.maxMinutes) || limits.maxMinutes <= 0
    || !Number.isFinite(limits.hardStopMinutes)
    || ((hardStopMinutes != null || !pr) && limits.hardStopMinutes < 30)) {
    throw new Error('max-minutes must be positive and hard-stop-minutes must be >= 30; both must be finite');
  }
  return limits;
}

/** Durable, key-free context survives loss of the host and its local log. */
function runnerLockBody({ run, startedMs, hardEndMs, phase }) {
  return [
    `Run: ${run}`,
    `Started: ${new Date(startedMs).toISOString()}`,
    `Hard stop: ${new Date(hardEndMs).toISOString()}`,
    `Phase: ${phase}`,
  ].join('\n');
}

/** A stale lock proves a missing finish, not why the host terminated the process. */
function orphanStopDetails(lock = {}) {
  const body = String(lock.body || '');
  const field = (name) => (body.match(new RegExp(`^${name}: (.+)$`, 'm')) || [])[1] || 'not recorded';
  const phase = field('Phase');
  const hardStop = field('Hard stop');
  const overrun = Number.isFinite(lock.ms) && Number.isFinite(Date.parse(hardStop)) && lock.ms >= Date.parse(hardStop);
  const cause = /^released\b/.test(String(lock.subject || ''))
    ? 'the previous run released its lock with unfinished cards'
    : overrun ? 'the run was still active at or beyond its hard stop; the termination cause was not recorded'
      : 'unreported session termination; no signal or exception was recorded';
  return `Stop cause: ${cause}.`
    + ` Previous run: ${lock.run || 'not recorded'}. Started: ${field('Started')}. Last recorded phase: ${phase}.`
    + ` Last lock stamp: ${Number.isFinite(lock.ms) ? new Date(lock.ms).toISOString() : 'not recorded'}.`
    + ` Configured hard stop: ${hardStop}.`;
}

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

// access_expires (BRO-6139): the access token's expiry, a time and not a secret, so the lane
// alarm can tell from outside whether a refresh was saved after the login expired.
function authCommentBody(blob, lastRefresh, nowIso, accessExpiresIso = '') {
  return [
    AUTH_MARKER,
    'Encrypted Codex login for the daily Codex runner (scripts/codex/auth-store.js). Do not edit or delete.',
    `last_refresh: ${lastRefresh || 'unknown'} · saved: ${nowIso}${accessExpiresIso ? ` · access_expires: ${accessExpiresIso}` : ''}`,
    '```',
    blob,
    '```',
  ].join('\n');
}

/** The access token's expiry of an auth.json text as ISO, '' when unreadable (never the token). */
function authAccessExpires(text) {
  try { const ms = jwtExpMs(JSON.parse(text).tokens.access_token); return Number.isFinite(ms) ? new Date(ms).toISOString() : ''; } catch { return ''; }
}

/**
 * The storage comment's public stamps only (never the blob): { lastRefreshMs, savedMs, accessExpiresMs }
 * (NaN when absent), or null if the body is not the storage comment.
 */
function parseAuthMeta(body) {
  if (typeof body !== 'string' || !body.startsWith(AUTH_MARKER)) return null;
  const at = (k) => Date.parse((body.match(new RegExp(`${k}: (\\S+)`)) || [])[1] || '');
  return { lastRefreshMs: at('last_refresh'), savedMs: at('saved'), accessExpiresMs: at('access_expires') };
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

/**
 * Newest weekly allowance reading in the Codex rollouts under <codexHome>/sessions, or null.
 * Shared by the daily runner and the Claude cross-check (scripts/codex/check-claude.js), so
 * neither has to require the other. The newest rollout can be one that has not logged a
 * rate-limit reading yet (just started, or aborted early), so it falls back through the next few.
 */
function weeklyPctFromSessions(codexHome) {
  const fs = require('fs');
  const path = require('path');
  const files = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.jsonl')) { try { files.push({ p, m: fs.statSync(p).mtimeMs }); } catch { /* vanished */ } }
    }
  };
  walk(path.join(codexHome, 'sessions'));
  files.sort((a, b) => b.m - a.m);
  for (const f of files.slice(0, 8)) {
    try { const pct = latestWeeklyPercent(fs.readFileSync(f.p, 'utf8')); if (pct != null) return pct; } catch { /* unreadable */ }
  }
  return null;
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

/** True when the reviewer's Claude login is an env key the sandbox user can be handed (BRO-5649). */
function reviewerSandboxAuth(env) {
  return Boolean(env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN);
}
// Where runner secrets live, for a reviewer that has to run as the runner (a cloud container's
// login is a root-only file). Its tools are Read/Grep/Glob, so these rules close its reach.
const REVIEWER_READ_DENY = ['/root/**', '/home/*/.claude/**', '/home/*/.ssh/**', '/home/*/.config/**', '/proc/**', '/etc/shadow', '/run/**', '/var/run/**', '**/.env', '**/.env.*', '**/.git/config', '**/.git/credentials']
  .map((p) => `Read(${p.startsWith('/') ? `/${p}` : p})`); // Read rules cover Grep and Glob too

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
 * Fill {{ID}} {{TITLE}} {{DATA}} {{EXTRA}} {{BODY}} {{WORKTREE}} {{BASE}} in a prompt template. One pass, so text
 * inside a card body or report that looks like a placeholder is never expanded.
 */
function fillPrompt(template, { id, title, body, extra = '', data = '', worktree = '', base = '' }) {
  const vals = { ID: id, TITLE: title || '', BODY: body || '', EXTRA: extra || '', DATA: data || '', WORKTREE: worktree || '', BASE: base || '(not available in this run: say which failures you could not compare)' };
  return template.replace(/\{\{(ID|TITLE|BODY|EXTRA|DATA|WORKTREE|BASE)\}\}/g, (_, k) => vals[k]);
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

/**
 * True for a runner note that says Codex itself failed the card. A "stopped mid-card" note is
 * the runner's own error (disk full, lost lock), not Codex's: on 2026-10-15 07:41 a full disk
 * crashed 17 cards in two minutes and the marker on those notes banned all 17 from Codex for
 * 14 days (BRO-5287). Those notes no longer carry the marker; older ones are ignored here.
 */
function isCodexBounce(body) {
  const b = String(body || '');
  return b.startsWith(BOUNCED_MARKER) && !b.startsWith(`${BOUNCED_MARKER}\n${CRASH_HEADING}`);
}
const CRASH_HEADING = '## Codex runner: stopped mid-card';
const isCrashNote = (body) => { const b = String(body || ''); return b.startsWith(CRASH_HEADING) || b.startsWith(`${BOUNCED_MARKER}\n${CRASH_HEADING}`); };

// A blocker phrase counts only in a sentence that says something is blocked, and not when negated
// ("no owner decision needed", "DECISION NEEDED: none"). BRO-6144 ship-check: bare keywords banned
// plain failures for 60 days ("works on the Mac", "tests pass without credentials").
const BOUNCE_BLOCKER_VERB_RE = /\b(?:blocked|cannot|can't|could not|couldn't|unable|unavailable|requires?|needs?|remain(?:s|ing)?|waits?|pending|only)\b/i;
const BOUNCE_NEG_BEFORE_RE = /\b(?:no|not|without|none|never|nor)\b[^.\n;]{0,30}$/i;
const BOUNCE_NEG_AFTER_RE = /^[^.\n]{0,12}\b(?:none|not (?:needed|required)|n\/a)\b/i;
const BOUNCE_CRED_RE = /\b(?:missing|unset|lacks?)\s+(?:the\s+)?(?:\w+\s+)?credentials?\b|\bcredentials?\s+(?:are\s+|is\s+)?(?:missing|unavailable|not (?:set|available))|\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_(?:ID|KEY|TOKEN|SECRET)\b[^.\n]{0,40}\b(?:unset|missing|not set)/;
const BOUNCE_MAC_RE = /\bowner'?s Mac\b|\bMac[- ](?:only|host)\b|\bprivate hook\b|\breal dispatch ledger\b/i;
const BOUNCE_OWNER_RE = /\bowner (?:decision|approval|call|judg(?:e)?ment)\b|\bneeds? (?:an? |the )?owner\b|\bACTION NEEDED FROM YOU\b|\bDECISION NEEDED\b|\bpending (?:an? |the )?owner\b/i;
const BOUNCE_FORBIDDEN_RE = /\bworkflow (?:edits?|files?|changes?) (?:were |are |is )?(?:forbidden|not allowed|off[- ]limits)|\b(?:edit(?:s|ing)?|chang(?:e|es|ing)|modif(?:y|ies|ying))\b[^.\n]{0,60}\bworkflows?\b[^.\n]{0,80}\b(?:forbid|prohibit|not allowed|off[- ]limits|expressly|which your instructions)|\.github\/workflows[^.\n]{0,60}\b(?:forbidden|not allowed|off[- ]limits)/i;
// The report's verdict says the change is already there; a bare "no files changed" also describes a
// run that found the work undoable, so it does not count (BRO-6144 backtest: 11 of 24 first matches were that).
const BOUNCE_ALREADY_RE = /\balready (?:fixed|implemented|on (?:`?origin\/)?main|met)\b/i;
// A report that still has failing tests is a plain failure whatever else it mentions.
const BOUNCE_FAILING_RE = /\b[1-9]\d* (?:tests?\s+)?(?:fail|failed|failing)\b|\btests? (?:still )?fail/i;

/** True when `re` matches in a sentence of `text` that is not negated at the match. */
function bounceSays(re, text, { needVerb = false } = {}) {
  for (const sentence of String(text).split(/(?<=[.!?])\s+|\n+/)) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of sentence.matchAll(g)) {
      if (BOUNCE_NEG_BEFORE_RE.test(sentence.slice(Math.max(0, m.index - 40), m.index))) continue;
      if (BOUNCE_NEG_AFTER_RE.test(sentence.slice(m.index + m[0].length, m.index + m[0].length + 30))) continue;
      if (needVerb && !BOUNCE_BLOCKER_VERB_RE.test(sentence)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Why a card Codex handed back could not be worked, from the runner's own signals: the
 * ENVIRONMENT-BLOCKED line, the pre-review block, the reviewer's REMAINING lines and the head of
 * Codex's report (its verdict line, before the checklist). -> one of 'forbidden-files',
 * 'missing-credential', 'mac-or-private', 'owner-decision', 'already-fixed', 'genuine-failure'.
 * Only a card with a real blocker is structural; everything unmatched stays 'genuine-failure'
 * and keeps the old time-based ban.
 */
function classifyBounce({ envBlocked = null, blocked = null, remaining = [], report = '' } = {}) {
  const text = [envBlocked, blocked, ...(Array.isArray(remaining) ? remaining : []), String(report || '').slice(0, 700)]
    .filter(Boolean).join('\n');
  // A pre-review block is Codex's own slip unless it touched workflows (a symlink or token material is not structural).
  if (/\.github\/workflows|trust ladder/.test(String(blocked || '')) || bounceSays(BOUNCE_FORBIDDEN_RE, text)) return 'forbidden-files';
  if (BOUNCE_FAILING_RE.test(text)) return 'genuine-failure';
  if (bounceSays(BOUNCE_CRED_RE, text, { needVerb: true })) return 'missing-credential';
  if (bounceSays(BOUNCE_MAC_RE, text)) return 'mac-or-private';
  if (bounceSays(BOUNCE_OWNER_RE, text)) return 'owner-decision';
  if (bounceSays(BOUNCE_ALREADY_RE, text)) return 'already-fixed';
  return 'genuine-failure';
}
/** The class line a bounce note carries, put on the line after the heading. */
const bounceClassLine = (cls) => `<!-- codex-bounce-class: ${cls} -->`;
/** -> the class a bounce note records, or null for a note written before BRO-6144. */
function bounceClassOf(body) {
  const m = BOUNCE_CLASS_RE.exec(String(body || ''));
  return m ? m[1] : null;
}

/** The comments after the newest retry note (all of them when there is none). */
function sinceRetry(comments) {
  const at = comments.reduce((m, c) => (String(c.body || '').startsWith(RETRY_MARKER) ? Math.max(m, Date.parse(c.createdAt)) : m), -Infinity);
  return comments.filter((c) => Date.parse(c.createdAt) > at);
}
/** The retry to run: the newest comment is a retry note (no Codex run has taken the card since). */
function parseCodexRetry(comments) {
  const list = (Array.isArray(comments) ? comments : (comments && comments.nodes) || [])
    .filter((c) => c && Number.isFinite(Date.parse(c.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return list[0] && String(list[0].body || '').startsWith(RETRY_MARKER) ? { findings: String(list[0].body).split('\n').slice(1).join('\n').trim() } : null;
}
/** The retry note: the reviewer's findings from the bounce note, for Codex to address this time. */
function retryBody({ findings = '', reason = '' } = {}) {
  return [
    RETRY_MARKER,
    '## Codex runner: one more Codex try',
    '',
    `${reason || 'Codex bounced this card and no Claude worker has taken it.'} The next Codex run takes it first. Address the findings from the earlier attempt below; if a finding is wrong, show the evidence in your report.`,
    '',
    findings ? String(findings).slice(0, 6000) : '(No findings were recorded; see the earlier Codex runner note.)',
  ].join('\n');
}

/**
 * True when Codex failed this card within the last 14 days (a 'landed part' note counts for only 3 days,
 * and two of them in 14 days ban it for the full 14), or the runner crashed on it twice
 * (a card that breaks the runner every time must not take a slot on every run).
 * A retry note (BRO-6260) forgets the plain and partial bounces before it; structural holds and crash
 * notes still count across it. A card's first plain bounce in 60 days that nobody answered for 7 days
 * stops counting (no Claude worker took it); a second one bans it for the usual 14 days.
 */
function codexBouncedRecently(comments, nowMs) {
  const raw = Array.isArray(comments) ? comments.filter((c) => c && Number.isFinite(Date.parse(c.createdAt))) : [];
  if (structuralBounceHolds(raw, nowMs)) return true;
  const all = sinceRetry(raw);
  const recent = all.filter((c) => nowMs - Date.parse(c.createdAt) < BOUNCE_MEMORY_MS);
  const isPartial = (c) => String(c.body || '').startsWith(`${BOUNCED_MARKER}\n${PARTIAL_HEADING}`);
  const partials = recent.filter(isPartial);
  const full = all.filter((c) => isCodexBounce(c.body) && !isPartial(c) && nowMs - Date.parse(c.createdAt) < STRUCTURAL_MEMORY_MS);
  const newest = full.reduce((m, c) => (!m || Date.parse(c.createdAt) > Date.parse(m.createdAt) ? c : m), null);
  const unclaimed = (c) => c === newest && full.length === 1 && nowMs - Date.parse(c.createdAt) >= UNCLAIMED_RETRY_MS
    && !all.some((o) => Date.parse(o.createdAt) > Date.parse(c.createdAt));
  // A full disk is the machine's fault, so it never counts toward the card's two crashes (BRO-5384).
  return recent.some((c) => isCodexBounce(c.body) && !isPartial(c) && !unclaimed(c))
    || partials.length >= PARTIAL_MAX_PER_MEMORY
    || partials.some((c) => nowMs - Date.parse(c.createdAt) < PARTIAL_MEMORY_MS)
    || raw.filter((c) => nowMs - Date.parse(c.createdAt) < BOUNCE_MEMORY_MS && isCrashNote(c.body) && !DISK_FULL_RE.test(String(c.body))).length >= 2;
}

/**
 * A person's word, not the Claude worker's own session report or an automatic note. Every comment on this
 * board posts under the owner's account, so the body decides, never the author.
 */
function isPersonComment(body) {
  const { isMachineComment } = require('./cloud-worker-pick.js');
  const { parseSessionReportStatus } = require('./linear-session-reporting.js');
  return !(isMachineComment(body) || parseSessionReportStatus(body) != null || /^\W*(?:Outcome\b|Auto-filed\b|Session report\b|Checkpoint\b|#+ *(?:Progress|Board worker)\b)/i.test(String(body || '')));
}

/**
 * True while a structural bounce (BRO-6144) still stands: a Codex bounce note with a structural class,
 * under STRUCTURAL_MEMORY_MS old, with no person's comment after it (the owner answered, a credential
 * arrived: the card is worth another try) and no CODEX-OK line anywhere on the card.
 */
function structuralBounceHolds(comments, nowMs) {
  const sorted = [...comments].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  let last = -1;
  sorted.forEach((c, i) => {
    if (isCodexBounce(c.body) && !String(c.body).startsWith(`${BOUNCED_MARKER}\n${PARTIAL_HEADING}`) && STRUCTURAL_BOUNCE_CLASSES.has(bounceClassOf(c.body))
      && nowMs - Date.parse(c.createdAt) < STRUCTURAL_MEMORY_MS) last = i;
  });
  if (last < 0) return false;
  const after = sorted.slice(last + 1);
  if (after.some((c) => CODEX_OK_RE.test(String(c.body || '')))) return false;
  return !after.some((c) => isPersonComment(c.body));
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
 * or under minScore is a skip ('too-broad').
 *
 * BRO-6303: what Codex may take comes from the trust ladder (codex-trust-ladder.js): minScore (-6,
 * or -9 once the larger-cards rung is earned), the cloud lane's data route and review-texts. A
 * caller scoring many cards reads codexLadderAccess() once and passes `ladder`. In shadow mode, or
 * with no ladder, access is the pre-ladder baseline, so the result is what it was before.
 */
const CODEX_MIN_SCORE = TL.BASELINE_MIN_SCORE; // the pre-ladder floor; the live one is ladder.minScore
const codexLadderAccess = (opts) => TL.ladderAccess(opts);
const CODEX_REVIEW_TEXTS_RE = /review-texts\b/i;
/**
 * Whether daily-runner.js provideData links the private review-texts clone into a worktree. An
 * explicit reviewTexts (false for the land-check batches) wins; the default is the ladder's
 * review-texts rung, and a locked rung tells Codex why it is missing.
 * -> { link, note: prompt text when not linked because of the ladder, else null }
 */
function reviewTextsPlan({ ladder, reviewTexts } = {}) {
  const locked = !!(ladder && ladder.reviewTextsLocked);
  const link = reviewTexts === undefined ? !locked : !!reviewTexts;
  return { link, note: !link && locked && reviewTexts === undefined ? 'locked for Codex by the trust ladder. If the card needs it, say so in a REMAINING line.' : null };
}
const CODEX_MAC_RE = /\b(?:launchd|launchctl|LaunchAgents?|cmux|Keychain|Mac[- ]only|on the Mac|Mac launcher|~\/Library)\b/i;
const CODEX_PENALTIES = [
  [/\.github\/workflows\/|\b(?:new|weekly|daily|nightly) (?:cron|workflow)\b|\bwire\b[^.\n]{0,60}\b(?:cron|workflow)\b/i, 4, 'workflow'],
  [/\bcredentials?\b|\bcredits\b|\bAPI key\b|\bsecrets?\b/i, 3, 'credentials'],
  [/\bbackfill\b|corpus[- ]wide|\bevery (?:show|review)\b|\blifetime sweep\b|\bre-?scrape\b/i, 3, 'bulk-data'],
  [new RegExp(`\\blive (?:site|page|pages|scrape|fetch)\\b|\\bprivate (?:data|repo)\\b|${CODEX_REVIEW_TEXTS_RE.source}|core-data\\b`, 'i'), 3, 'private-or-live-data'],
  [/\bPhase \d\b|\bmulti-part\b|\bfollow-?ups?\b/i, 2, 'multi-phase'],
];
// Work the runner cannot finish however small the card (BRO-5384: 12 of 24 cards rejected on
// 2026-10-13/15; BRO-3475 needed a workflow step, BRO-4299 land/ pushes, BRO-4427 and BRO-4855
// hundreds of shipped reviews, BRO-5223 a data repair). The runner never lands
// .github/workflows/**, cannot move land/ refs or write the private data repos, and a data fix
// needs an approved-fix plan run after landing. These go to the Claude lane.
const CODEX_HARD_SKIPS = [
  ['workflow-edit', /\b(?:edit|change|modify|patch|add|update|wire|move|bump)\b[^.\n]{0,80}\.github\/workflows\/|\.github\/workflows\/[\w.-]+\.ya?ml\b[^.\n]{0,40}\b(?:step|job|cron|schedule|inputs?|env)\b|\bworkflow(?:'s)?\s+(?:\w+\s+)?(?:step|job)s?\b|\b(?:edit|change|modify|patch)\b[^.\n]{0,30}\b[\w-]+\.ya?ml\b|\bworkflow_dispatch\b[^.\n]{0,20}\binputs?\b/i],
  ['land-ref', /\bland\/\*|\b(?:stranded|refused|evicted)\s+land(?:ing)?s?\b|\bland(?:ing)?\s+refs?\b|\brebas\w*\b[^.\n]{0,40}\bland\b/i],
  ['private-repo-write', /\bbroadway-(?:review-texts|scorecard-data)\b|\bpending-fixes\b|\bexecute-approved-fix\b|\bapproved-fix\s+plan\b|\bdata repair\b/i, 'data-route'],
  // BRO-6129: 6 of the 69 "not landed" bounces were "nothing needed landing, items still open": work that waits on a date,
  // a scheduled run or the owner. One Codex attempt cannot finish it, so it never starts.
  ['waits-on-later-event', /^\s*RECHECK-AFTER:?\s*\d{4}-\d\d-\d\d|\bconfirm the next scheduled [\w.-]+ run\b|\bowner (?:presses|(?:must|needs to) (?:decide|approve|press|answer|settle)|settles (?:the|this|which))\b/im],
  ['corpus-wide-data', /\bcorpus[- ]wide\b|\bbulk[- ](?:edit|fix|update|rewrite|repair|rescore)\b|(?<![\d,])(?!(?:19|20)\d\d\b)\d[\d,]{2,}\s+(?:shipped\s+|existing\s+|affected\s+|scored\s+)?(?:reviews|shows|files|rows|records)\b/i],
];
// Card shapes the independent Claude check rejected most (BRO-6086: 98 "not landed, left for the Claude
// worker" cards in 14 days, ~$0.27 per check). Matched on the TITLE only, so a description that merely
// mentions one of these words stays eligible. Each is a card whose fix is private-data, research or
// board work, or a sweep over many call sites, which one Codex attempt leaves half done.
const CODEX_TITLE_SKIPS = [
  // Auto-filed health/incident cards (12 of 98): the fix is a private-data repair or a Linear change.
  ['auto-filed-alert', /^\W*(?:P\d:\s*)?BSC (?:Daily|Rebuild):/i, 'data-route'],
  // One show's data: research a venue/date/author or recover a review (needs web research + private data).
  ['show-data-research', /^(?:P\d:\s*)?(?:Verify|Recover|Backfill|Find sources?)\b[^\n]{0,60}(?:\b\d[\d,]*\s+(?:\w+\s+){0,3}(?:shows?|reviews?|flags?|pairs?|deals?)\b|\btrue author\b|\bprovenance\b|\bverdict\b)|^[a-z0-9]+(?:-[a-z0-9]+)+-(?:19|20)\d\d\b[^:\n]{0,40}:|\(\d{4} id\)/i],
  // A sweep over a counted or "remaining" set of call sites: Codex migrates some and stops.
  ['multi-site-sweep', /^(?:P\d:\s*)?(?:Migrate|Wire|Version|Extend|Generalize|Consolidate|Audit)\b[^\n]{0,50}\b(?:remaining \d+|remaining (?:\w+ ){0,2}(?:generators|callers|paths|ledgers|sites|scripts)|the \d+)\b|\brepo-wide\b|\bAudit\b[^\n]{0,40}\bcall sites\b|\bsame\b[^\n]{0,60}\b(?:in|at|across) \d+\b/i],
];
// The route's own vocabulary (.claude/CLOUD.md "Fixing private data from cloud") and a direct private-repo edit.
const CODEX_DATA_ROUTE_RE = /\b(?:pending-fixes|new-fix-plan|execute-approved-fix|approved-fix\s+plan|data-edit|review-field-edit)\b/i;
const CODEX_DIRECT_PRIVATE_RE = /\bbroadway-(?:review-texts|scorecard-data)\b/i;
// A `CODEX-OK` line (description or a comment) sends a card to Codex despite the hard skips.
const CODEX_OK_RE = /^[\s>*_#-]*CODEX-OK\b/m;
function codexCardFit({
  title = '', description = '', verify = '', comments = [], nowMs = Date.now(), canDispatch = canDispatchWorkflows(),
  ladder = codexLadderAccess(), minScore = ladder.minScore,
  // The GHA lane stays outside the ladder for the data route: it can always dispatch the apply (BRO-6260).
  dataRouteLocked = process.env.GITHUB_ACTIONS !== 'true' && !!ladder.cloudDataRouteLocked,
  reviewTextsLocked = !!ladder.reviewTextsLocked,
} = {}) {
  const text = `${title}\n${description}`;
  if (CODEX_MAC_RE.test(text)) return { skip: 'mac-only', score: -Infinity, why: ['mac-only'] };
  // The runner refuses to land a change to a protected file (TL.isProtectedPath), so a card naming one never starts.
  const prot = TL.PROTECTED_CARD_RE.exec(text);
  if (prot) return { skip: 'protected-path', score: -Infinity, why: [`protected-path: ${prot[0]}`] };
  // A locked rung is a capability, like data-route-gha-only below: CODEX-OK does not lift it.
  if (reviewTextsLocked && CODEX_REVIEW_TEXTS_RE.test(text)) return { skip: 'review-texts-locked', score: -Infinity, why: ['review-texts-locked: the trust ladder has review-texts locked for Codex'] };
  const ok = CODEX_OK_RE.test(String(description)) || (Array.isArray(comments) ? comments : []).some((c) => c && CODEX_OK_RE.test(String(c.body || '')));
  // BRO-6175: a card that names the reviewed pending-fixes route can be done by the Codex lane, which writes
  // the plan and the runner applies it after the landing (codex-data-fixes.js). 'data-route' skips then fire
  // only for a direct private-repo edit with no plan route named; CODEX_DATA_FIXES_DISABLED restores them all.
  const viaRoute = dataFixesEnabled() && CODEX_DATA_ROUTE_RE.test(text);
  // BRO-6194: the route's apply step is a workflow dispatch, which only the GHA lane is known to be able to make.
  // A runner that cannot dispatch never picks a route card (CODEX-OK does not lift this: it is a capability, not a judgment).
  if (viaRoute && !canDispatch) return { skip: 'data-route-gha-only', score: -Infinity, why: ['data-route-gha-only: the data-fix route needs a runner that can dispatch workflows'] };
  if (viaRoute && dataRouteLocked) return { skip: 'data-route-locked', score: -Infinity, why: ['data-route-locked: the trust ladder has the cloud data route locked'] };
  for (const [name, re, flag] of ok ? [] : CODEX_HARD_SKIPS) {
    if (flag === 'data-route' && dataFixesEnabled()) {
      const direct = CODEX_DIRECT_PRIVATE_RE.exec(text);
      if (!direct || viaRoute) continue;
      return { skip: name, score: -Infinity, why: [`${name}: ${direct[0].slice(0, 60)}`] };
    }
    const m = re.exec(text);
    if (m) return { skip: name, score: -Infinity, why: [`${name}: ${m[0].slice(0, 60)}`] };
  }
  if (!ok) {
    for (const [name, re, flag] of CODEX_TITLE_SKIPS) {
      if (flag === 'data-route' && viaRoute) continue;
      const m = re.exec(String(title));
      if (m) return { skip: name, score: -Infinity, why: [`${name}: ${m[0].slice(0, 60)}`] };
    }
  }
  let score = 0;
  const why = [];
  if (/^node --test (?:--\S+ )*\S+\.test\.m?js$/.test(String(verify || '').trim())) { score += 3; why.push('single-test-verify'); }
  for (const [re, cost, name] of CODEX_PENALTIES) if (re.test(text)) { score -= cost; why.push(name); }
  const extraK = Math.floor(Math.max(0, String(description).length - 1500) / 1000);
  if (extraK) { score -= extraK; why.push(`long+${extraK}k`); }
  const accept = String(description).split(/^##+ *Acceptance[^\n]*$/im)[1] || '';
  const items = (accept.split(/^##+ /m)[0].match(/^\s*(?:[-*]|\d+\.)\s+/gm) || []).length;
  if (items > 3) { score -= 2; why.push(`acceptance-items:${items}`); }
  // A fix round an earlier run could not fit goes first, so a SHIP-WITH-FIXES always gets it.
  if (parseSwfCarry(comments, nowMs)) { score += 10; why.push('swf-carry'); }
  // A retry is a fresh attempt, so it never lifts a too-broad card over the line.
  else if (score > minScore && parseCodexRetry(comments)) { score += 10; why.push('retry'); }
  return { skip: score <= minScore ? 'too-broad' : null, score, why };
}

/**
 * Slot k's worktree, base worktree and run lock (BRO-5384: several runners in parallel, each
 * with its own lock, so overlapping firings never run two runners on one slot). Slot 0 keeps
 * the single-runner names, so --lock-status and check-claude.js read the same lock as before.
 */
function slotNames(slot = 0) {
  const k = Number(slot) || 0;
  return k === 0
    ? { wt: 'codex-runner', base: 'codex-runner-base', lockRef: 'refs/heads/codex-runner-lock' }
    : { wt: `codex-runner-${k}`, base: `codex-runner-base-${k}`, lockRef: `refs/heads/codex-runner-lock-${k}` };
}

/** `exp` of a JWT in ms, NaN when unreadable. Reads the claims only; never logs the token. */
function jwtExpMs(token) {
  try {
    const claims = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return Number(claims.exp) * 1000 || NaN;
  } catch { return NaN; }
}

/**
 * How many slots may run Codex at once with this login. Every Codex process shares one
 * ~/.codex/auth.json, and its refresh token rotates: two processes refreshing at once would
 * spend the same token. Codex refreshes when the access token expires (the stored login went
 * 10 days, 2026-10-05 to 10-15, without a refresh), so a run during which it could expire uses
 * one slot, and so does an unreadable login. -> { slots, why }
 */
function slotsForLogin({ slots, authText, nowMs, runMs, marginMs = 30 * 60_000 }) {
  if (!(slots > 1)) return { slots: 1, why: null };
  const why = loginExpiryWhy({ authText, nowMs, runMs, marginMs });
  return why ? { slots: 1, why } : { slots, why: null };
}

/** Why the Codex login could be refreshed during a run of runMs (null: it outlives the run plus margin). */
function loginExpiryWhy({ authText, nowMs, runMs, marginMs = 30 * 60_000 }) {
  let exp = NaN;
  try { exp = jwtExpMs(JSON.parse(authText).tokens.access_token); } catch { /* unreadable */ }
  if (!Number.isFinite(exp)) return 'the Codex login expiry is unreadable';
  if (exp - nowMs < runMs + marginMs) return `the Codex login expires ${new Date(exp).toISOString()}, within this run, so one Codex process refreshes it`;
  return null;
}

/**
 * Slots are gated on the access token's expiry only (loginExpiryWhy). BRO-6086 also gated on the
 * login's AGE (cloud lane one slot from 6 days, gha lane idle from ~7), assuming the Codex CLI
 * refreshes itself at 8 days. It does not: the stored login stayed at last_refresh 2026-10-15
 * through 2026-10-24 (8.6 days, every `codex exec` ran and saved), and the only refresh seen came
 * at token expiry (2026-10-05 -> 10-15). The age gate therefore never cleared: the cloud lane ran
 * one slot and the gha lane none, from 2026-10-24 01:00Z on (BRO-6129: 4 cards in 12 h vs ~45 a day).
 * The CLI refreshes when the access token expires, which loginExpiryWhy already guards: inside
 * run + margin of expiry the cloud lane runs one slot and the gha lane falls back to slot 0.
 * Assumption: the CLI does not refresh earlier than margin (30 min) before expiry.
 */

// Codex lanes (BRO-5730): LANES lives in codex-runner-grading.js, since which lane posted a summary is graded.
// MAX_SLOTS covers every lane: --lock-status reads all of their locks.
const MAX_SLOTS = Math.max(...Object.values(LANES).map((l) => l.base + l.max));
/** The slot numbers of a lane, or of every lane for 'all'; null for an unknown lane. */
function laneSlotList(lane) {
  if (lane === 'all') return [...Array(MAX_SLOTS).keys()];
  const l = LANES[lane];
  return l ? [...Array(l.max).keys()].map((k) => l.base + k) : null;
}

/**
 * Where a launch runs: { lane, base, slots, why }. Lanes run at once in separate containers,
 * each with its own copy of the rotating login, so a lane past the first runs only when the
 * login outlives its whole run (no refresh anywhere). If the token could expire it falls back to
 * the cloud lane's slot 0 with one slot (the cloud lane is down to that slot too), so the two
 * never run Codex side by side on a login that may refresh.
 */
function laneForLogin({ lane = 'cloud', slots, authText, nowMs, runMs, marginMs = 30 * 60_000 }) {
  const l = LANES[lane] || LANES.cloud;
  const want = Math.max(1, Math.min(Number(slots) || 1, l.max));
  if (l.base > 0) {
    // Expiry: the cloud lane also drops to slot 0 alone (slotsForLogin), so sharing slot 0 serializes them.
    const expiry = loginExpiryWhy({ authText, nowMs, runMs, marginMs });
    if (expiry) return { lane: 'cloud', base: 0, slots: 1, why: `${expiry}; ${lane} lane falls back to slot 0` };
    return { lane, base: l.base, slots: want, why: null };
  }
  const plan = slotsForLogin({ slots: want, authText, nowMs, runMs, marginMs });
  return { lane, base: l.base, ...plan };
}

/**
 * Card ids named by other slots' lock commit subjects. A stamp older than staleMs is skipped: a
 * dead run's lock is only adopted when its own slot runs again, and must not block the card for
 * every other lane until then. A stamp with an unreadable time still counts.
 */
function cardsInLocks(subjects, { nowMs = Date.now(), staleMs = Infinity } = {}) {
  return new Set((subjects || []).flatMap((s) => {
    const ms = Date.parse((String(s).match(/^(?:locked|released) (\S+)/) || [])[1]);
    return Number.isFinite(ms) && nowMs - ms > staleMs ? [] : lockCards(s);
  }));
}

/**
 * A SHIP-WITH-FIXES fix round that did not fit this run (BRO-5384: BRO-5223 got the verdict with
 * no time left and was bounced). The card goes back to Todo without the bounce marker, carrying
 * Codex's change (gzip+base64) and the findings; the next runner re-applies it and runs the fix
 * round first (codexCardFit bonus, and the picker's recent-activity wait does not apply).
 */
const SWF_CARRY_MARKER = '<!-- codex-runner-swf-carry -->';
const SWF_CARRY_MAX_MS = 3 * 24 * 3600_000;
const SWF_PATCH_MAX_CHARS = 60_000;
function swfCarryBody({ attempt, patch, summary }) {
  const zlib = require('zlib');
  const blob = patch ? zlib.gzipSync(Buffer.from(String(patch))).toString('base64') : '';
  const carried = blob && blob.length <= SWF_PATCH_MAX_CHARS;
  return [
    SWF_CARRY_MARKER,
    '## Codex runner: SHIP-WITH-FIXES, fix round carried to the next run',
    '',
    `The independent check found the approach right but asked for fixes, and this run had no time left for the fix round. ${carried ? 'The next Codex run re-applies the change below and runs that fix round first.' : 'The change was too large to carry, so the next Codex run redoes it with these findings.'} Nothing was landed.`,
    '',
    `attempt: ${Number(attempt) || 1}`,
    '',
    summary || '',
    ...(carried ? ['', 'Carried change (gzip, base64):', '```', blob.match(/.{1,100}/g).join('\n'), '```'] : []),
  ].join('\n');
}
/**
 * The carry to resume: the newest comment is a carry note under 3 days old.
 * -> { attempt, patch|null, findings } | null. findings is the reviewer's text in full: the card
 * body clips each comment, so the resumed round is handed it directly.
 */
function parseSwfCarry(comments, nowMs) {
  const list = (Array.isArray(comments) ? comments : (comments && comments.nodes) || [])
    .filter((c) => c && Number.isFinite(Date.parse(c.createdAt)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const c = list[0];
  if (!c || !String(c.body || '').startsWith(SWF_CARRY_MARKER) || nowMs - Date.parse(c.createdAt) > SWF_CARRY_MAX_MS) return null;
  const body = String(c.body);
  const attempt = Number((body.match(/^attempt: (\d+)$/m) || [])[1]) || 1;
  const m = body.match(/Carried change \(gzip, base64\):\n```\n([A-Za-z0-9+/=\n]+?)\n```/);
  let patch = null;
  if (m) { try { patch = require('zlib').gunzipSync(Buffer.from(m[1].replace(/\n/g, ''), 'base64')).toString('utf8'); } catch { patch = null; } }
  const after = body.split(/^attempt: \d+$/m)[1] || '';
  const findings = after.split('\nCarried change (gzip, base64):')[0].trim();
  return { attempt, patch, findings };
}

/**
 * Codex's change on a worktree branch as a patch git apply takes back: the raw diff against the
 * card's base, never trimmed (a patch without its final newline is "corrupt", and a binary hunk
 * then applies only in part). '' when git fails.
 */
function carryPatch(cwd, base) {
  const r = require('child_process').spawnSync('git', ['diff', '--binary', `${base}...HEAD`], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : '';
}

/**
 * Whether one more Codex exec fits before `deadlineMs`: a 15-min exec plus the review must fit
 * the round's deadline, and the exec, land checks and review must fit before the hard stop's
 * wrap-up time (daily-runner.js; BRO-5287 sizes, BRO-5384 per-round deadline).
 */
const FIX_EXEC_MIN_MS = 15 * 60_000;
const REVIEW_RESERVE_MS = 30 * 60_000;
const LAND_CHECKS_MS = 15 * 60_000;
function fixRoundFits({ deadlineMs, nowMs, hardEndMs, wrapUpMs, landChecksMs = LAND_CHECKS_MS }) {
  return deadlineMs - nowMs >= FIX_EXEC_MIN_MS + REVIEW_RESERVE_MS
    && hardEndMs - wrapUpMs - nowMs >= FIX_EXEC_MIN_MS + landChecksMs + REVIEW_RESERVE_MS;
}
/**
 * Codex exec time that still leaves the land checks and the review before `untilMs` (the hard
 * stop's wrap-up), in [FIX_EXEC_MIN_MS, capMs]. 17 of 18 out-of-time cards on 2026-10-17/18 ran
 * out right before the review: a fix exec sized to the card budget alone ate that time (BRO-5384).
 * `landChecksMs` is the last measured land-check run, mutex wait included (3 slots share it).
 */
function execBudgetMs({ untilMs, nowMs, capMs, landChecksMs = LAND_CHECKS_MS }) {
  return Math.min(capMs, Math.max(FIX_EXEC_MIN_MS, untilMs - nowMs - landChecksMs - REVIEW_RESERVE_MS));
}
/** Time a card needs before the wrap-up so its review fits: verify (its 10-min timeout), a minimum exec, the land checks, the review. */
const CARD_VERIFY_MS = 10 * 60_000;
function cardStartMs(landChecksMs = LAND_CHECKS_MS, { laterCard = false, discountMs = LATER_CARD_DISCOUNT_MS } = {}) {
  const full = CARD_VERIFY_MS + FIX_EXEC_MIN_MS + landChecksMs + REVIEW_RESERVE_MS;
  if (!laterCard || !(discountMs > 0)) return full;
  // Never below the unmeasured minimum (verify, minimum exec, default land checks, review): under
  // it the review cannot fit and the card is handed back unjudged (BRO-5384).
  const floor = CARD_VERIFY_MS + FIX_EXEC_MIN_MS + LAND_CHECKS_MS + REVIEW_RESERVE_MS;
  return Math.max(floor, full - discountMs);
}
// The measured land checks (mutex wait included, clamped to 30 min) put the full gate at 85 min,
// so a cloud slot that finished one card never had room for a second although 11 of 45 cards in
// 2 days took under 40 min (BRO-6304). After a first card the gate drops by this much, floored above.
const LATER_CARD_DISCOUNT_MS = Number(process.env.CODEX_LATER_CARD_DISCOUNT_MS ?? 20 * 60_000);

/**
 * When the next fix round must finish (BRO-5384). A REJECT's round keeps to the card budget;
 * the first SHIP-WITH-FIXES round may use the rest of the run: --card-max-minutes 60 never left
 * a 15-min exec plus the review after a first attempt, so no card ever got a fix round.
 */
/**
 * argv for slot k of a --slots launch (BRO-5384): the launcher's flags minus its own and the
 * per-launch budgets, plus the slot's share of them and the shared run dir and start time.
 */
function slotArgs(argv, { slot, runDir, runStartedMs, limit, checkBudgetUsd, pickList }) {
  const own = new Set(['--slots', '--slot', '--run-dir', '--run-started', '--limit', '--check-budget-usd', '--pick-list']);
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (own.has(argv[i])) { if (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) i++; continue; }
    out.push(argv[i]);
  }
  // No run dir (a launch that fell back to one slot): a lone runner, with a lone runner's limits.
  return [...out, '--slot', String(slot), ...(runDir ? ['--run-dir', String(runDir)] : []), '--run-started', String(runStartedMs),
    '--limit', String(limit), '--check-budget-usd', String(checkBudgetUsd), ...(pickList ? ['--pick-list', String(pickList)] : [])];
}

/**
 * The run dir the slots of one --slots launch share (BRO-5384). '' (a lone runner): every
 * operation is a no-op that lets the runner go on.
 *  - stopped(): why another slot stopped the launch (its STOP file), or null
 *  - stopAll(why): stop every slot (a Codex exec failure means the login or quota is gone for
 *    all of them; a Done refusal means the gate disagrees with the check)
 *  - takeCard(id): true for exactly one slot (exclusive create), so no card is claimed twice
 *  - withMutex(name, fn, onWait): fn under a file mutex. Land checks run one slot at a time:
 *    three node unit batches at once on a 4-core container time tests out, and a branch-side
 *    timeout that passes on the base reads as a new failure. A dead holder frees it.
 */
function launchRunDir(runDir, slot = 0, { pollMs = 15_000 } = {}) {
  const fs = require('fs');
  const path = require('path');
  if (!runDir) return { stopped: () => null, stopAll: () => {}, takeCard: () => true, withMutex: (name, fn) => fn() };
  const at = (f) => path.join(runDir, f);
  return {
    stopped() { try { return fs.readFileSync(at('STOP'), 'utf8').trim() || 'another slot stopped'; } catch { return null; } },
    stopAll(why) { try { fs.writeFileSync(at('STOP'), `slot ${slot}: ${why}`, { flag: 'wx' }); } catch { /* already stopped */ } },
    takeCard(id) { try { fs.closeSync(fs.openSync(at(`taken-${id}`), 'wx')); return true; } catch { return false; } },
    withMutex(name, fn, onWait = () => {}) { return withFileMutex(at(`${name}.lock`), fn, { onWait, pollMs }); },
  };
}

/**
 * fn under an exclusive pid-file mutex at `lockPath`. A dead holder (gone pid, or an empty file a
 * minute old) frees it; onWait() runs between polls.
 */
function withFileMutex(lockPath, fn, { onWait = () => {}, pollMs = 15_000 } = {}) {
  const fs = require('fs');
  const p = lockPath;
  for (;;) {
    try { fs.writeFileSync(p, String(process.pid), { flag: 'wx' }); break; } catch { /* held */ }
    let pid = 0;
    let ageMs = 0;
    try { pid = Number(fs.readFileSync(p, 'utf8')); ageMs = Date.now() - fs.statSync(p).mtimeMs; } catch { continue; } // freed meanwhile
    // An empty file is a holder still writing its pid, unless it is a minute old (it died between the two).
    let alive = pid > 0 || ageMs < 60_000;
    if (pid > 0) { try { process.kill(pid, 0); } catch (e) { alive = !(e && e.code === 'ESRCH'); } }
    if (!alive) { fs.rmSync(p, { force: true }); continue; }
    onWait();
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, pollMs);
  }
  try { return fn(); } finally { fs.rmSync(p, { force: true }); }
}
// One land-check run at a time per container, across Codex launches and land-local-check.js
// (BRO-5730): two gauntlets at once on a 4-core container time tests out on both.
const CONTAINER_LAND_MUTEX = require('path').join(require('os').tmpdir(), 'bsc-land-checks.lock');

/**
 * Which model runs the Claude check (BRO-5384: Opus at ~$0.49 a review on every diff). Sonnet for
 * a small change outside the risky areas, Opus for the rest; same prompt, same SHIP rules.
 * files: [{ path, changed }] from `git diff --numstat`; classify: infra-review-scope.js
 * classifyChange (its critical tier is never small). -> { model, why }
 */
const CHECK_SMALL_LINES = 80;
const CHECK_SMALL_FILES = 3;
const CHECK_RISKY_RE = /^(?:src\/lib\/(?:scoring|engine|data-core)|src\/app\/api\/|scripts\/lib\/(?:rebuild-helpers|score-extractors|review-normalization|review-guards|published-star-capture|content-verifier)|scripts\/llm-scoring\/|scripts\/rebuild-all-reviews|data\/|\.github\/|supabase\/|\.claude\/|scripts\/codex\/|scripts\/(?:lib\/)?(?:cloud-worker-pick|codex-runner|land-|linear-(?:session|brain|client)))/;
// The last group: the worker machinery itself (this runner, its picker, landing, the board), which
// infra-review-scope.js does not rate critical.
function checkModel({ files = [], classify = () => ({ inScope: false }) } = {}) {
  const changed = files.reduce((n, f) => n + (Number(f.changed) || 0), 0);
  const risky = files.filter((f) => CHECK_RISKY_RE.test(f.path)).map((f) => f.path);
  if (!files.length) return { model: 'opus', why: 'no diff' };
  // A rename prints "a => b" or "dir/{a => b}": the real paths are not checkable, so Opus.
  if (files.some((f) => /=>|[{}]/.test(f.path))) return { model: 'opus', why: 'a rename' };
  if (risky.length) return { model: 'opus', why: `risky path ${risky[0]}` };
  const infra = classify(files.map((f) => f.path));
  // Critical shared infrastructure (dispatch, gates, locks; CLAUDE.md 18) is never small. Plain
  // scripts/lib modules are 'shared' tier there, which alone would leave Sonnet nothing.
  if (infra && infra.tier === 'critical') return { model: 'opus', why: 'critical shared infrastructure' };
  if (files.length > CHECK_SMALL_FILES || changed > CHECK_SMALL_LINES) return { model: 'opus', why: `${files.length} file(s), ${changed} line(s)` };
  return { model: 'sonnet', why: `small: ${files.length} file(s), ${changed} line(s)` };
}

/**
 * The skip the trust ladder adds over the pre-ladder baseline right now (BRO-6303), or null: the
 * runner re-asks it before claiming, so a relock after the pick, or an --ids card, is held to the
 * ladder too. Skips the baseline already makes are the picker's business, not this check's.
 */
function ladderSkip(card, { ladder = codexLadderAccess(), ...opts } = {}) {
  const now = codexCardFit({ ...card, ...opts, ladder });
  if (!now.skip) return null;
  const base = codexCardFit({ ...card, ...opts, ladder, minScore: TL.BASELINE_MIN_SCORE, dataRouteLocked: false, reviewTextsLocked: false });
  return base.skip ? null : now.skip;
}

/**
 * Codex first (BRO-5384, owner 2026-10-15: Codex carries the load, Claude is the fallback): while a
 * Codex runner is live, the Claude worker leaves a card to Codex when Codex would take it: fit
 * (codexCardFit), not bounced by Codex, not Urgent and not START-NOW (those go to whoever is free).
 */
function leaveToCodex(issue, { nowMs, verify = '', startNow = false, ladder = codexLadderAccess() } = {}) {
  if (!issue || Number(issue.priority) === 1 || startNow) return false;
  const comments = (issue.comments && issue.comments.nodes) || [];
  if (codexBouncedRecently(comments, nowMs)) return false;
  // Every Codex lane can apply a data-fix plan now (GHA has actions: write; the cloud lane runs with
  // CODEX_CAN_DISPATCH=1, BRO-6260), so data-route cards are left to Codex like any other fit card (BRO-6194 kept them).
  // A locked cloud data route still leaves route cards here: the GHA lane, outside the ladder, takes them
  // within hours (codex-runner.yml fires several times a day), so dataRouteLocked: false.
  return !codexCardFit({ title: issue.title, description: issue.description, verify, comments, nowMs, canDispatch: true, ladder, dataRouteLocked: false }).skip;
}

/**
 * Cards landed per lane from `git log --format=${LANDED_LOG_FORMAT}` lines: distinct BRO ids in
 * commit subjects by "Codex runner" vs by Claude (every Claude session, not just the board's
 * Claude lane; bots and the owner's hand commits are left out). Mac sessions commit under the
 * owner's name, so an owner commit with a Co-Authored-By trailer at noreply@anthropic.com also
 * counts as Claude (BRO-5767: +83 cards over a week). A Codex cloud PR landing (subject names
 * "Codex PR #N", no BRO id) counts once as PR #N in the Codex lane (BRO-5646). -> { codex, claude }
 */
const OWNER_GIT_AUTHOR = 'Tom Pryor';
// Fields: author, co-authors (one line, comma-joined), subject last so a tab in it stays whole.
const LANDED_LOG_FORMAT = '%an%x09%(trailers:key=Co-Authored-By,valueonly,separator=%x2C)%x09%s';
function landedPerLane(logText) {
  const ids = { codex: new Set(), claude: new Set() };
  for (const line of String(logText || '').split('\n')) {
    const [author, coAuthors = '', ...rest] = line.split('\t');
    const subject = rest.join('\t');
    const byClaude = author === 'Claude' || (author === OWNER_GIT_AUTHOR && /<noreply@anthropic\.com>/i.test(coAuthors));
    const lane = author === 'Codex runner' ? 'codex' : byClaude ? 'claude' : null;
    if (!lane) continue;
    const found = subject.match(/\bBRO-\d+\b/g) || (lane === 'codex' && subject.match(/\bCodex PR #\d+\b/g)) || [];
    for (const id of found) ids[lane].add(id);
  }
  return { codex: ids.codex.size, claude: ids.claude.size };
}

// Codex cloud PRs (BRO-5646). Codex cloud's "Create PR" pushes a codex/<task-slug> branch.
// Claude sessions also push codex/bro-N and codex/BRO-N-fix batch branches (unreviewed Codex
// attempts) and the card runner names its local branch codex/bro-N, so those never count.
const CODEX_PR_AUTHORS = ['thomaspryor'];
/**
 * Is this pull_request_target payload's PR a Codex cloud PR the lander should land?
 * -> { ok: true } or { ok: false, why }
 */
function codexCloudPr(pr, repoFullName) {
  if (!pr || typeof pr !== 'object') return { ok: false, why: 'no pull request' };
  const head = String((pr.head && pr.head.ref) || '');
  if (!/^codex\//i.test(head)) return { ok: false, why: `head ${head} is not a codex/ branch` };
  if (/^codex\/bro-\d+(-fix)?$/i.test(head)) return { ok: false, why: `head ${head} is a card-runner or batch branch, not Codex cloud` };
  if (!pr.head.repo || pr.head.repo.full_name !== repoFullName) return { ok: false, why: 'head is on a fork' };
  if (!pr.base || pr.base.ref !== 'main') return { ok: false, why: `base is ${pr.base && pr.base.ref}, not main` };
  const user = pr.user || {};
  const login = String(user.login || '');
  // The owner's account (Codex cloud opens PRs as the connected GitHub user), or the Codex app's bot.
  const bot = user.type === 'Bot' && /codex|chatgpt|openai/i.test(login);
  if (!CODEX_PR_AUTHORS.includes(login) && !bot) return { ok: false, unknownAuthor: true, why: `author ${login} is not the owner or the Codex app` };
  if (pr.state && pr.state !== 'open') return { ok: false, why: `pull request is ${pr.state}` };
  return { ok: true };
}

const PR_LANDER_MARKER = '<!-- codex-pr-lander -->';
const PR_LANDER_ERROR_TEXT = 'The automatic check hit an error of its own';
// The first comment a run posts, edited into the verdict when the run ends (one comment per head).
const PR_LANDER_STARTED_TEXT = 'Claude is checking this now';
// A --no-land run's pass: not a verdict either, so a real run still lands it.
const PR_LANDER_NOT_LANDED_TEXT = 'this run was set not to land anything';
const PR_LANDER_HEADS = {
  started: ({ minutes }) => `${PR_LANDER_STARTED_TEXT}. ${minutes ? `It usually takes about ${minutes} minutes` : 'It usually takes 30 to 60 minutes'} to a result, and the result will replace this message.`,
  landed: ({ mainSha, site = true }) => {
    const commit = mainSha ? ` (commit ${String(mainSha).slice(0, 7)})` : '';
    return site
      ? `Landed: this change is on main${commit} and goes live on broadwayscorecard.com with the next deploy, usually within 30 minutes. Nothing else is needed.`
      : `Landed: this change is on main${commit}. It does not change the website, so it is in effect now. Nothing else is needed.`;
  },
  rejected: () => 'Not live: the independent Claude check found problems with this change (details below). Ask Codex to fix them in the same task and press "Update PR"; the check runs again on its own.',
  conflict: () => 'Not live: this change clashes with newer work already on main. Ask Codex to update the task from the latest main and press "Update PR"; the check runs again on its own.',
  blocked: () => 'Not live: this change touches something the automatic lane never lands on its own (details below), so it stays open, unlanded.',
  refused: () => 'Not live: it passed the Claude check, but the final landing checks refused it (details below). Ask Codex to fix what they name and press "Update PR"; the check runs again on its own.',
  error: () => `Not live: ${PR_LANDER_ERROR_TEXT}, so this change was not judged (details below). Pressing "Update PR" with a change, or closing and reopening this pull request, tries again.`,
  notLanded: () => `Not live: it passed the Claude check, but ${PR_LANDER_NOT_LANDED_TEXT} (a test run), so it stays open. Closing and reopening this pull request checks and lands it for real.`,
  superseded: () => 'Not judged: a newer push replaced this version while it waited. The newer version gets its own comment.',
  unknownAuthor: () => 'Not checked: this looks like a Codex pull request, but it was opened by an account the automatic lane does not know (details below), so it was left alone.',
};
/**
 * The plain-English PR comment for one lander outcome (a PR_LANDER_HEADS key). details: the
 * reviewer's or gate's text, folded under the plain lines. minutes: started only; site: landed only.
 */
function prLanderComment({ outcome, sha, mainSha, minutes, site, remaining = [], details = '' }) {
  const short = String(sha || '').slice(0, 7);
  const head = (PR_LANDER_HEADS[outcome] || (() => `Outcome: ${outcome}`))({ mainSha, minutes, site });
  const left = remaining.length ? `\n\nThe check also listed things this change does not do yet:\n${remaining.map((x) => `- ${x}`).join('\n')}` : '';
  const fenced = String(details).replace(/```/g, "'''").slice(-6000);
  const more = details ? `\n\n<details><summary>Details</summary>\n\n\`\`\`\n${fenced}\n\`\`\`\n</details>` : '';
  return `${PR_LANDER_MARKER}\n**Codex lander${short ? ` (${short})` : ''}:** ${head}${left}${more}`;
}

/** Has head `short` had a verdict? A started, errored-out or --no-land comment is not one, so a re-run judges. */
function prLanderJudged(bodies, short) {
  return String(bodies || '').split(PR_LANDER_MARKER).some((b) => b.startsWith(`\n**Codex lander (${short})`)
    && ![PR_LANDER_ERROR_TEXT, PR_LANDER_STARTED_TEXT, PR_LANDER_NOT_LANDED_TEXT].some((t) => b.includes(t)));
}

/**
 * Typical minutes from a lander run's start to its result: the median of recent successful runs
 * that judged something (5+ minutes; skips and quick exits are shorter), rounded up to 5. Null
 * with fewer than 3 such runs. runs: GitHub workflow_runs entries.
 */
function typicalLanderMinutes(runs) {
  const mins = (Array.isArray(runs) ? runs : [])
    .filter((x) => x && x.status === 'completed' && x.conclusion === 'success')
    .map((x) => (Date.parse(x.updated_at) - Date.parse(x.run_started_at)) / 60000)
    .filter((m) => Number.isFinite(m) && m >= 5)
    .slice(0, 20)
    .sort((a, b) => a - b);
  if (mins.length < 3) return null;
  const mid = mins.length % 2 ? mins[(mins.length - 1) / 2] : (mins[mins.length / 2 - 1] + mins[mins.length / 2]) / 2;
  return Math.ceil(mid / 5) * 5;
}

/** The PR title with one "<prefix>: " in front (never twice). */
function prLanderTitle(title, prefix) {
  const t = String(title || '');
  return t.startsWith(`${prefix}: `) ? t : `${prefix}: ${t}`;
}

// The owner's one email per finished PR: the subject alone answers "is it live?" on a phone.
const PR_LANDER_EMAIL_WHY = {
  rejected: 'the Claude check found problems',
  conflict: 'it clashes with newer work on main',
  blocked: 'it touches something never landed automatically',
  refused: 'the final landing checks refused it',
  error: 'the checker hit an error of its own',
};
/**
 * Subject and plain lines for the end-of-run owner email, or null for an outcome that sends none
 * (started, superseded, notLanded, unknownAuthor). title: the PR title as Codex wrote it; minutes:
 * from the PR's creation to now; why: a shorter reason than the outcome's default (e.g. tests failed).
 */
function prLanderEmail({ outcome, title, minutes, site = true, why, prUrl }) {
  const t = String(title || 'Codex change').replace(/^Landed: /, '').replace(/\s+/g, ' ').trim();
  const name = t.length > 70 ? `${t.slice(0, 67)}...` : t;
  const took = Number.isFinite(minutes) && minutes >= 0 ? `${Math.max(1, Math.round(minutes))} min` : '';
  if (outcome === 'landed') {
    return {
      subject: `✅ Live: ${name}${took ? ` (${took})` : ''}`,
      lines: [
        site ? 'This change passed the Claude check and is on main. It shows on broadwayscorecard.com with the next deploy, usually within 30 minutes.'
          : 'This change passed the Claude check and is on main. It does not change the website, so it is in effect now.',
        'Nothing else is needed.',
        prUrl ? `Pull request: ${prUrl}` : '',
      ].filter(Boolean),
    };
  }
  if (!PR_LANDER_EMAIL_WHY[outcome]) return null;
  const reason = why || PR_LANDER_EMAIL_WHY[outcome];
  return {
    subject: `❌ Not live: ${name} (${reason})`,
    lines: [
      `This change was not put on the site: ${reason}.`,
      outcome === 'error' || outcome === 'blocked' ? 'The pull request comment has the details.'
        : 'The pull request comment says what to fix. Ask Codex to fix it in the same task and press "Update PR"; it is checked again on its own.',
      prUrl ? `Pull request: ${prUrl}` : '',
    ].filter(Boolean),
  };
}

/** Does any changed path fall under the deploy gate's site paths (should-deploy-gate SITE_PATHS)? */
function touchesSite(files, sitePaths) {
  return (files || []).some((f) => (sitePaths || []).some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p)));
}

/**
 * The deadline of a fix round: the card budget, or the rest of the run for the first SHIP-WITH-FIXES round
 * (BRO-5384) and for a REJECT round (BRO-6260: a REJECT gets one fix round, MAX_ATTEMPTS = 2, and capping it at the
 * 60-min card budget banned 58% of bounced cards for 14 days on their first try, before that round ever ran).
 * rejectRunEnd false (CODEX_REJECT_RUN_END=0) restores the card budget for REJECT.
 */
function fixRoundDeadline({ verdict, swfRoundUsed, cardDeadlineMs, runEndMs, rejectRunEnd = true }) {
  if (verdict === 'SHIP-WITH-FIXES' && !swfRoundUsed) return runEndMs;
  if (verdict === 'REJECT' && rejectRunEnd) return runEndMs;
  return Math.min(cardDeadlineMs, runEndMs);
}

/**
 * Minutes a landing may be waited for: wait-for-land's usual 90, cut so the run still has
 * wrapUpMs before its hard stop (BRO-5287: the routine kills the runner at 120 min). < 1 = do not wait.
 */
function landWaitMinutes({ hardEndMs, wrapUpMs, nowMs }) {
  return Math.min(90, Math.floor((hardEndMs - wrapUpMs - nowMs) / 60_000));
}


/**
 * A runner that exits without a summary says why (BRO-6139 stage 2): one comment on the runner
 * card, read by scripts/lib/codex-lane-health.js. cls is a fixed word so readers never parse prose:
 *   login         the stored Codex login did not restore (a person must log in again)
 *   login-refresh deliberate: the login may refresh during the run, so this lane stands aside
 *   lock-held     another run holds this slot's lock (holderStartedMs: when that run started)
 *   sandbox|tools|picker|crash|lane  the lane cannot work until fixed
 */
const STAND_DOWN_CLASSES = ['login', 'login-refresh', 'lock-held', 'sandbox', 'tools', 'picker', 'crash', 'lane'];
function standDownNote({ lane = 'cloud', slot = 0, cls, why, holderStartedMs = NaN, loginExpiresMs = NaN }) {
  const c = STAND_DOWN_CLASSES.includes(cls) ? cls : 'crash';
  const stamps = [
    Number.isFinite(holderStartedMs) ? `Lock holder started: ${new Date(holderStartedMs).toISOString()}` : '',
    // login-refresh: the expiry this stand-down saw, so a later saved refresh does not make it look stuck.
    Number.isFinite(loginExpiresMs) ? `Login expires: ${new Date(loginExpiresMs).toISOString()}` : '',
  ].filter(Boolean);
  return `## Codex runner did not start (slot ${Number(slot) || 0}) (lane ${lane}) (reason ${c})\n\n${String(why || '').slice(0, 1500)}${stamps.length ? `\n\n${stamps.join('\n')}` : ''}`;
}
/** -> { lane, slot, cls, why, holderStartedMs, loginExpiresMs } or null. A pre-BRO-6139 note (no markers) reads as cloud, class login. */
function parseStandDownNote(body) {
  const b = String(body || '');
  if (!b.startsWith('## Codex runner did not start')) return null;
  const head = b.split('\n')[0];
  const lane = (head.match(/\(lane (cloud|gha)\)/) || [])[1] || 'cloud';
  const slot = Number((head.match(/\(slot (\d+)\)/) || [])[1] || 0);
  const cls = (head.match(/\(reason ([a-z-]+)\)/) || [])[1] || (/login/i.test(b) ? 'login' : 'crash');
  const why = b.split('\n').slice(1).filter((l) => !/^(Lock holder started|Login expires): /.test(l)).join('\n').trim();
  const stamp = (k) => Date.parse((b.match(new RegExp(`^${k}: (\\S+)$`, 'm')) || [])[1] || '');
  return { lane, slot, cls, why, holderStartedMs: stamp('Lock holder started'), loginExpiresMs: stamp('Login expires') };
}

/** The lock commit body's "Started:" time, NaN when unreadable. */
function lockStartedMs(body) {
  return Date.parse((String(body || '').match(/^Started: (\S+)\s*$/m) || [])[1] || '');
}

// BRO-6236: pinned Codex model and the high vs xhigh effort A/B. All default-off: with none of
// CODEX_MODEL / CODEX_EFFORT / CODEX_EFFORT_AB set, codexSettings returns today's exec settings.
const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_DEFAULT_EFFORT = 'high';
/** "a, b" -> ['a', 'b'] (a model preference list, strongest first). */
function parseModelCandidates(raw) {
  return String(raw || '').split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9._:-]+$/.test(x));
}
/** Stable 0..n-1 bucket for a card id, so a card lands in the same A/B arm on every attempt. */
function abBucket(cardId, n) {
  let h = 0;
  for (const ch of String(cardId || '')) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return n > 0 ? h % n : 0;
}
/**
 * Exec settings for one card -> { models, effort, arm }. models is the preference list ([] = the
 * CLI default, today's behaviour). effort comes from CODEX_EFFORT_AB (e.g. "high,xhigh": the arm
 * is chosen by card id, not slot, so both arms draw from the same cards and the same firings),
 * else CODEX_EFFORT, else high. An unknown effort name falls back to high.
 */
function codexSettings(env, cardId) {
  const valid = (e) => CODEX_EFFORTS.includes(e);
  const ab = String((env || {}).CODEX_EFFORT_AB || '').split(',').map((x) => x.trim()).filter(valid);
  const single = String((env || {}).CODEX_EFFORT || '').trim();
  let effort = valid(single) ? single : CODEX_DEFAULT_EFFORT;
  let arm = null;
  if (ab.length > 1) { effort = ab[abBucket(cardId, ab.length)]; arm = effort; }
  return { models: parseModelCandidates((env || {}).CODEX_MODEL), effort, arm };
}
/**
 * True when Codex's own ERROR lines (the last 40 lines, like codexExitTransient) say the model name is
 * not available to this login. Tool output inside a long exec ("unknown model" in code Codex read)
 * must not move the runner down the model list.
 */
function isUnknownModelError(out) {
  const re = /(?:model\b(?![_\w])[^\n]{0,80}(?:not found|does not exist|not supported|unsupported|not available|isn't available)|(?:unknown|unsupported|invalid) model\b(?![_\w])|not have access to (?:the )?model)/i;
  return String(out || '').split('\n').slice(-40).some((l) => /^\s*(?:ERROR|error):/.test(l) && re.test(l));
}
/** The summary line that records which model and effort each card ran at (the A/B report reads it). */
function codexSettingsLine(used) {
  const byEffort = {};
  for (const [id, u] of Object.entries(used.cards || {})) (byEffort[u.effort] = byEffort[u.effort] || []).push(id);
  const parts = Object.keys(byEffort).sort().map((e) => `${e}: ${byEffort[e].join(' ')}`);
  return `- Codex settings: model ${used.model || 'CLI default (not pinned)'}; effort ${parts.join('; ') || 'none run'}`;
}
/** -> { model, byEffort: { effort: [ids] } } from a run summary, or null when it has no settings line. */
function parseCodexSettingsLine(body) {
  const m = String(body || '').match(/^- Codex settings: model (.+?); effort (.*)$/m);
  if (!m) return null;
  const byEffort = {};
  if (m[2].trim() !== 'none run') for (const part of m[2].split(';')) {
    const [e, ids] = part.split(':');
    if (e && ids) byEffort[e.trim()] = ids.trim().split(/\s+/).filter(Boolean);
  }
  return { model: m[1].trim(), byEffort };
}

const AB_OUTCOMES = [
  ['landed', 'Landed and Done'],
  ['partial', 'Landed part, back to Todo with what is left'],
  ['alreadyFixed', 'Already fixed, closed'],
  ['rejected', 'Did not pass the Claude check, back to Todo'],
  ['error', 'Runner error mid-card \\(back to Todo\\)'],
];
/**
 * BRO-6236: per-effort outcome table from run-summary bodies. Only summaries with a "Codex settings"
 * line count (older ones carry no effort). Minutes are the run's, shared out by card count.
 * -> { effort: { cards, landed, partial, alreadyFixed, rejected, error, other, mins } }
 */
function abReport(bodies, { sinceMs = 0, createdAtMs = [], lane = null } = {}) {
  const out = {};
  const seen = new Set(); // a carried card is listed in more than one summary: count it once
  bodies.forEach((body, i) => {
    if (sinceMs && !(createdAtMs[i] >= sinceMs)) return;
    const settings = parseCodexSettingsLine(body);
    const head = parseSummaryHeading(body);
    if (!settings || !head) return;
    if (lane && (head.lane || laneOfSummary(body, createdAtMs[i] || 0)) !== lane) return;
    const total = Object.values(settings.byEffort).reduce((n, ids) => n + ids.length, 0) || 1;
    const listOf = (label) => {
      const v = (String(body).match(new RegExp(`^- ${label}: (.*)$`, 'm')) || [])[1] || 'none';
      return v.trim() === 'none' ? [] : v.split(',').map((x) => x.trim()).filter(Boolean);
    };
    for (const [effort, allIds] of Object.entries(settings.byEffort)) {
      const ids = allIds.filter((id) => !seen.has(id));
      ids.forEach((id) => seen.add(id));
      if (!ids.length) continue;
      const row = out[effort] = out[effort] || { cards: 0, landed: 0, partial: 0, alreadyFixed: 0, rejected: 0, error: 0, other: 0, mins: 0 };
      row.cards += ids.length;
      row.mins += head.mins * ids.length / total;
      let counted = 0;
      for (const [key, label] of AB_OUTCOMES) {
        const n = listOf(label).filter((id) => ids.includes(id)).length;
        row[key] += n; counted += n;
      }
      row.other += ids.length - counted;
    }
  });
  return out;
}


/**
 * BRO-5384 acceptance: cards per firing and landed share from runner summaries. Each slot posts
 * its summary when it finishes (minutes or ~110 min into the firing), so time gaps do not group a
 * firing; every launch posts exactly one summary from its lane's first slot (0 cloud, 3 gha, or 0
 * for a gha launch that fell back), or one with no slot suffix (a pre-BRO-6139 lone runner), and
 * those count the firings. -> { firings, worked, landed, perFiring, landedShare }
 */
function firingThroughput(comments) {
  const firstSlots = new Set(Object.values(LANES).map((l) => l.base));
  let firings = 0; let worked = 0; let landed = 0;
  for (const c of Array.isArray(comments) ? comments : []) {
    const h = c && parseSummaryHeading(c.body);
    if (!h) continue;
    if (h.slot === null || firstSlots.has(h.slot)) firings += 1;
    worked += h.worked;
    landed += runnerSummaryFacts(c.body).landed;
  }
  return { firings, worked, landed, perFiring: firings ? worked / firings : 0, landedShare: worked ? landed / worked : 0 };
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
    // Only a login stand-down means the login (BRO-6139 notes also say "lock-held", "sandbox", ...).
    const noLogin = (Array.isArray(comments) ? comments : []).some((c) => c && (parseStandDownNote(c.body) || {}).cls === 'login'
      && Date.parse(c.createdAt) <= nowMs && nowMs - Date.parse(c.createdAt) <= windowMs);
    return { status: 'error', message: noLogin
      ? 'Codex runner could not start in the last 24h: its Codex login is not usable (see "## Codex runner did not start" on BRO-4745).'
      : 'No Codex runner summary in the last 24h: the runner is not running (it should post one every 2 hours).' };
  }
  let landed = 0; let crashed = 0; let checkUsd = 0; const lockStops = [];
  for (const c of recent) {
    const f = runnerSummaryFacts(c.body);
    landed += f.landed;
    crashed += f.crashed;
    checkUsd += f.checkUsd;
    if (/lock/i.test(f.stop)) lockStops.push(String(c.createdAt).slice(0, 16));
  }
  // The Claude spend the Codex lane costs (its check), per card it landed (BRO-5384 savings line).
  const spend = `, Claude check $${checkUsd.toFixed(2)}${landed ? ` ($${(checkUsd / landed).toFixed(2)} per landed card)` : ''}`;
  const facts = `${recent.length} run(s), ${landed} card(s) landed, ${crashed} crashed mid-card${spend} in the last 24h`;
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
// A card's worktrees, data copies, unit batches and Codex session logs; below this a card can
// fail half-way with "No space left on device".
const MIN_FREE_DISK_BYTES = 3e9;
function stopReason({ startedMs, nowMs, maxMinutes, weeklyPct, maxWeeklyPct, rejectStreak, doneRefusals, checkSpentUsd = 0, checkBudgetUsd = null, crashStreak = 0, lastCrash = '', freeDiskBytes = null }) {
  if (checkBudgetUsd != null && checkSpentUsd >= checkBudgetUsd) return `Claude check spend $${checkSpentUsd.toFixed(2)} reached the run cap of $${checkBudgetUsd}`;
  if (maxMinutes && nowMs - startedMs > maxMinutes * 60_000) return `time budget of ${maxMinutes} min used`;
  if (weeklyPct != null && maxWeeklyPct != null && weeklyPct >= maxWeeklyPct) return `Codex weekly allowance at ${weeklyPct}% (cap ${maxWeeklyPct}%)`;
  if (rejectStreak >= 3) return '3 Claude REJECTs in a row';
  if (doneRefusals >= 1) return 'the Done gate refused a card the Claude check passed';
  // Runner errors in a row mean the machine is broken (disk full, lost lock), not the cards:
  // stop instead of crashing through the queue (17 cards in 2 min on 2026-10-15, BRO-5287).
  if (crashStreak >= 2) return `${crashStreak} runner errors in a row (the last: ${String(lastCrash || '').slice(0, 160)})`;
  if (freeDiskBytes != null && freeDiskBytes < MIN_FREE_DISK_BYTES) return `only ${(freeDiskBytes / 1e9).toFixed(1)} GB of disk left (needs ${MIN_FREE_DISK_BYTES / 1e9} GB to start a card)`;
  return null;
}

// Temp dirs a firing leaves behind when a test or a data copy is killed mid-way (BRO-5422/5443:
// leaked /tmp/bro-5217-* clones filled the disk). Prefix -> age after which it is surely dead.
const STALE_TMP_RULES = [
  [/^bro-5217-/, 15 * 60_000],
  // A land-check pass reuses its gauntlet copy for up to ~2.5 h (3 branch batches, then the base).
  [/^codex-lw-/, 4 * 3600_000],
  [/^codex-land-gauntlet-/, 4 * 3600_000],
  // mktemp's default name, also used by the Claude lane's scripts: only what is surely dead.
  [/^tmp\./, 12 * 3600_000],
];
/** Names in a temp dir that are safe to delete: entries [{ name, mtimeMs }] -> [name]. */
function staleTmpEntries(entries, nowMs) {
  return (entries || []).filter(({ name, mtimeMs }) => {
    const rule = STALE_TMP_RULES.find(([re]) => re.test(String(name)));
    return rule && Number.isFinite(mtimeMs) && nowMs - mtimeMs > rule[1];
  }).map((e) => e.name);
}

// BRO-6304: .claude/worktrees/<name> that a Claude worker lane left behind (a skipped cleanup step or a
// dead session, ~1.3 GB each). The runner's own slot worktrees are kept on purpose.
const CODEX_SLOT_WORKTREE = /^codex-runner(-base)?(-\d+)?$/;
const CLAUDE_WORKTREE_IDLE_MS = 3 * 3600_000;
/**
 * Names safe to remove. entries: [{ name, newestMs, liveCwd, dirty, unpushed, locked }] where
 * newestMs is the newest mtime of the tree's files AND its git metadata (HEAD, index, logs/HEAD),
 * liveCwd a process has its cwd inside, dirty uncommitted or untracked files, unpushed commits
 * beyond origin/main, locked git's own lock. An unknown field (null/undefined) keeps the tree.
 */
function staleClaudeWorktrees(entries, nowMs, idleMs = CLAUDE_WORKTREE_IDLE_MS) {
  return (entries || []).filter((e) => e && !CODEX_SLOT_WORKTREE.test(String(e.name))
    && e.liveCwd === false && e.dirty === false && e.unpushed === false && e.locked === false
    && Number.isFinite(e.newestMs) && nowMs - e.newestMs > idleMs).map((e) => e.name);
}

/** Paths of `locked` worktrees in `git worktree list --porcelain` text. */
function lockedWorktreePaths(porcelain) {
  return new Set(String(porcelain || '').split('\n\n').filter((b) => /^locked/m.test(b))
    .map((b) => (b.match(/^worktree (.*)$/m) || [])[1]).filter(Boolean));
}
/** True when any process cwd is `dir` or inside it. */
function cwdInside(cwds, dir) { return (cwds || []).some((c) => c === dir || String(c).startsWith(`${dir}/`)); }
/**
 * Newest mtime of files under `dir`, skipping .git, node_modules, .next, data and public (copies and
 * images that are 100k+ files and say nothing about a worker's activity). Stops once one is newer
 * than `cutoffMs`. An unfinished walk (budget spent) returns `nowMs`, which keeps the tree.
 */
function newestMtimeMs(dir, cutoffMs, { maxFiles = 250_000, nowMs = Date.now() } = {}) {
  const fs = require('fs'), path = require('path');
  const skip = new Set(['.git', 'node_modules', '.next', 'data', 'public']);
  let left = maxFiles, newest = 0;
  const stack = [dir];
  while (stack.length && left > 0) {
    const d = stack.pop();
    let names = [];
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of names) {
      if (skip.has(e.name)) continue;
      left--;
      const full = path.join(d, e.name);
      try {
        const st = fs.lstatSync(full);
        if (st.mtimeMs > newest) newest = st.mtimeMs;
        if (newest > cutoffMs) return newest;
        if (e.isDirectory()) stack.push(full);
      } catch { /* vanished */ }
    }
  }
  return left > 0 ? newest : nowMs;
}
/** Gitignored work that `git status` and `git worktree remove` do not protect: a .env*, or a real (not linked) data/review-texts clone. */
function holdsIgnoredWork(wt) {
  const fs = require('fs'), path = require('path');
  try { if (fs.readdirSync(wt).some((n) => /^\.env(\..+)?$/.test(n) && !/\.(example|sample|template)$/.test(n))) return true; } catch { return true; }
  try {
    const st = fs.lstatSync(path.join(wt, 'data/review-texts'));
    if (st.isDirectory() && fs.existsSync(path.join(wt, 'data/review-texts/.git'))) return true;
  } catch { /* absent */ }
  return false;
}

// One slot's worktree or base worktree (public/images + data, measured 2026-10-16).
const WORKTREE_BYTES = 1.4e9;
/**
 * How many slots the free disk carries: slot k needs its worktree and base worktree created
 * (missingBySlot[k] of the two do not exist yet) and still MIN_FREE_DISK_BYTES to run a card.
 * -> { slots, why }
 */
function slotsForDisk({ slots, freeBytes, missingBySlot = [] }) {
  if (!(slots > 1) || !Number.isFinite(freeBytes)) return { slots: Math.max(1, slots || 1), why: null };
  const need = (n) => MIN_FREE_DISK_BYTES * n
    + WORKTREE_BYTES * missingBySlot.slice(0, n).reduce((a, m) => a + (Number(m) || 0), 0);
  let n = slots;
  while (n > 1 && freeBytes < need(n)) n--;
  return n === slots ? { slots, why: null } : { slots: n, why: `only ${(freeBytes / 1e9).toFixed(1)} GB of disk free` };
}

/**
 * A check or Codex failure caused by a full disk, not by the card. The system's own message
 * ("No space left on device") is enough: a batch that filled the disk has usually freed it by
 * the time it is judged. A bare ENOSPC (a test about ENOSPC handling) counts only while the
 * disk is low right now.
 */
const DISK_FULL_RE = /No space left on device/i;
function isDiskFailure(text, freeDiskBytes) {
  const t = String(text || '');
  return DISK_FULL_RE.test(t)
    || (/\bENOSPC\b/.test(t) && Number.isFinite(freeDiskBytes) && freeDiskBytes < MIN_FREE_DISK_BYTES);
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
  runnerTimeLimits,
  runnerLockBody,
  orphanStopDetails,
  weeklyPctFromSessions,
  emptyBatchVerdict,
  parseCheckOutput,
  lockMessage,
  withFileMutex,
  CONTAINER_LAND_MUTEX,
  lockCards,
  runnerId,
  lockRun,
  lockTipVerdict,
  lockStampTooOld,
  landWaitMinutes,
  firingThroughput,
  summaryHeading, parseSummaryHeading, laneOfSummary,
  parseModelCandidates, codexSettings, isUnknownModelError, codexSettingsLine, parseCodexSettingsLine, abReport, CODEX_EFFORTS,
  authAccessExpires, parseAuthMeta,
  STAND_DOWN_CLASSES, standDownNote, parseStandDownNote, lockStartedMs,
  runnerSummaryFacts, runnerSummaryText, codexLadderAccess, reviewTextsPlan, ladderSkip,
  runnerHealth,
  codexExitTransient,
  stripHookNoise,
  codexCardFit,
  slotNames,
  jwtExpMs,
  slotsForLogin,
  loginExpiryWhy,
  LANES,
  MAX_SLOTS,
  laneSlotList,
  laneForLogin,
  cardsInLocks,
  SWF_CARRY_MARKER,
  swfCarryBody,
  parseSwfCarry,
  parseCodexRetry,
  retryBody,
  RETRY_MARKER,
  UNCLAIMED_RETRY_MS,
  fixRoundDeadline,
  checkModel,
  landedPerLane, LANDED_LOG_FORMAT,
  codexCloudPr,
  prLanderComment,
  PR_LANDER_MARKER,
  PR_LANDER_ERROR_TEXT,
  PR_LANDER_STARTED_TEXT,
  prLanderJudged,
  typicalLanderMinutes,
  prLanderTitle,
  prLanderEmail,
  touchesSite,
  leaveToCodex,
  slotArgs,
  carryPatch,
  FIX_EXEC_MIN_MS,
  REVIEW_RESERVE_MS,
  LAND_CHECKS_MS,
  fixRoundFits,
  execBudgetMs,
  cardStartMs,
  launchRunDir,
  CODEX_MIN_SCORE,
  orphanAction,
  keepEnvVar,
  scrubEnv,
  reviewerSandboxAuth,
  REVIEWER_READ_DENY,
  redactSecrets,
  cardBody,
  AUTH_MARKER,
  BOUNCED_MARKER,
  classifyBounce,
  bounceClassLine,
  bounceClassOf,
  structuralBounceHolds,
  isPersonComment,
  STRUCTURAL_BOUNCE_CLASSES,
  STRUCTURAL_MEMORY_MS,
  PARTIAL_MARKER,
  PARTIAL_HEADING,
  landingIsPartial,
  parseEnvBlocked,
  parseRemaining,
  DATA_FILES,
  DATA_DIRS,
  dropDataDir,
  hasCredentialRemote,
  MAX_ATTEMPTS_SHIP_WITH_FIXES,
  codexBouncedRecently,
  isCodexBounce,
  MIN_FREE_DISK_BYTES,
  staleTmpEntries,
  staleClaudeWorktrees,
  CLAUDE_WORKTREE_IDLE_MS,
  lockedWorktreePaths,
  cwdInside,
  newestMtimeMs,
  holdsIgnoredWork,
  CODEX_SLOT_WORKTREE,
  LATER_CARD_DISCOUNT_MS,
  slotsForDisk,
  isDiskFailure,
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
