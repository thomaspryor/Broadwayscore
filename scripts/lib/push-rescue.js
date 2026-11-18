#!/usr/bin/env node
'use strict';
/**
 * Push rescue for the broadway-review-texts repo (BRO-6615).
 *
 * When every push attempt fails, the job's commits used to die with the
 * runner. opening-night-poller run 41013824281 (2026-10-30) lost 29 files
 * that way, including a new review stub (_pending/a-few-good-men-2026/
 * new-york-sun--4b16c00e.json) no later run re-created. The Git Data API
 * fallback cannot carry ADDED review files: the cross-show ownership gate
 * (validate-added-review-ownership.js) needs a working tree (BRO-5589), so
 * loosening that disqualifier was rejected in review.
 *
 * Instead the unpushed commit is pushed to a NEW branch,
 * push-rescue/<UTC stamp>-<run id>-<base sha>. Creating a fresh ref cannot
 * lose a race to main's churn, so this lands even when main pushes do not.
 * replay-push-rescue.yml then restores the added files on a fresh checkout,
 * runs the real ownership gate on them, pushes through push-review-texts,
 * and deletes the branch only once every restored file is on main.
 *
 * Only ADDS are replayed. Modifications and deletions need the local flow's
 * three-way context; they are named in the logs and otherwise lost, as before
 * (later runs redo enrichment and stub drains).
 *
 * CLI (cwd = a review-texts checkout):
 *   rescue <base> <head>       push <head> to a rescue branch when the range
 *                              adds review files; never fails the caller
 *   replay [--manifest=F]      restore added files from every rescue branch
 *   prune --manifest=F         delete rescue branches whose restored files
 *                              are all on origin/main now, byte for byte
 *
 * Branches are never deleted on age or on doubt: one with a conflict (main
 * or another rescue holds different content at the path), a file the
 * ownership gate dropped, is kept and named every hour
 * until a human resolves it. Exception (BRO-7549): when the rescued copy of a conflicting file holds
 * nothing main lacks (settleConflict says 'main'), main wins automatically; the tip is still tagged
 * push-rescue-archive/... before the delete. Mixed or tied conflicts, and 'rescued is strictly fuller'
 * (computed and logged, not acted on), still wait for a person. PUSH_RESCUE_AUTO_SETTLE_DISABLE=1 restores always-wait. PUSH_RESCUE_DISABLE=1 turns off `rescue`.
 *
 * Resolving one: once the owner picks main's copy of every conflicting file,
 * dispatch replay-push-rescue.yml with main_wins=<branch>@<tip sha>
 * (PUSH_RESCUE_MAIN_WINS, comma-separated). The tip sha binds the approval to
 * the branch content that was reviewed; a branch that moved is left alone.
 * Each overridden path logs both blob shas, and prune saves the branch tip as
 * tag push-rescue-archive/<branch suffix> before deleting it (no tag, no delete).
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { runGit } = require('./git-proc-guard.js'); // BRO-7458: a timed-out network git must not orphan its index-pack
const { isReviewFilePath } = require('./review-texts-api-fallback.js');

const RESCUE_PREFIX = 'push-rescue/';
const REF_RE = /^push-rescue\/(\d{8}T\d{6}Z)-([A-Za-z0-9_.]+)-([0-9a-f]{40})$/;

/** Review files plus pending stubs (_pending/<show>/<file>.json). */
function isRecoverablePath(p) {
  if (isReviewFilePath(p)) return true;
  const parts = String(p || '').split('/');
  return parts.length === 3 && parts[0] === '_pending' && parts[1] && !parts[1].startsWith('.')
    && parts[2].endsWith('.json');
}

/** Rows of `git diff --name-status -z --no-renames`. */
function parseNameStatusZ(out) {
  const parts = String(out || '').split('\0');
  const rows = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i]) rows.push({ status: parts[i][0], path: parts[i + 1] });
  }
  return rows;
}

function recoverableAdds(rows) {
  return rows.filter((r) => r.status === 'A' && isRecoverablePath(r.path)).map((r) => r.path);
}

function rescueRefName({ now, runId, base }) {
  if (!/^[0-9a-f]{40}$/.test(String(base || ''))) throw new Error(`push-rescue: base must be a full sha, got '${base}'`);
  const stamp = new Date(now).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const id = String(runId || 'local').replace(/[^A-Za-z0-9_.]/g, '_') || 'local';
  return `${RESCUE_PREFIX}${stamp}-${id}-${base}`;
}

