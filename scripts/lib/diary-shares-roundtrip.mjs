/**
 * Shared Diary checks for the live UGC round-trip (BRO-4566).
 *
 * Called from scripts/test-ugc-roundtrip.mjs with two real signed-in test
 * users, after A has a dated review with a note. Mirrors the local SQL tests
 * (tests/sql/diary-shares.test.sql) against the LIVE project, through
 * PostgREST exactly as the web client calls it. All I/O comes in as arguments;
 * tests/unit/diary-shares-roundtrip.test.mjs drives it against a fake server.
 */
import { TOKEN_RE, isMissingRelation } from './plan-shares-roundtrip.mjs';
import { NOT_URGENT } from './ugc-roundtrip-urgency.mjs';

export const DIARY_PAYLOAD_KEYS = ['capped', 'entries', 'name', 'showText'];
export const DIARY_ENTRY_KEYS = ['date_seen', 'rating', 'show_id'];

/** A show A reviews with a FUTURE date: a plan, which must never be listed. */
export const FUTURE_REVIEW_SHOW = 'the-lion-king-1997';

function isoDatePlus(base, days) {
  return new Date(base.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/** Problems with a public diary payload (empty = clean). `text` is allowed only when `allowText`. */
export function diaryPayloadProblems(payload, { allowText = false, forbiddenText = [] } = {}) {
  const problems = [];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return ['payload is not an object'];
  const keys = Object.keys(payload).sort();
  if (JSON.stringify(keys) !== JSON.stringify(DIARY_PAYLOAD_KEYS)) problems.push(`top-level keys ${keys.join(',')}`);
  for (const e of Array.isArray(payload.entries) ? payload.entries : []) {
    const ek = Object.keys(e).filter(k => !(allowText && k === 'text')).sort();
    if (JSON.stringify(ek) !== JSON.stringify(DIARY_ENTRY_KEYS)) problems.push(`entry keys ${Object.keys(e).sort().join(',')}`);
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
 * @param {string} ctx.anonKey
 * @param {{id: string}} ctx.userA
 * @param {string} ctx.tokenA
 * @param {string} ctx.tokenB
 * @param {string} ctx.showId    a show A has a past, dated review for
 * @param {string} ctx.noteText  that review's current review_text
 * @returns {Promise<{skipped: boolean}>}
 */
export async function runDiarySharesChecks(ctx) {
  const { rest, check, anonKey, userA, tokenA, tokenB, showId, noteText } = ctx;
  const now = ctx.now || new Date();

  const probe = await rest('GET', 'diary_shares?select=user_id&limit=1', tokenA);
  if (isMissingRelation(probe)) {
    console.log('diary_shares: not in this project yet — skipped (apply supabase/migrations/20261004_diary_shares.sql)');
    return { skipped: true };
  }

  const future = await rest('POST', 'reviews', tokenA, {
    user_id: userA.id, show_id: FUTURE_REVIEW_SHOW, rating: 4, date_seen: isoDatePlus(now, 10),
  });
  const futureId = Array.isArray(future.json) ? future.json[0]?.id : null;

  const created = await rest('POST', 'diary_shares', tokenA, {
    user_id: userA.id, display_name: '  Roundtrip  ', token: '0'.repeat(32),
  });
  const row = Array.isArray(created.json) ? created.json[0] : null;
  check('diary: owner creates a share', created.status === 201 && !!row, `HTTP ${created.status} ${created.ok ? '' : created.text.slice(0, 160)}`, NOT_URGENT);
  if (!row) return { skipped: false };
  const tokenOld = row.token;
  check('diary: server mints the token (client value ignored)', TOKEN_RE.test(tokenOld) && tokenOld !== '0'.repeat(32), '', NOT_URGENT);
  check('diary: notes are off by default', row.show_text === false, `show_text=${row.show_text}`);

  const patchTok = await rest('PATCH', `diary_shares?user_id=eq.${userA.id}`, tokenA, { token: 'f'.repeat(32) });
  const reread = await rest('GET', `diary_shares?user_id=eq.${userA.id}&select=token`, tokenA);
  check('diary: owner cannot overwrite the token', patchTok.ok && reread.json?.[0]?.token === tokenOld, `PATCH HTTP ${patchTok.status}`, NOT_URGENT);

  const bRead = await rest('GET', `diary_shares?user_id=eq.${userA.id}&select=user_id`, tokenB);
  check('diary: RLS hides the share from another user', Array.isArray(bRead.json) && bRead.json.length === 0);
  await rest('PATCH', `diary_shares?user_id=eq.${userA.id}`, tokenB, { show_text: true });
  const stillOff = await rest('GET', `diary_shares?user_id=eq.${userA.id}&select=show_text`, tokenA);
  check('diary: another user cannot turn notes on', stillOff.json?.[0]?.show_text === false);

  const anonTable = await rest('GET', 'diary_shares?select=token', anonKey);
  check('diary: anonymous cannot read the table', !anonTable.ok || (Array.isArray(anonTable.json) && anonTable.json.length === 0));

  const rpc = (token, fn, body) => rest('POST', `rpc/${fn}`, token, body, null);

  const pub = await rpc(anonKey, 'get_shared_diary', { p_token: tokenOld });
  const payload = pub.json;
  check('diary: anonymous reads the share via get_shared_diary', pub.ok && payload && typeof payload === 'object', `HTTP ${pub.status}`, NOT_URGENT);
  const problems = diaryPayloadProblems(payload, { forbiddenText: [userA.id, noteText] });
  check('diary: with notes off, no note text and only the allowed fields', problems.length === 0, problems.join('; '));
  check('diary: the past review is listed', (payload?.entries || []).some(e => e.show_id === showId), '', NOT_URGENT);
  check('diary: a future-dated review (a plan) is not listed',
    futureId !== null && !(payload?.entries || []).some(e => e.show_id === FUTURE_REVIEW_SHOW),
    futureId === null ? `could not create the future review: HTTP ${future.status}` : '');

  const notesOn = await rest('PATCH', `diary_shares?user_id=eq.${userA.id}`, tokenA, { show_text: true });
  check('diary: owner can turn notes on', notesOn.ok && notesOn.json?.[0]?.show_text === true, `PATCH HTTP ${notesOn.status}`, NOT_URGENT);
  const withNotes = (await rpc(anonKey, 'get_shared_diary', { p_token: tokenOld })).json;
  const noteRow = (withNotes?.entries || []).find(e => e.show_id === showId);
  check('diary: with notes on, the note comes through', noteRow?.text === noteText, `text=${JSON.stringify(noteRow?.text)}`, NOT_URGENT);
  check('diary: with notes on, still no ids or user', diaryPayloadProblems(withNotes, { allowText: true, forbiddenText: [userA.id] }).length === 0);

  const viaGet = await rest('GET', `rpc/get_shared_diary?p_token=${tokenOld}`, anonKey);
  check('diary: GET on get_shared_diary is refused (token stays out of URLs)', !viaGet.ok, `HTTP ${viaGet.status}`, NOT_URGENT);

  const anonRotate = await rpc(anonKey, 'rotate_diary_share_token', {});
  check('diary: anonymous cannot rotate', !anonRotate.ok, `HTTP ${anonRotate.status}`);
  const rot = await rpc(tokenA, 'rotate_diary_share_token', {});
  const tokenNew = rot.json;
  check('diary: owner can reset the link', rot.ok && TOKEN_RE.test(String(tokenNew)) && tokenNew !== tokenOld, `HTTP ${rot.status}`, NOT_URGENT);
  const oldDead = await rpc(anonKey, 'get_shared_diary', { p_token: tokenOld });
  check('diary: old link dies after reset', oldDead.ok && oldDead.json === null);

  await rest('PATCH', `diary_shares?user_id=eq.${userA.id}`, tokenA, { enabled: false });
  const stopped = await rpc(anonKey, 'get_shared_diary', { p_token: tokenNew });
  check('diary: stop sharing hides it', stopped.ok && stopped.json === null);

  const del = await rest('DELETE', `diary_shares?user_id=eq.${userA.id}`, tokenA, null, 'return=minimal');
  check('diary: owner can delete the share', del.ok, `HTTP ${del.status}`, NOT_URGENT);
  if (futureId) await rest('DELETE', `reviews?id=eq.${futureId}&user_id=eq.${userA.id}`, tokenA, null, 'return=minimal');
  return { skipped: false };
}
