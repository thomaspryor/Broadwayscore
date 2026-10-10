/**
 * Shared Plans checks for the live UGC round-trip (BRO-4481).
 *
 * Called from scripts/test-ugc-roundtrip.mjs with two real signed-in test users.
 * Mirrors the local SQL tests (tests/sql/plan-shares.test.sql) against the LIVE
 * project, through PostgREST exactly as the web and iOS clients call it.
 *
 * Kept in its own module because test-ugc-roundtrip.mjs runs main() on import,
 * which made its logic impossible to unit-test. Everything here takes its I/O
 * (`rest`, `check`) as arguments; tests/unit/plan-shares-roundtrip.test.mjs
 * drives it against a fake PostgREST.
 */

import { NOT_URGENT } from './ugc-roundtrip-urgency.mjs';

export const TOKEN_RE = /^[a-f0-9]{32}$/;
export const ENTRY_KEYS = ['logged', 'planned_date', 'show_id'];
export const PAYLOAD_KEYS = ['entries', 'name', 'showBooked', 'showUnbooked'];

const FUTURE_SHOW = 'wicked-2003';
const UNDATED_SHOW = 'the-lion-king-1997';

function isoDatePlus(base, days) {
  const d = new Date(base.getTime() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/** True when PostgREST says the table/function isn't in the schema yet. */
export function isMissingRelation(res) {
  return res.status === 404 || /PGRST20[25]|does not exist|Could not find the (table|function)/i.test(res.text || '');
}

/**
 * Keys or text that must never appear in a public payload. Returns a list of
 * problems (empty = clean). Exported so the unit test can prove it bites.
 */
export function payloadProblems(payload, { forbiddenText = [] } = {}) {
  const problems = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['payload is not an object'];
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(PAYLOAD_KEYS)) problems.push(`top-level keys ${keys.join(',')}`);
  for (const e of Array.isArray(payload.entries) ? payload.entries : []) {
    const ek = Object.keys(e).sort();
    if (JSON.stringify(ek) !== JSON.stringify(ENTRY_KEYS)) problems.push(`entry keys ${ek.join(',')}`);
  }
  const text = JSON.stringify(payload);
  for (const needle of forbiddenText) {
    if (needle && text.includes(needle)) problems.push(`payload contains "${needle}"`);
  }
  return problems;
}

/**
 * @param {object} ctx
 * @param {(method, path, token, body?, prefer?) => Promise<{status, ok, json, text}>} ctx.rest
 * @param {(name, ok, detail?) => boolean} ctx.check
 * @param {string} ctx.anonKey   used as the bearer for anonymous calls
 * @param {{id: string}} ctx.userA
 * @param {string} ctx.tokenA
 * @param {string} ctx.tokenB
 * @param {string} ctx.pastUnloggedShowId  a show A has with a PAST date and no
 *        matching review (the round-trip's watchlist row) — must stay private
 * @param {Date} [ctx.now]
 * @returns {Promise<{skipped: boolean}>}
 */
export async function runPlanSharesChecks(ctx) {
  const { rest, check, anonKey, userA, tokenA, tokenB, pastUnloggedShowId } = ctx;
  const now = ctx.now || new Date();

  const probe = await rest('GET', 'plan_shares?select=user_id&limit=1', tokenA);
  if (isMissingRelation(probe)) {
    console.log('plan_shares: not in this project yet — skipped (apply supabase/migrations/20261001_plan_shares.sql)');
    return { skipped: true };
  }

  // Two more plans for A: one booked a month out, one not yet booked.
  await rest('POST', 'watchlist', tokenA, { user_id: userA.id, show_id: FUTURE_SHOW, planned_date: isoDatePlus(now, 30), time_slot: 'evening', curtain_time: '19:00:00' });
  await rest('POST', 'watchlist', tokenA, { user_id: userA.id, show_id: UNDATED_SHOW });

  // Create, with a weak token the server must ignore.
  const created = await rest('POST', 'plan_shares', tokenA, {
    user_id: userA.id, display_name: '  Roundtrip  ', token: '0'.repeat(32),
  });
  const row = Array.isArray(created.json) ? created.json[0] : null;
  check('plans: owner creates a share', created.status === 201 && !!row, `HTTP ${created.status} ${created.ok ? '' : created.text.slice(0, 160)}`, NOT_URGENT);
  if (!row) return { skipped: false };
  const tokenOld = row.token;
  check('plans: server mints the token (client value ignored)', TOKEN_RE.test(tokenOld) && tokenOld !== '0'.repeat(32), `token=${String(tokenOld).slice(0, 6)}…`, NOT_URGENT);
  check('plans: display name trimmed', row.display_name === 'Roundtrip', `display_name=${JSON.stringify(row.display_name)}`, NOT_URGENT);

  const patchTok = await rest('PATCH', `plan_shares?user_id=eq.${userA.id}`, tokenA, { token: 'f'.repeat(32) });
  const reread = await rest('GET', `plan_shares?user_id=eq.${userA.id}&select=token`, tokenA);
  check('plans: owner cannot overwrite the token', patchTok.ok && reread.json?.[0]?.token === tokenOld,
    `PATCH HTTP ${patchTok.status}`, NOT_URGENT);

  // The clients' save path: upsert on user_id carrying the name (migration's
  // CLIENT CONTRACT). Must succeed and must keep the token.
  const upsert = await rest('POST', 'plan_shares?on_conflict=user_id', tokenA,
    { user_id: userA.id, display_name: 'Roundtrip', show_booked: true, show_unbooked: true },
    'return=representation,resolution=merge-duplicates');
  check('plans: client upsert succeeds and keeps the token',
    upsert.ok && upsert.json?.[0]?.token === tokenOld, `HTTP ${upsert.status} ${upsert.ok ? '' : upsert.text.slice(0, 120)}`, NOT_URGENT);

  const bRead = await rest('GET', `plan_shares?user_id=eq.${userA.id}&select=user_id`, tokenB);
  check('plans: RLS hides the share from another user', Array.isArray(bRead.json) && bRead.json.length === 0,
    `userB saw ${Array.isArray(bRead.json) ? bRead.json.length : '?'} rows`);
  await rest('PATCH', `plan_shares?user_id=eq.${userA.id}`, tokenB, { enabled: false });
  const stillOn = await rest('GET', `plan_shares?user_id=eq.${userA.id}&select=enabled`, tokenA);
  check('plans: another user cannot switch it off', stillOn.json?.[0]?.enabled === true);

  const anonTable = await rest('GET', 'plan_shares?select=token', anonKey);
  check('plans: anonymous cannot read the table', !anonTable.ok || (Array.isArray(anonTable.json) && anonTable.json.length === 0),
    `HTTP ${anonTable.status}`);

  const rpc = (token, fn, body) => rest('POST', `rpc/${fn}`, token, body, null);

  const pub = await rpc(anonKey, 'get_shared_plans', { p_token: tokenOld });
  const payload = pub.json;
  check('plans: anonymous reads the share via get_shared_plans', pub.ok && payload && typeof payload === 'object', `HTTP ${pub.status}`, NOT_URGENT);
  const problems = payloadProblems(payload, { forbiddenText: [userA.id, '19:00', 'evening', 'Roundtrip Test'] });
  check('plans: payload carries only the allowed fields', problems.length === 0, problems.join('; '));
  const ids = new Set((payload?.entries || []).map(e => e.show_id));
  check('plans: booked and want-to-see rows present', ids.has(FUTURE_SHOW) && ids.has(UNDATED_SHOW), `ids=${[...ids].join(',')}`, NOT_URGENT);
  if (pastUnloggedShowId) {
    check('plans: a past, unlogged plan stays private', !ids.has(pastUnloggedShowId));
  }

  // VOLATILE ⇒ PostgREST refuses GET, so the token can't land in request logs.
  const viaGet = await rest('GET', `rpc/get_shared_plans?p_token=${tokenOld}`, anonKey);
  check('plans: GET on get_shared_plans is refused (token stays out of URLs)', !viaGet.ok, `HTTP ${viaGet.status}`, NOT_URGENT);

  const anonRotate = await rpc(anonKey, 'rotate_plan_share_token', {});
  check('plans: anonymous cannot rotate', !anonRotate.ok, `HTTP ${anonRotate.status}`);

  const rot = await rpc(tokenA, 'rotate_plan_share_token', {});
  const tokenNew = rot.json;
  check('plans: owner can reset the link', rot.ok && TOKEN_RE.test(String(tokenNew)) && tokenNew !== tokenOld, `HTTP ${rot.status}`, NOT_URGENT);
  const oldDead = await rpc(anonKey, 'get_shared_plans', { p_token: tokenOld });
  check('plans: old link dies after reset', oldDead.ok && oldDead.json === null, `json=${JSON.stringify(oldDead.json)?.slice(0, 60)}`);

  await rest('PATCH', `plan_shares?user_id=eq.${userA.id}`, tokenA, { enabled: false });
  const stopped = await rpc(anonKey, 'get_shared_plans', { p_token: tokenNew });
  check('plans: stop sharing hides it', stopped.ok && stopped.json === null);

  const del = await rest('DELETE', `plan_shares?user_id=eq.${userA.id}`, tokenA, null, 'return=minimal');
  check('plans: owner can delete the share', del.ok, `HTTP ${del.status}`, NOT_URGENT);
  return { skipped: false };
}
