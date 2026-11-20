'use strict';
/**
 * The opening-night lane's manual-URL inbox (BRO-7741). On a night the lane holds a show's lease, a review the lane's
 * discovery missed (Blue Man Group 2026: TheaterMania's headline did not match the show title) used to need a full
 * lane rollback, because every other writer reverts its edits to a leased show. Now a person (or ingest-urls.yml,
 * which routes a leased show's URLs here) appends the URL to this inbox; the running lane reads it every pass,
 * fetches and scores the page, and publishes it as a lane row with provenance source 'manual'.
 *
 * Storage: its own branch `opening-night-lane-inbox`, one JSON file, written with lease-store.casTransition
 * (compare-and-swap, never a force push). The state is lease-shaped ({leases: {id: entry}}) so casTransition's
 * expiry sweep prunes old entries for free: each entry expires 72 h after it was added.
 *
 * Entry: {holder:'manual-inbox', show, url, outletId?, critic?, force?, addedAt, addedBy, acquiredAt, heartbeatAt,
 *   expiresAt, status?, statusAt?, reason?}. No status = waiting for the lane. Status is written back by the lane
 *   (queued, published, failed, rejected, already-in, held-copy) or by the drain after the lane ends (drained).
 *   held-copy (BRO-7891): a syndicated copy whose original is on the site; it never goes on the site itself, so the
 *   drain and the sweep leave it alone (re-sending it to ingest-urls would be futile).
 *
 * Pure transitions (addEntries, markStatus) are tested on their own; the git wrappers reuse lease-store.
 */
const crypto = require('crypto');
const { execFile } = require('child_process');

const INBOX_BRANCH = 'opening-night-lane-inbox';
const INBOX_FILE = 'data/opening-night/inbox.json';
const HOLDER = 'manual-inbox';
const ENTRY_TTL_MS = 72 * 60 * 60 * 1000;
// A status the lane or the drain will never act on again.
const FINAL_STATUSES = Object.freeze(['published', 'failed', 'rejected', 'already-in', 'held-copy', 'drained']);
// BRO-7891: outcomes a person must hear about the same night (their link did not go live).
const ALERT_STATUSES = Object.freeze(['failed', 'rejected']);
const STATUSES = Object.freeze(['queued', ...FINAL_STATUSES]);
const GIT_TIMEOUT_MS = 20000;

const iso = (now) => new Date(typeof now === 'function' ? now() : (now === undefined ? Date.now() : now)).toISOString();

/** A stable form of a URL for de-duplicating inbox entries (host lower-cased, no fragment, no trailing slash). */
function normalizeUrl(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
  return `${u.hostname}${u.pathname.replace(/\/+$/, '')}${u.search}`;
}

function entryId(show, url) {
  const norm = normalizeUrl(url);
  if (!norm) return null;
  return `${show}|${crypto.createHash('sha1').update(norm).digest('hex').slice(0, 12)}`;
}

/**
 * Add URLs for one show. Pure. A URL already in the inbox for that show is reported as a duplicate, not re-added
 * (unless its earlier entry failed, was rejected or was drained: then it is re-queued, so a person can retry with `force`).
 * @param lines [{url, outletId?, critic?, force?}]
 * @returns {{ok, state, added: [id], duplicates: [id], invalid: [url]}}
 */
function addEntries(state, { show, lines = [], addedBy = 'unknown', now, ttlMs = ENTRY_TTL_MS } = {}) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(String(show || ''))) return { ok: false, reason: 'bad-show', detail: `bad show id "${show}"` };
  const next = { ...state, leases: { ...((state && state.leases) || {}) } };
  const at = iso(now);
  const expiresAt = new Date(Date.parse(at) + ttlMs).toISOString();
  const added = []; const duplicates = []; const invalid = [];
  for (const line of lines) {
    const id = entryId(show, line && line.url);
    if (!id) { invalid.push(String((line && line.url) || '')); continue; }
    const prior = next.leases[id];
    // A failed, rejected or drained entry is re-queued (a retry with force; a drained URL whose ingest never landed).
    if (prior && !(prior.status === 'failed' || prior.status === 'rejected' || prior.status === 'drained')) { duplicates.push(id); continue; }
    next.leases[id] = {
      holder: HOLDER, show, url: String(line.url).trim(),
      ...(line.outletId ? { outletId: String(line.outletId) } : {}),
      ...(line.critic ? { critic: String(line.critic) } : {}),
      ...(line.force ? { force: true } : {}),
      addedAt: at, addedBy: String(addedBy), acquiredAt: at, heartbeatAt: at, expiresAt,
    };
    added.push(id);
  }
  if (!added.length && !duplicates.length) return { ok: false, reason: 'nothing-valid', detail: `no valid URL among ${lines.length} line(s)`, invalid };
  return { ok: true, state: next, added, duplicates, invalid };
}

/**
 * Record what happened to entries. Pure. Unknown ids are ignored (the entry expired or was never there). A final
 * status is never overwritten by 'queued' (a slow write must not reopen a published entry).
 * @param updates [{id, addedAt?, status, reason?}]: with addedAt, applied only to that generation of the entry
 */
