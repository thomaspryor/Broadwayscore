'use strict';
/**
 * resend-draft-upsert.js — create-or-update a Resend broadcast DRAFT keyed by
 * its deterministic name, with Resend itself as the dedup source of truth
 * (BRO-3494, BRO-3493).
 *
 * A send-lock only blocks truly concurrent runs. A re-run after the lock
 * releases (workflow retry, second workflow_dispatch the same week, a runner
 * that died before its local tracker write was committed) would otherwise
 * POST a second draft. Checking Resend before creating closes that gap with no
 * local tracker file: whatever a prior run managed to create is visible here.
 *
 * Same contract as scripts/newsletter/create-broadcast-draft.mjs's
 * lookupByName(): exactly one draft with the name -> PATCH it; any non-draft
 * broadcast with the name (sent/queued/scheduled) -> refuse; more than one
 * draft -> throw rather than guess. This module never calls
 * POST /broadcasts/{id}/send (CLAUDE.md §17).
 */

const RESEND_BROADCASTS_URL = 'https://api.resend.com/broadcasts';
// Resend's list endpoints page (default 20, max 100). Ask for the max so a
// busy week (opening-night drafts + newsletter + fantasy) cannot push this
// week's draft off the first page; lists are newest-first.
const RESEND_BROADCASTS_LIST_URL = `${RESEND_BROADCASTS_URL}?limit=100`;

/**
 * Pure: split a Resend GET /broadcasts list into the single existing draft
 * and any already-sent/scheduled broadcasts carrying `name`.
 * `ignoreStatuses` names non-draft statuses that neither block nor get
 * reused. Default none: a broadcast the owner cancelled counts as handled,
 * so fantasy/newsletter never redraft a week the owner chose not to send.
 * Opening night passes 'cancelled' because its tracker re-queues a
 * cancelled show on purpose (scripts/lib/broadcast-state.js).
 * `notBefore` (ISO date/time) ignores broadcasts Resend created before it: a
 * revival shares its title with the earlier production, so the earlier
 * production's sent email must not be adopted as this one's (BRO-3493
 * retro-review, BRO-5261). A broadcast with no created_at still counts.
 * @returns {{ draft: object|null, sent: object[] }}
 */
function splitBroadcastsByName(list, name, { ignoreStatuses = [], notBefore = null } = {}) {
  const all = (list && Array.isArray(list.data)) ? list.data : [];
  const ignore = new Set(ignoreStatuses);
  const floorMs = notBefore ? Date.parse(notBefore) : NaN;
  const tooOld = (b) => Number.isFinite(floorMs) && b.created_at && Date.parse(b.created_at) < floorMs;
  const named = all.filter((b) => b && b.name === name && !ignore.has(b.status) && !tooOld(b));
  const drafts = named.filter((b) => b.status === 'draft');
  const sent = named.filter((b) => b.status !== 'draft');
  if (drafts.length > 1) {
    throw new Error(`${drafts.length} draft broadcasts named "${name}" exist; refusing to guess which to update. Resolve in the Resend UI.`);
  }
  return { draft: drafts[0] || null, sent };
}

/**
 * Minimal Resend JSON client. Throws on non-2xx.
 * @param {string} apiKey
 * @param {Function} [fetchImpl] injectable for tests
 */
// Each call ends well inside the 5-minute send lock (send-lock.js
// DEFAULT_TTL_MS), so a hung request cannot outlive the lock that serializes
// the lookup and the create. Same 60s the newsletter client uses.
const REQUEST_TIMEOUT_MS = 60_000;

function makeResendRequest(apiKey, fetchImpl = fetch, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return async function request(method, url, payload) {
    const opt = {
      method,
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (payload !== undefined) opt.body = JSON.stringify(payload);
    const res = await fetchImpl(url, opt);
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = text; }
    if (!res.ok) {
      throw new Error(`Resend ${res.status} on ${method}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
    }
    return body;
  };
}

/**
 * Look up `payload.name` in Resend, then PATCH the existing draft, create a
 * new one, or refuse because the broadcast already went out.
 * @param {{ payload: object, request: Function, ignoreStatuses?: string[], notBefore?: string|null }} opts  payload.name is required
 * @returns {Promise<{ action: 'created'|'updated'|'skipped-sent', id: string|null, sentStatus?: string }>}
 */
async function upsertBroadcastDraft({ payload, request, ignoreStatuses = [], notBefore = null }) {
  if (!payload || !payload.name) throw new Error('upsertBroadcastDraft: payload.name is required (it is the dedup key)');
  const list = await request('GET', RESEND_BROADCASTS_LIST_URL);
  const { draft, sent } = splitBroadcastsByName(list, payload.name, { ignoreStatuses, notBefore });
  if (sent.length) {
    return { action: 'skipped-sent', id: sent[0].id || null, sentStatus: sent[0].status };
  }
  if (draft) {
    await request('PATCH', `${RESEND_BROADCASTS_URL}/${draft.id}`, payload);
    return { action: 'updated', id: draft.id };
  }
  const created = await request('POST', RESEND_BROADCASTS_URL, payload);
  return { action: 'created', id: (created && created.id) || null };
}

module.exports = {
  RESEND_BROADCASTS_URL,
  RESEND_BROADCASTS_LIST_URL,
  REQUEST_TIMEOUT_MS,
  splitBroadcastsByName,
  makeResendRequest,
  upsertBroadcastDraft,
};