function parseRescueRef(ref) {
  const m = REF_RE.exec(String(ref || '').replace(/^refs\/heads\//, ''));
  if (!m) return null;
  const s = m[1];
  const at = Date.parse(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
  return { stamp: s, at, runId: m[2], base: m[3] };
}

// BRO-6859: a rescued stub whose file main already holds, same review URL, at
// an equal or later content tier, is superseded (a later pipeline run enriched
// it). Fail closed: anything unparseable, URL-less, unknown-tier, or carrying a
// non-empty field main lacks stays a conflict for a person.
const TIER_RANK = { invalid: 0, stub: 1, excerpt: 2, truncated: 3, complete: 4 };
const CONTENT_KEYS = new Set(['contentTier', 'contentTierReason', 'fullText', 'sources', 'source', 'dateSource']);
const normUrl = (u) => {
  if (typeof u !== 'string') return '';
  const t = u.trim().replace(/\/+$/, '');
  const m = /^(https?:\/\/[^/]+)(.*)$/i.exec(t);
  return m ? m[1].toLowerCase() + m[2] : t;
};
// Fields where a different non-empty value on main means a person must look.
const IDENTITY_KEYS = ['showId', 'outletId', 'criticName', 'originalScore', 'assignedScore'];
const isEmpty = (v) => v == null || v === '' || v === false || (Array.isArray(v) && v.length === 0);
const canon = (v) => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x)
  ? Object.fromEntries(Object.keys(x).sort().map((key) => [key, x[key]])) : x));
// Fetch-STATE reasons (retry bookkeeping a fuller copy clears). Verdict reasons
// (wrong_content, non_review, scraper_garbage, url_content_mismatch...) are
// read by scoring (is-scoreable.ts, compute-composite.js) and never waived.
const FETCH_STATE_REASONS = new Set(['not_attempted', 'paywall', 'bot_blocked', 'scraper_timeout',
  'partial_text', 'url_dead', 'route_capped', 'no_url', 'no_text', 'code_error']);
// Retry/fetch bookkeeping a later run rewrites. Used only by the no-text rule.
// Not here: contentVerification(+Promoted) hold the verifier's wrongArticle
// verdict (rebuild-helpers.js reads it) and archivePath points at saved HTML.
const BOOKKEEPING_KEYS = new Set(['fetchRetryAfter', 'fetchDiscoveryAbandoned', 'textRetryAttemptedAt',
  'fetchMethod', 'fetchAttempts', 'fetchTier', 'criticBackfillAttempt', 'textFetchedAt']);
const UNKNOWN_CRITIC = /^\s*(unknown|unnamed)?\s*$/i;
// A detail with no reason may be verdict text, so only a known fetch-state reason waives it.
const isFetchStateOnly = (a) => FETCH_STATE_REASONS.has(a.incompleteReason);
// An excerpt-tier file keeps its text in *Excerpt fields, not fullText.
const hasNoTextToLose = (a, b) => isEmpty(a.fullText)
  && Object.keys(a).every((k) => !/Excerpt$/.test(k) || isEmpty(a[k]) || canon(a[k]) === canon(b[k]));
function mainSupersedesRescue(rescueText, mainText) {
  let a; let b;
  try { a = JSON.parse(rescueText); b = JSON.parse(mainText); } catch { return false; }
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  // Every non-empty rescued field is already on main with the same value: nothing to lose.
  if (Object.keys(a).every((k) => isEmpty(a[k]) || canon(a[k]) === canon(b[k]))) return true;
  const ua = normUrl(a.url);
  if (!ua || ua !== normUrl(b.url)) return false;
  const ra = TIER_RANK[a.contentTier];
  const rb = TIER_RANK[b.contentTier];
  // A placeholder critic on the RESCUE that main later named is not a conflict.
  const idDiffers = (k) => !isEmpty(a[k]) && !isEmpty(b[k]) && JSON.stringify(a[k]) !== JSON.stringify(b[k])
    && !(k === 'criticName' && typeof a[k] === 'string' && UNKNOWN_CRITIC.test(a[k]));
  if (IDENTITY_KEYS.some(idDiffers)) return false;
  const waivable = (k) => CONTENT_KEYS.has(k)
    || ((k === 'incompleteReason' || k === 'incompleteDetail') && isFetchStateOnly(a))
    || (k === 'criticName' && UNKNOWN_CRITIC.test(String(a[k])));
  // BRO-7173: a rescued copy with no text (no fullText, excerpts equal to
  // main's) loses nothing to main at an equal or higher tier (or one main
  // judged invalid), provided every other value it holds matches main or is
  // retry bookkeeping a later run rewrote.
  // Only ever widens: when it does not apply, the older rule below decides.
  // Of the content keys only the tier itself (and its reason) may differ, and
  // only when main's is higher or invalid; sources/dateSource must match.
  const mainAhead = rb > ra || b.contentTier === 'invalid';
  const noTextWaivable = (k) => k === 'url' || BOOKKEEPING_KEYS.has(k)
    || ((k === 'contentTier' || k === 'contentTierReason') && mainAhead)
    || (k !== 'contentTier' && k !== 'contentTierReason' && !CONTENT_KEYS.has(k) && waivable(k));
  if (ra !== undefined && rb !== undefined && hasNoTextToLose(a, b) && (rb >= ra || b.contentTier === 'invalid')
    && Object.keys(a).every((k) => isEmpty(a[k]) || canon(a[k]) === canon(b[k]) || noTextWaivable(k))) return true;
  // Identical text on main, whatever tier the pipeline gave it since, loses nothing.
  const sameText = typeof a.fullText === 'string' && a.fullText !== '' && a.fullText === b.fullText;
  if (!sameText && (ra === undefined || rb === undefined || rb <= ra)) return false;
  return Object.keys(a).every((k) => waivable(k) || isEmpty(a[k]) || !isEmpty(b[k]));
}