function markStatus(state, { updates = [], now } = {}) {
  const next = { ...state, leases: { ...((state && state.leases) || {}) } };
  const at = iso(now);
  const applied = [];
  for (const u of updates) {
    if (!u || !STATUSES.includes(u.status)) continue;
    const prior = next.leases[u.id];
    if (!prior) continue;
    if (u.addedAt && prior.addedAt && u.addedAt !== prior.addedAt) continue; // about an earlier generation (re-added since)
    if (u.status === 'queued' && FINAL_STATUSES.includes(prior.status)) continue;
    next.leases[u.id] = { ...prior, status: u.status, statusAt: at, ...(u.reason ? { reason: String(u.reason).slice(0, 300) } : {}),
      ...(u.status === 'drained' ? { drainCount: (prior.drainCount || 0) + 1 } : {}) };
    applied.push(u.id);
  }
  return { ok: true, state: next, applied };
}

/** The entries for one show, oldest first, each with its id. */
function entriesFor(state, show) {
  return Object.entries((state && state.leases) || {})
    .filter(([, e]) => e && e.holder === HOLDER && e.show === show)
    .map(([id, e]) => ({ id, ...e }))
    .sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
}

/**
 * BRO-7891: the alert for a lane status write, or null. One condition per entry generation (id@addedAt), so the router's
 * cooldown on an earlier generation never silences a URL re-added (say with --force) after its rejection.
 * @param update {id, addedAt?, status, reason?, url?, show?}
 */
function inboxAlertFor(update) {
  if (!update || !ALERT_STATUSES.includes(update.status)) return null;
  const show = update.show || String(update.id || '').split('|')[0];
  const url = update.url || update.id;
  const why = update.reason ? `: ${String(update.reason).slice(0, 300)}` : '';
  const fix = update.status === 'rejected'
    ? `If it is tonight's review, add it again with --force: node scripts/opening-night-lane-inbox.js add --show=${show} --url='${url}' --force`
    : `The drain sends it to ingest-urls.yml after the lane ends; to retry now: node scripts/opening-night-lane-inbox.js add --show=${show} --url='${url}'`;
  return {
    conditionKey: `opening-night-lane-inbox:${update.id}@${update.addedAt || ''}`,
    title: `Lane inbox URL ${update.status} for ${show}`,
    description: `The opening-night lane ${update.status === 'rejected' ? 'rejected' : 'could not publish'} ${url}${why}. ${fix}`,
  };
}

/** Entries the lane should still act on: no final status. */
const isOpen = (e) => !e.status || !FINAL_STATUSES.includes(e.status);

function storeOpts(opts = {}) {
  return { branch: INBOX_BRANCH, file: INBOX_FILE, message: 'opening-night lane inbox', ...opts };
}

/** Add URLs (sync git, compare-and-swap). opts: {repoDir, remote?, now?}. */
function addSync(opts, args) {
  const store = require('./lease-store');
  return store.casTransition(storeOpts(opts), (s) => addEntries(s, { ...args, now: opts.now }));
}

/** Write statuses back (sync git, compare-and-swap). */
function markSync(opts, updates) {
  const store = require('./lease-store');
  return store.casTransition(storeOpts(opts), (s) => markStatus(s, { updates, now: opts.now }));
}

/** Read the whole inbox state (sync git). Throws on a corrupt state. */
function readSync(opts) {
  return require('./lease-store').readRemote(storeOpts(opts)).state;
}

function gitAsync(repoDir, args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: repoDir, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout, stderr) => {
      if (err) { err.stderr = String(stderr || ''); return reject(err); }
      resolve(String(stdout).trim());
    });
  });
}

/**
 * The lane's per-pass read: async, so a slow fetch never blocks the publish timers. Its own ref namespace, so it never
 * races lease-store's fetch into refs/opening-night-lane/*. A missing branch is an empty inbox.
 * @returns {Promise<entry[]>} the show's entries (all statuses; the caller filters)
 */
async function readForShow({ repoDir, remote = 'origin', show }) {
  const listed = await gitAsync(repoDir, ['ls-remote', '--heads', remote, `refs/heads/${INBOX_BRANCH}`]);
  if (!listed) return [];
  const ref = `refs/opening-night-lane-inbox-read/${INBOX_BRANCH}`;
  await gitAsync(repoDir, ['fetch', '--no-tags', '--quiet', remote, `+refs/heads/${INBOX_BRANCH}:${ref}`]);
  let text;
  try { text = await gitAsync(repoDir, ['show', `${ref}:${INBOX_FILE}`]); } catch { return []; }
  const parsed = JSON.parse(text);
  if (!parsed || typeof parsed.leases !== 'object' || !parsed.leases) throw new Error('inbox state has no leases object');
  return entriesFor(parsed, show);
}

module.exports = {
  INBOX_BRANCH, INBOX_FILE, HOLDER, ENTRY_TTL_MS, FINAL_STATUSES, STATUSES, ALERT_STATUSES,
  normalizeUrl, entryId, addEntries, markStatus, entriesFor, isOpen, inboxAlertFor, addSync, markSync, readSync, readForShow,
};
