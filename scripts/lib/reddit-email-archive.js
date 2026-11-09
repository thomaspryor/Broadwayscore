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

const SENDER = 'updates@broadwayscorecard.com';
const LEADS = ['Reddit post ready', 'Updated Reddit post', 'Still ready to post'];
// Mirrors buildSubject(): `${lead}: ${showTitle} (${score}/100) for r/${subreddit}`.
const SUBJECT_RE = new RegExp(`^(${LEADS.join('|')}): (.+) \\((\\d{1,3})/100\\) for r/([A-Za-z0-9_]+)$`);

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GMAIL = 'https://gmail.googleapis.com/gmail/v1/users/me';
// Gmail search for the candidates. The exact filtering happens in code below.
const LIST_QUERY = `in:inbox from:${SENDER} (subject:"Reddit post" OR subject:"Still ready to post")`;
const MAX_MESSAGES = 500;
const FETCH_CONCURRENCY = 8;

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
    groups.get(key).push({ id: m.id, at: Number(m.internalDate) || 0 });
  }
  const archive = [];
  const keep = [];
  for (const list of groups.values()) {
    // Newest first; the id breaks a same-millisecond tie so the choice is stable.
    list.sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : -1));
    keep.push(list[0].id);
    for (const old of list.slice(1)) archive.push(old.id);
  }
  return { archive, keep, groups: groups.size };
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
    const reason = body && body.error && (body.error.status || (body.error.errors && body.error.errors[0] && body.error.errors[0].reason)) || '';
    if (res.status === 403 && /insufficient|PERMISSION_DENIED/i.test(String(reason) + JSON.stringify((body && body.error && body.error.message) || ''))) {
      throw new GmailScopeError('The Gmail key is read-only. Archiving needs the renewed key (gmail-reauth.yml, mode=link).');
    }
    throw new Error(`Gmail ${init.method || 'GET'} ${path.split('?')[0]} failed: HTTP ${res.status} ${String(reason).slice(0, 60)}`);
  }
  return body;
}

/** Inbox candidates with their Subject / From / date, newest first. */
async function listCandidates(fetchImpl, token) {
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
      const q = new URLSearchParams({ format: 'metadata' });
      q.append('metadataHeaders', 'Subject');
      q.append('metadataHeaders', 'From');
      const m = await gmailJson(fetchImpl, token, `/messages/${id}?${q}`);
      const h = (name) => ((m.payload && m.payload.headers) || []).find((x) => x.name.toLowerCase() === name.toLowerCase());
      return { id, subject: (h('Subject') || {}).value || '', from: (h('From') || {}).value || '', internalDate: m.internalDate };
    }));
    out.push(...got);
  }
  return out;
}

/**
 * Archive every superseded Reddit draft email in the inbox.
 * @param {{ env?: object, fetchImpl?: Function, dryRun?: boolean, log?: Function }} opts
 * @returns {Promise<{ candidates:number, groups:number, archived:number, dryRun:boolean }>}
 */
async function sweep({ env = process.env, fetchImpl = fetch, dryRun = false, log = console.log } = {}) {
  const { token } = await accessToken(env, fetchImpl);
  const messages = await listCandidates(fetchImpl, token);
  const plan = planArchive(messages);
  log(`${messages.length} Reddit draft email(s) in the inbox across ${plan.groups} draft(s); ${plan.archive.length} superseded`);
  if (plan.archive.length && !dryRun) {
    for (let i = 0; i < plan.archive.length; i += 1000) {
      // batchModify takes at most 1000 ids. Removing a label twice is a no-op, so a retry is safe.
      await gmailJson(fetchImpl, token, '/messages/batchModify', {
        method: 'POST',
        body: JSON.stringify({ ids: plan.archive.slice(i, i + 1000), removeLabelIds: ['INBOX'] }),
      });
    }
  }
  return { candidates: messages.length, groups: plan.groups, archived: dryRun ? 0 : plan.archive.length, wouldArchive: plan.archive.length, dryRun };
}

module.exports = { SENDER, LEADS, LIST_QUERY, parseDraftSubject, isOurSender, planArchive, sweep, listCandidates, GmailScopeError };