/**
 * Pure decision for one rescue branch.
 * @param {{adds: string[], mainBlob: Map<string,string>,
 *   touchedOnMain: Set<string>, rescueBlob: Map<string,string>,
 *   claimed?: Map<string,string>}} s
 *   mainBlob: blob sha of each path on origin/main now (absent = not there);
 *   touchedOnMain: paths a main commit since the rescue's base changed (e.g.
 *   a later run drained the stub); rescueBlob: blob sha on the rescue branch;
 *   claimed: paths an earlier branch in the same replay already restored.
 *   Nothing on main is ever overwritten or resurrected.
 */
function replayPlan({ adds, mainBlob, touchedOnMain, rescueBlob, claimed = new Map(), superseded = () => false, mainWins = false }) {
  const restore = [];
  const skipped = [];
  const conflicts = [];
  for (const p of adds) {
    const ours = rescueBlob.get(p);
    if (mainBlob.has(p)) {
      if (mainBlob.get(p) === ours) skipped.push({ path: p, why: 'already on main' });
      else if (superseded(p)) skipped.push({ path: p, why: 'main holds the same review, further along' });
      else if (mainWins === true) skipped.push({ path: p, why: MAIN_WINS_WHY, rescueBlob: ours, mainBlob: mainBlob.get(p) });
      else if (typeof mainWins === 'function' && mainWins(p)) skipped.push({ path: p, why: AUTO_MAIN_WHY, rescueBlob: ours, mainBlob: mainBlob.get(p) });
      else conflicts.push({ path: p, why: MAIN_CONFLICT_WHY });
    } else if (touchedOnMain.has(p)) skipped.push({ path: p, why: 'changed on main since the rescue (e.g. drained or moved)' });
    else if (claimed.has(p)) {
      if (claimed.get(p) === ours) skipped.push({ path: p, why: 'restored from another rescue branch' });
      else conflicts.push({ path: p, why: 'another rescue branch holds a different version' });
    } else restore.push(p);
  }
  return { restore, skipped, conflicts, keepForHuman: conflicts.length > 0 };
}

const MAIN_WINS_WHY = 'owner chose main over this rescue copy (main_wins)';
const AUTO_MAIN_WHY = 'main holds everything the rescue copy has (auto-settled, BRO-7549)';
const ARCHIVE_WHYS = new Set([MAIN_WINS_WHY, AUTO_MAIN_WHY]);
const MAIN_CONFLICT_WHY = 'main holds a different version';

/**
 * Parse PUSH_RESCUE_MAIN_WINS: comma-separated `<branch>@<40-hex tip sha>`.
 * Throws on any malformed token (before anything is replayed).
 * @returns {Map<string,string>} branch name (no refs/heads/) -> tip sha
 */
