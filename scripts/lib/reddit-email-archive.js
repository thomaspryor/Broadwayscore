/**
 * reddit-email-archive.js: pick the superseded Reddit draft emails out of the
 * owner's Gmail inbox and archive them (owner ask 2026-11-09: "whenever a new
 * draft Reddit post is emailed that is updated from a previous one, make sure
 * the old one is archived").
 *
 * scripts/send-reddit-post-email.js sends one email per draft event, with the
 * subject `<lead>: <show> (<score>/100) for r/<subreddit>` (buildSubject in
 * reddit-post-email.js). The same draft can therefore have a "ready" email, one
 * or more "Updated" emails and a "Still ready" reminder in the inbox at once.
 * Only the newest is useful, since each later one carries the redrafted text.
 *
 * Design: a SWEEP, not a per-send hook. It lists the inbox, groups the emails
 * by (show, subreddit), keeps the newest of each group and archives the rest.
 * Re-running changes nothing, a missed run is caught by the next one, and no
 * Resend/Gmail message id has to be carried between the sender and this.
 *
 * Archive = remove the INBOX label. Nothing is trashed, deleted or marked
 * read; the mail stays searchable and the label can be put back. The token has
 * to carry gmail.modify (Google offers nothing narrower for message labels), so
 * this module only ever sends removeLabelIds ['INBOX'] and only for ids that
 * matched the exact subject template from the exact sender.
 */

'use strict';

const { SUBJECT_LEADS, SHOW_HEADER } = require('./reddit-post-email');

const SENDER = 'updates@broadwayscorecard.com';
const LEADS = Object.values(SUBJECT_LEADS);
const MODIFY_SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
// Mirrors buildSubject(): `${lead}: ${showTitle} (${score}/100) for r/${subreddit}`.
const SUBJECT_RE = new RegExp(`^(${LEADS.join('|')}): (.+) \\((\\d{1,3})/100\\) for r/([A-Za-z0-9_]+)$`);

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Gmail search for the candidates. The exact filtering happens in code below.
const LIST_QUERY = `in:inbox from:${SENDER} (subject:"Reddit post" OR subject:"Still ready to post")`;
const MAX_MESSAGES = 500;
const FETCH_CONCURRENCY = 8;
// The sweep runs seconds after Resend accepted the last email, and Gmail may not
// have it yet. Wait up to this long for the emails the caller just sent.
const DEFAULT_WAIT_MS = 120000;
const POLL_MS = 10000;

/** { lead, showTitle, score, subreddit } for one of our draft subjects, else null. */
function parseDraftSubject(subject) {
  const m = SUBJECT_RE.exec(String(subject || '').trim());
  if (!m) return null;
  return { lead: m[1], showTitle: m[2], score: Number(m[3]), subreddit: m[4].toLowerCase() };
}

/** True when a From header is our sender (display name and brackets allowed). */
function isOurSender(from) {
  return new RegExp(`(^|[<\\s])${SENDER.replace(/\./g, '\\.')}>?\\s*$`, 'i').test(String(from || '').trim());
}

/**
 * Which message ids to archive.
 * @param {Array<{id:string, subject:string, from:string, internalDate:number|string}>} messages inbox messages
 * @returns {{ archive: string[], keep: string[], groups: number }}
 */