function parseMainWins(str) {
  const out = new Map();
  for (const raw of String(str || '').split(',').map((t) => t.trim()).filter(Boolean)) {
    const at = raw.lastIndexOf('@');
    const ref = (at > 0 ? raw.slice(0, at) : raw).replace(/^refs\/heads\//, '');
    const sha = at > 0 ? raw.slice(at + 1).toLowerCase() : '';
    if (!REF_RE.test(ref) || !/^[0-9a-f]{40}$/.test(sha)) {
      throw new Error(`push-rescue: main_wins entry '${raw}' must be <push-rescue branch>@<40-char tip sha>`);
    }
    out.set(ref, sha);
  }
  return out;
}

/**
 * Which listed branches main_wins applies to: approved tip must equal the live tip.
 * @returns {{apply: Set<string>, notes: {level: string, msg: string}[]}}
 */
function mainWinsFor(refs, mainWins) {
  const apply = new Set();
  const notes = [];
  for (const [ref, tip] of mainWins) {
    const live = refs.find((e) => e.ref === ref);
    if (!live) notes.push({ level: 'warning', msg: `main_wins names ${ref}, which no longer exists` });
    else if (live.sha !== tip) notes.push({ level: 'error', msg: `main_wins for ${ref} was approved at ${tip} but the branch is at ${live.sha}; not applied` });
    else { apply.add(ref); notes.push({ level: 'notice', msg: `main_wins applies to ${ref} at ${tip}: main's copy wins every conflicting path` }); }
  }
  return { apply, notes };
}

/** True when every reason a kept branch needs a person is a main conflict main_wins can settle. */
function onlyMainConflicts(r) {
  return (r.conflicts || []).length > 0 && r.conflicts.every((c) => c.why === MAIN_CONFLICT_WHY) && !(r.dropped || []).length;
}

/**
 * BRO-7541: metadata-only summary of one review file, so a person can tell which side of a
 * conflict is the fuller one without anyone reading review text. Never returns text content.
 */
function reviewFacts(raw) {
  const text = String(raw || '');
  if (!text) return { kind: 'absent' };
  let j;
  try { j = JSON.parse(text); } catch { return { kind: 'unparseable', bytes: Buffer.byteLength(text) }; }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { kind: 'non-object', bytes: Buffer.byteLength(text) };
  const has = (k) => j[k] !== undefined && j[k] !== null && j[k] !== '';
  const flags = ['wrongShow', 'wrongProduction', 'isRoundupArticle'].filter((k) => j[k]);
  let newest = null;
  for (const [k, v] of Object.entries(j)) {
    if (typeof v !== 'string' || !/(At|Date|Time|date|time)$/.test(k)) continue;
    const t = Date.parse(v);
    if (!Number.isNaN(t) && /^\d{4}-\d{2}-\d{2}/.test(v) && (newest === null || t > newest.t)) newest = { k: k.replace(/[^A-Za-z]/g, '').slice(0, 30), t };
  }
  return {
    kind: 'object', j, bytes: Buffer.byteLength(text), flags,
    fullTextLen: typeof j.fullText === 'string' ? j.fullText.length : 0,
    contentTier: /^[a-z_-]{1,20}$/.test(String(j.contentTier || '')) ? j.contentTier : (j.contentTier ? 'other' : 'none'),
    hasAssigned: has('assignedScore'), hasLlm: has('llmScore'), hasCritic: !!j.criticName, newest,
  };
}

function describeReviewFile(raw) {
  const f = reviewFacts(raw);
  if (f.kind === 'absent') return 'absent';
  if (f.kind === 'unparseable') return `bytes=${f.bytes} unparseable-json`;
  if (f.kind === 'non-object') return `bytes=${f.bytes} non-object`;
  const yn = (b) => (b ? 'yes' : 'no');
  return [
    `bytes=${f.bytes}`,
    `fullTextLen=${f.fullTextLen}`,
    `contentTier=${f.contentTier}`,
    `assignedScore=${yn(f.hasAssigned)}`,
    `llmScore=${yn(f.hasLlm)}`,
    `criticName=${f.hasCritic ? 'present' : 'null'}`,
    `flags=${f.flags.length ? f.flags.join('+') : 'none'}`,
    `newest=${f.newest ? `${f.newest.k}:${new Date(f.newest.t).toISOString()}` : 'none'}`,
  ].join(' ');
}

/**
 * BRO-7549: decide a main-vs-rescued conflict on one review file without a person.
 * Returns {decision: 'main'|'rescued'|'wait', reasons: string[]}; reasons are metadata only, never text.
 *  main    : the rescued copy holds nothing main lacks (its text is empty or byte-identical to main's,
 *            same exclusion flags, tier not above main's, every score/identity/excerpt it holds equals main's).
 *  rescued : rescued is strictly fuller and main is not better on any compared field (computed and logged;
 *            replay does not act on it yet, the branch keeps waiting for a person).
 *  wait    : anything mixed, tied in a way that matters, unparseable, or both scored differently.
 */
const SCORE_KEYS = ['assignedScore', 'llmScore', 'originalScore'];
// Verdict fields (contentVerification(+Promoted), archivePath, verdict incompleteReason) are NOT here: they are compared like any other field.
const RESCUE_IGNORE_KEYS = new Set([...BOOKKEEPING_KEYS, 'contentTier', 'contentTierReason', 'fullText']);
function settleConflict(mainRaw, rescuedRaw) {
  const mainF = reviewFacts(mainRaw);
  const rescF = reviewFacts(rescuedRaw);
  if (mainF.kind !== 'object' || rescF.kind !== 'object') return { decision: 'wait', reasons: ['a side is absent or not a JSON object'] };
  const rescJ = rescF.j; const mainJ = mainF.j;
  const wait = [];
  const mainBetter = [];
  const rescuedBetter = [];
  if (mainF.flags.slice().sort().join() !== rescF.flags.slice().sort().join()) wait.push('exclusion flags differ');
  const mt = isEmpty(mainJ.fullText) ? '' : String(mainJ.fullText);
  const rt = isEmpty(rescJ.fullText) ? '' : String(rescJ.fullText);
  if (rt && rt !== mt) { if (!mt || rt.length > mt.length) rescuedBetter.push('rescued has text main lacks or a longer text'); else wait.push('texts differ'); }
  else if (mt && !rt) mainBetter.push('main has text, rescued has none');
  const mr = TIER_RANK[mainJ.contentTier]; const rr = TIER_RANK[rescJ.contentTier];
  if (mr === undefined || rr === undefined) { if (canon(mainJ.contentTier) !== canon(rescJ.contentTier)) wait.push('tier unknown'); }
  else if (rr > mr) rescuedBetter.push('rescued tier higher'); else if (mr > rr) mainBetter.push('main tier higher');
  for (const k of SCORE_KEYS) {
    const hm = !isEmpty(mainJ[k]); const hr = !isEmpty(rescJ[k]);
    if (hm && hr && canon(rescJ[k]) !== canon(mainJ[k])) wait.push(`${k} differs on both sides`);
    else if (hr && !hm) rescuedBetter.push(`${k} only on rescued`); else if (hm && !hr) mainBetter.push(`${k} only on main`);
  }
  for (const k of Object.keys(rescJ)) {
    if (isEmpty(rescJ[k]) || RESCUE_IGNORE_KEYS.has(k) || SCORE_KEYS.includes(k)) continue;
    if ((k === 'incompleteReason' || k === 'incompleteDetail') && isFetchStateOnly(rescJ)) continue;
    if (k === 'url') { if (normUrl(rescJ[k]) !== normUrl(mainJ[k])) wait.push('url differs'); continue; }
    if (k === 'criticName' && UNKNOWN_CRITIC.test(String(rescJ[k]))) continue;
    if (isEmpty(mainJ[k])) wait.push(`${k} only on rescued`);
    else if (canon(rescJ[k]) !== canon(mainJ[k]) && !/At$/.test(k)) wait.push(`${k} differs`); // machine timestamps (*At) may differ; main's is kept
  }
  if (wait.length) return { decision: 'wait', reasons: wait };
  if (rescuedBetter.length && !mainBetter.length) return { decision: 'rescued', reasons: rescuedBetter };
  if (rescuedBetter.length) return { decision: 'wait', reasons: ['each side better on a different field', ...rescuedBetter, ...mainBetter] };
  return { decision: 'main', reasons: mainBetter.length ? mainBetter : ['same on every compared field'] };
}

function git(args, opts = {}) {
  const r = runGit('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}
function gitOk(args, opts) {
  const r = git(args, opts);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim().slice(0, 400)}`);
  return r.stdout;
}
// BRO-7541: `git fetch` into a shallow clone fails with "shallow file has changed since we
// read it" when a background gc/maintenance rewrites .git/shallow mid-fetch. That sank the
// 2026-11-12..15 replay runs and made prune refuse every branch. Retry transient failures.
const TRANSIENT_GIT_RE = /shallow file has changed|early EOF|returned error: 5\d\d|Could not resolve host|ETIMEDOUT|RPC failed|Connection (reset|timed out)|remote end hung up|HTTP (429|500|502|503|504)/i;
const isTransientGitError = (msg) => TRANSIENT_GIT_RE.test(String(msg || ''));
function retryFetch(args, opts, { attempts = 3, backoffMs = 2000, run = gitOk, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try { return run(['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', 'fetch', ...args], opts); }
    catch (e) {
      lastErr = e;
      if (i === attempts || !isTransientGitError(e.message)) throw e;
      sleep(backoffMs * i);
    }
  }
  throw lastErr;
}
const netTimeoutMs = () => (Number(process.env.GIT_NET_TIMEOUT_SEC) || 60) * 1000;
const annotate = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

function cliRescue([base, head]) {
  if (process.env.PUSH_RESCUE_DISABLE === '1') return;
  try {
    if (!base || !head) throw new Error('usage: rescue <base> <head>');
    const baseSha = gitOk(['rev-parse', '--verify', `${base}^{commit}`]).trim();
    const headSha = gitOk(['rev-parse', '--verify', `${head}^{commit}`]).trim();
    const adds = recoverableAdds(parseNameStatusZ(gitOk(['diff', '--name-status', '-z', '--no-renames', baseSha, headSha])));
    if (adds.length === 0) return;
    const ref = rescueRefName({ now: Date.now(), runId: [process.env.GITHUB_RUN_ID, process.env.GITHUB_RUN_ATTEMPT].filter(Boolean).join('.'), base: baseSha });
    const r = git(['push', 'origin', `${headSha}:refs/heads/${ref}`], { timeout: netTimeoutMs() });
    const list = adds.slice(0, 20).join(', ') + (adds.length > 20 ? ` (+${adds.length - 20} more)` : '');
    if (r.status === 0) {
      console.log(`::error title=review-texts push failed; new reviews rescued::${annotate(`${adds.length} new review file(s) did not reach main. Saved to branch ${ref}; replay-push-rescue.yml restores them through the ownership gate within the hour: ${list}`)}`);
    } else {
      console.log(`::error title=review-texts push failed; rescue ALSO failed::${annotate(`${adds.length} new review file(s) are lost with this runner (rescue push to ${ref} failed: ${(r.stderr || r.error || '').toString().trim().slice(0, 300)}): ${list}`)}`);
    }
  } catch (e) {
    // Fail-open: the caller is already failing; this must never mask its rc.
    console.log(`::warning::push-rescue: could not check or rescue unpushed review files: ${annotate(String(e && e.message || e).slice(0, 400))}`);
  }
}

function listRescueRefs() {
  const out = gitOk(['ls-remote', 'origin', `refs/heads/${RESCUE_PREFIX}*`], { timeout: netTimeoutMs() });
  return out.split('\n').filter(Boolean).map((l) => {
    const [sha, ref] = l.split('\t');
    return { sha, ref: ref.replace(/^refs\/heads\//, ''), info: parseRescueRef(ref) };
  });
}

function blobAt(rev, p) {
  const r = git(['rev-parse', '--verify', '--quiet', `${rev}:${p}`]);
  return r.status === 0 ? r.stdout.trim() : null;
}

function replayOne({ sha, ref, info }, claimed, mainWins = false) {
  retryFetch(['--no-tags', '--depth=1', 'origin', sha, info.base], { timeout: netTimeoutMs() * 2 });
  const baseTime = Number(gitOk(['show', '-s', '--format=%ct', info.base]).trim());
  // Main's history since the rescue's base, so a path a later commit
  // drained or moved is seen as touched instead of absent.
  retryFetch(['--no-tags', `--shallow-since=${new Date((baseTime - 3600) * 1000).toISOString()}`, 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeout: netTimeoutMs() * 3 });
  const rows = parseNameStatusZ(gitOk(['diff', '--name-status', '-z', '--no-renames', info.base, sha]));
  const adds = recoverableAdds(rows);
  const modified = rows.filter((r) => !(r.status === 'A' && isRecoverablePath(r.path))).map((r) => r.path);
  const mainBlob = new Map();
  const rescueBlob = new Map();
  for (const p of adds) {
    rescueBlob.set(p, blobAt(sha, p));
    const m = blobAt('origin/main', p);
    if (m) mainBlob.set(p, m);
  }
  const since = new Date(baseTime * 1000).toISOString();
  const touched = new Set(adds.filter((p) => !mainBlob.has(p)
    && gitOk(['log', '-1', '--format=%H', `--since=${since}`, 'origin/main', '--', p]).trim() !== ''));
  const show = (rev, p) => { const r = git(['show', `${rev}:${p}`]); return r.status === 0 ? r.stdout : ''; };
  const superseded = (p) => mainSupersedesRescue(show(sha, p), show('origin/main', p));
  // BRO-7549: a conflict a machine can settle (rescued copy holds nothing main lacks) no longer waits for a person.
  // The decision is per path and applies only to main conflicts; kill switch PUSH_RESCUE_AUTO_SETTLE_DISABLE=1.
  // Fails closed: any non-empty value except an explicit off word disables auto-settle.
  const killVal = String(process.env.PUSH_RESCUE_AUTO_SETTLE_DISABLE || '').trim().toLowerCase();
  const autoOn = killVal === '' || ['0', 'false', 'no', 'off'].includes(killVal);
  const verdicts = new Map();
  const verdictFor = (p) => {
    if (!verdicts.has(p)) { try { verdicts.set(p, settleConflict(show('origin/main', p), show(sha, p))); } catch { verdicts.set(p, { decision: 'wait', reasons: ['comparison failed'] }); } }
    return verdicts.get(p);
  };
  const autoMain = (p) => autoOn && verdictFor(p).decision === 'main';
  const plan = replayPlan({ adds, mainBlob, touchedOnMain: touched, rescueBlob, claimed, superseded, mainWins: mainWins || autoMain });
  for (const p of plan.restore) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, gitOk(['show', `${sha}:${p}`]));
    claimed.set(p, rescueBlob.get(p));
  }
  console.log(`push-rescue: ${ref}: restoring ${plan.restore.length}, skipping ${plan.skipped.length}, conflicts ${plan.conflicts.length}${modified.length ? `, ${modified.length} modified/deleted path(s) not replayed` : ''}`);
  for (const x of [...plan.skipped, ...plan.conflicts]) console.log(`  ${plan.conflicts.includes(x) ? 'CONFLICT' : 'skip'} ${x.path}: ${x.why}${x.rescueBlob ? ` (rescue blob ${x.rescueBlob}, main blob ${x.mainBlob}; branch tip ${sha})` : ''}`);
  for (const x of plan.skipped.filter((y) => y.why === AUTO_MAIN_WHY)) {
    try { console.log(`  COMPARE ${x.path}: main[${describeReviewFile(show('origin/main', x.path))}] rescued[${describeReviewFile(show(sha, x.path))}]`); } catch { /* logging only */ }
    console.log(`  AUTO-SETTLE ${x.path}: main wins (${verdictFor(x.path).reasons.join('; ')}); tip ${sha} is archived as a tag before the branch is deleted`);
  }
  for (const x of plan.conflicts) {
    if (x.why === MAIN_CONFLICT_WHY) { const v = verdictFor(x.path); console.log(`  AUTO-SETTLE ${x.path}: ${autoOn ? `waits for a person (${v.decision}: ${v.reasons.join('; ')})` : 'disabled by PUSH_RESCUE_AUTO_SETTLE_DISABLE'}`); }
    try { console.log(`  COMPARE ${x.path}: main[${describeReviewFile(show('origin/main', x.path))}] rescued[${describeReviewFile(show(sha, x.path))}]`); }
    catch (e) { console.log(`  COMPARE ${x.path}: unavailable (${annotate(e.message).slice(0, 80)})`); }
  }
  return { ref, tip: sha, restored: plan.restore, restoredBlobs: Object.fromEntries(plan.restore.map((p) => [p, rescueBlob.get(p)])), skipped: plan.skipped, conflicts: plan.conflicts, keepForHuman: plan.keepForHuman, modified: modified.slice(0, 50) };
}

function cliReplay(args) {
  const manifestPath = (args.find((a) => a.startsWith('--manifest=')) || '').slice('--manifest='.length);
  let mainWins;
  try { mainWins = parseMainWins(process.env.PUSH_RESCUE_MAIN_WINS); } catch (e) {
    console.log(`::error::${annotate(e.message)}`);
    process.exit(2);
  }
  const refs = listRescueRefs();
  const manifest = { refs: [], failed: [] };
  const mw = mainWinsFor(refs, mainWins);
  for (const n of mw.notes) console.log(`::${n.level}::push-rescue: ${annotate(n.msg)}`);
  const claimed = new Map();
  if (refs.length === 0) console.log('push-rescue: no rescue branches');
  for (const entry of refs) {
    if (!entry.info) { console.log(`::warning::push-rescue: ignoring malformed branch ${entry.ref}`); continue; }
    try {
      manifest.refs.push(replayOne(entry, claimed, mw.apply.has(entry.ref)));
    } catch (e) {
      // One bad branch must not block the others; the job fails at the end.
      manifest.failed.push(entry.ref);
      console.log(`::error::push-rescue: could not replay ${entry.ref}: ${annotate(String(e && e.message || e).slice(0, 400))}`);
    }
  }
  // The real cross-show ownership gate, untracked-file mode, strict: deletes
  // any restored review whose URL another show now owns, and exits non-zero
  // on its own crash instead of letting restores through unchecked.
  if (manifest.refs.some((r) => r.restored.length)) {
    const gate = spawnSync(process.execPath, [path.join(__dirname, '..', 'validate-added-review-ownership.js'), '--strict'], { stdio: 'inherit' });
    if (gate.status !== 0) throw new Error(`validate-added-review-ownership.js exited ${gate.status}; refusing to push unchecked restores`);
    for (const r of manifest.refs) {
      r.dropped = r.restored.filter((p) => !fs.existsSync(p));
      r.restored = r.restored.filter((p) => fs.existsSync(p));
      // A dropped file is kept on its branch for a human: the gate can drop
      // both halves of a pair restored in one batch.
      if (r.dropped.length) {
        r.keepForHuman = true;
        console.log(`::warning::push-rescue: ownership gate dropped ${r.dropped.length} restored file(s) from ${r.ref}: ${r.dropped.slice(0, 5).join(', ')}`);
      }
    }
  }
  if (manifestPath) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const n = manifest.refs.reduce((a, r) => a + r.restored.length, 0);
  console.log(`push-rescue: restored ${n} file(s) from ${manifest.refs.length} branch(es), ${manifest.failed.length} failed`);
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `restored=${n}\nbranches=${manifest.refs.length}\nfailed=${manifest.failed.length}\n`);
}

/**
 * Branches safe to delete: nothing kept for a human, and every restored file
 * is on main with exactly the restored content.
 * @param {(p: string) => string|null} blobOnMain
 */
function prunable(manifest, blobOnMain) {
  return (manifest.refs || []).filter((r) => !r.keepForHuman
    && r.restored.every((p) => blobOnMain(p) === (r.restoredBlobs || {})[p]));
}

function cliPrune(args) {
  const manifestPath = (args.find((a) => a.startsWith('--manifest=')) || '').slice('--manifest='.length);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  // depth1-fetch-ok: CI-only (replay-push-rescue.yml), a throwaway checkout (BRO-7789)
  retryFetch(['--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main'], { timeout: netTimeoutMs() * 2 });
  const ok = prunable(manifest, (p) => blobAt('origin/main', p));
  for (const r of ok) {
    // Delete only the tip this replay read (a branch that moved since is kept for the next run).
    // A branch main_wins (or auto-settle) overrode is the only copy of those files: tag its tip first.
    if ((r.skipped || []).some((x) => ARCHIVE_WHYS.has(x.why))) {
      const tag = `refs/tags/push-rescue-archive/${r.ref.slice(RESCUE_PREFIX.length)}`;
      const t = git(['push', 'origin', `${r.tip}:${tag}`], { timeout: netTimeoutMs() });
      if (t.status !== 0 && !/already exists/.test(t.stderr || '')) {
        console.log(`::warning::push-rescue: kept ${r.ref}: could not archive it as ${tag} (${annotate((t.stderr || '').trim().slice(0, 200))})`);
        continue;
      }
      console.log(`push-rescue: archived ${r.ref} at ${r.tip} as ${tag}`);
    }
    const lease = r.tip ? [`--force-with-lease=refs/heads/${r.ref}:${r.tip}`] : [];
    const d = git(['push', ...lease, 'origin', `:refs/heads/${r.ref}`], { timeout: netTimeoutMs() });
    if (d.status !== 0) {
      console.log(`::warning::push-rescue: kept ${r.ref}: delete refused (${annotate((d.stderr || '').trim().slice(0, 200))}); the next run retries`);
      continue;
    }
    console.log(`push-rescue: deleted ${r.ref}${r.modified && r.modified.length ? ` (its ${r.modified.length} modified/deleted path(s) were not replayed: ${r.modified.slice(0, 5).join(', ')})` : ''}`);
  }
  for (const r of (manifest.refs || []).filter((x) => !ok.includes(x))) {
    const why = r.keepForHuman
      ? [r.conflicts && r.conflicts.length ? `${r.conflicts.length} conflicting path(s) (${r.conflicts.slice(0, 3).map((c) => c.path).join(', ')})` : '',
        r.dropped && r.dropped.length ? `${r.dropped.length} file(s) the ownership gate dropped` : ''].filter(Boolean).join('; ')
      : 'a restored file is not on main yet; the next run retries';
    console.log(`::warning::push-rescue: kept ${r.ref}: ${why}. Inspect: git log -1 --stat origin/${r.ref}`);
  }
  // A branch only a person can settle fails the run every hour (warning severity,
  // digest repeat-failure row) instead of sitting behind a green check.
  const human = (manifest.refs || []).filter((r) => r.keepForHuman);
  if (human.length) {
    console.log(`::error::push-rescue: ${human.length} rescue branch(es) need a person: ${human.map((r) => r.ref).join(', ')}`);
    for (const r of human.filter(onlyMainConflicts)) {
      console.log(`::notice::push-rescue: if the owner picks main's copy for ${r.ref}, dispatch replay-push-rescue.yml with main_wins=${r.ref}@${r.tip}`);
    }
    process.exitCode = 1;
  }
}

module.exports = { RESCUE_PREFIX, isRecoverablePath, parseNameStatusZ, recoverableAdds, rescueRefName, parseRescueRef, replayPlan, prunable, mainSupersedesRescue, parseMainWins, mainWinsFor, onlyMainConflicts, MAIN_CONFLICT_WHY, AUTO_MAIN_WHY, describeReviewFile, reviewFacts, settleConflict, retryFetch, isTransientGitError };

if (require.main === module) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'rescue') cliRescue(rest);
  else if (cmd === 'replay') cliReplay(rest);
  else if (cmd === 'prune') cliPrune(rest);
  else {
    console.error('usage: push-rescue.js rescue <base> <head> | replay [--manifest=F] | prune --manifest=F');
    process.exit(2);
  }
}