function planArchive(messages) {
  const groups = new Map();
  for (const m of messages || []) {
    if (!m || !isOurSender(m.from)) continue;
    const p = parseDraftSubject(m.subject);
    if (!p) continue;
    const key = `${p.showTitle.toLowerCase()}\u0000${p.subreddit}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ id: m.id, at: Number(m.internalDate) || 0, showId: String(m.showId || '').trim() });
  }
  // One title can belong to more than one show (a transfer, a revival). When the stamped
  // show ids in a group disagree, handle each show on its own and leave unstamped (older)
  // emails alone, since there is no telling which show they belong to.
  const sets = [];
  for (const list of groups.values()) {
    const ids = new Set(list.map((x) => x.showId).filter(Boolean));
    if (ids.size <= 1) { sets.push(list); continue; }
    for (const id of ids) sets.push(list.filter((x) => x.showId === id));
  }
  const archive = [];
  const keep = [];
  for (const list of sets) {
    // Newest first; the id breaks a same-millisecond tie so the choice is stable.
    list.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
    keep.push(list[0].id);
    for (const old of list.slice(1)) archive.push(old.id);
  }
  return { archive, keep, groups: sets.length };
}

class GmailScopeError extends Error {}

async function accessToken(env, fetchImpl) {
  const { GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN } = env;
  if (!GMAIL_CLIENT_ID || !GMAIL_CLIENT_SECRET || !GMAIL_REFRESH_TOKEN) {
    throw new Error('GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN not set');
  }
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    signal: AbortSignal.timeout(20000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: GMAIL_CLIENT_ID, client_secret: GMAIL_CLIENT_SECRET, refresh_token: GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token' }).toString(),
  });
  let tok = {};
  try { tok = await res.json(); } catch { /* handled below */ }
  // Error code only: the body can echo the request.
  if (!res.ok || !tok.access_token) throw new Error(`Gmail token refresh refused: HTTP ${res.status} ${String(tok.error || '').slice(0, 60)}`);
  return { token: tok.access_token, scope: String(tok.scope || '') };
}

async function gmailJson(fetchImpl, token, path, init = {}) {
  const res = await fetchImpl(`${GMAIL}${path}`, {
    ...init,
    signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
  });
  if (res.status === 204) return {};
  let body = {};
  try { body = await res.json(); } catch { /* empty body */ }
  if (!res.ok) {
    const err = (body && body.error) || {};
    const reason = (err.errors && err.errors[0] && err.errors[0].reason) || err.status || '';
    // A rate limit is also a 403 with status PERMISSION_DENIED, so the status alone
    // proves nothing: only Google's own "insufficient scopes" reason counts.
    if (res.status === 403 && (reason === 'insufficientPermissions' || /insufficient authentication scopes/i.test(String(err.message || '')))) {
      throw new GmailScopeError('The Gmail key is read-only. Archiving needs the renewed key (gmail-reauth.yml, mode=link).');
    }
    throw new Error(`Gmail ${init.method || 'GET'} ${path.split('?')[0]} failed: HTTP ${res.status} ${String(reason).slice(0, 60)}`);
  }
  return body;
}

/** Inbox candidates with their Subject / From / show id / date, newest first. `cache` (id -> record) skips refetching a message already read. */
async function listCandidates(fetchImpl, token, cache = new Map()) {
  const ids = [];
  let pageToken = '';
  do {
    const q = new URLSearchParams({ q: LIST_QUERY, maxResults: '100' });
    if (pageToken) q.set('pageToken', pageToken);
    const page = await gmailJson(fetchImpl, token, `/messages?${q}`);
    for (const m of page.messages || []) ids.push(m.id);
    pageToken = page.nextPageToken || '';
  } while (pageToken && ids.length < MAX_MESSAGES);

  const out = [];
  for (let i = 0; i < ids.length; i += FETCH_CONCURRENCY) {
    const chunk = ids.slice(i, i + FETCH_CONCURRENCY);
    const got = await Promise.all(chunk.map(async (id) => {
      if (cache.has(id)) return cache.get(id);
      const q = new URLSearchParams({ format: 'metadata' });
      for (const name of ['Subject', 'From', SHOW_HEADER]) q.append('metadataHeaders', name);
      const m = await gmailJson(fetchImpl, token, `/messages/${id}?${q}`);
      const h = (name) => ((m.payload && m.payload.headers) || []).find((x) => String(x.name).toLowerCase() === name.toLowerCase());
      const rec = { id, subject: (h('Subject') || {}).value || '', from: (h('From') || {}).value || '', showId: (h(SHOW_HEADER) || {}).value || '', internalDate: m.internalDate };
      cache.set(id, rec);
      return rec;
    }));
    out.push(...got);
  }
  return out;
}

/**
 * Archive every superseded Reddit draft email in the inbox.
 * @param {object} opts
 * @param {object} [opts.env]
 * @param {Function} [opts.fetchImpl]
 * @param {boolean} [opts.dryRun] list and plan only; the read-only key is enough for this
 * @param {string[]} [opts.expectSubjects] subjects just sent; wait for them to reach the inbox first
 * @param {number} [opts.waitMs]
 * @param {Function} [opts.sleep]
 * @param {Function} [opts.log]
 * @returns {Promise<{ candidates:number, groups:number, archived:number, wouldArchive:number, dryRun:boolean, missing:string[] }>}
 */
async function sweep({ env = process.env, fetchImpl = fetch, dryRun = false, expectSubjects = [], waitMs = DEFAULT_WAIT_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), log = console.log } = {}) {
  const { token, scope } = await accessToken(env, fetchImpl);
  const cache = new Map();
  let messages = await listCandidates(fetchImpl, token, cache);
  // Only a subject match is checked, so a repeat of an earlier subject (same score, a
  // resend) ends the wait early; the next sweep then archives that one's predecessor.
  const missingNow = () => expectSubjects.filter((subj) => !messages.some((m) => m.subject === subj));
  for (let waited = 0; missingNow().length && waited < waitMs; waited += POLL_MS) {
    await sleep(POLL_MS);
    messages = await listCandidates(fetchImpl, token, cache);
  }
  const missing = missingNow();
  // Not fatal: the older emails stay one more round and the next sweep archives them.
  if (missing.length) log(`::warning::${missing.length} just-sent email(s) not in the inbox after ${Math.round(waitMs / 1000)}s; their predecessors are archived on the next sweep`);

  const plan = planArchive(messages);
  log(`${messages.length} Reddit draft email(s) in the inbox across ${plan.groups} draft(s); ${plan.archive.length} superseded`);
  // The refresh response names the granted scopes. A key without gmail.modify cannot
  // write, so say so before trying instead of after a 403.
  if (plan.archive.length && !dryRun && scope && !scope.split(/\s+/).includes(MODIFY_SCOPE)) {
    throw new GmailScopeError('The Gmail key is read-only. Archiving needs the renewed key (gmail-reauth.yml, mode=link).');
  }
  if (plan.archive.length && !dryRun) {
    for (let i = 0; i < plan.archive.length; i += 1000) {
      // batchModify takes at most 1000 ids. Removing a label twice is a no-op, so a retry is safe.
      await gmailJson(fetchImpl, token, '/messages/batchModify', {
        method: 'POST',
        body: JSON.stringify({ ids: plan.archive.slice(i, i + 1000), removeLabelIds: ['INBOX'] }),
      });
    }
  }
  return { candidates: messages.length, groups: plan.groups, archived: dryRun ? 0 : plan.archive.length, wouldArchive: plan.archive.length, dryRun, missing };
}

module.exports = { SENDER, LEADS, MODIFY_SCOPE, SHOW_HEADER, MAX_MESSAGES, LIST_QUERY, parseDraftSubject, isOurSender, planArchive, sweep, listCandidates, GmailScopeError };
