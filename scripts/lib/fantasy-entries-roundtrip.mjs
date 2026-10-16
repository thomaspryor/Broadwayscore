// Fantasy League leg of scripts/test-ugc-roundtrip.mjs (BRO-5424).
//
// From April to October 2026 every draft submission failed: the draft route
// asked PostgREST for the new row back (INSERT ... RETURNING), and anon has no
// SELECT policy on fantasy_entries, so the insert was refused. Nothing checked
// the live insert path, so nobody noticed for six months. This drives the same
// anon insert the route makes (no RETURNING), against the live project, under
// a probe season no leaderboard reads, then deletes the probe rows with the
// service role.
//
// A failure to save is urgent only while the draft is open (players are being
// turned away); the database guards from
// 20261016_fantasy_entries_insert_hardening.sql are never urgent.

import { readFileSync } from 'node:fs';

const season = JSON.parse(readFileSync(new URL('../../src/config/fantasy-season.json', import.meta.url), 'utf-8'));
const PROBE_SEASON = 'roundtrip-probe';

function draftIsOpen(now = new Date()) {
  const ny = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return ny >= season.draftOpens && now <= new Date(season.draftDeadline);
}

/**
 * @param {object} ctx
 * @param {Function} ctx.rest       (method, path, token, body, prefer) => {status, ok, json, text}
 * @param {Function} ctx.check      (name, ok, detail, opts) => boolean
 * @param {string}   ctx.anonKey
 * @param {string}   ctx.serviceKey
 * @param {object}   ctx.notUrgent  the NOT_URGENT opts marker
 */
export async function runFantasyEntryChecks({ rest, check, anonKey, serviceKey, notUrgent }) {
  const stamp = Date.now();
  const email = `bfl-roundtrip-${stamp}@example.com`;
  const saveUrgency = draftIsOpen() ? {} : notUrgent;
  try {
    const ins = await rest('POST', 'fantasy_entries', anonKey, {
      email,
      picks: ['hamilton-2015'],
      total_cost: 1,
      season: PROBE_SEASON,
      created_at: '2020-01-01T00:00:00Z',
    }, 'return=minimal');
    const saved = check('fantasy: a draft saves (anon insert, as /api/fantasy/draft makes it)', ins.status === 201,
      `HTTP ${ins.status} ${ins.text.slice(0, 160)}`, saveUrgency);

    if (saved) {
      const row = await rest('GET', `fantasy_entries?email=eq.${encodeURIComponent(email)}&season=eq.${PROBE_SEASON}&select=created_at`, serviceKey);
      const createdAt = Array.isArray(row.json) ? row.json[0]?.created_at : null;
      const recent = !!createdAt && Date.now() - Date.parse(createdAt) < 60 * 60 * 1000;
      check('fantasy: a client-sent created_at is replaced by the server clock (no backdated drafts)', recent,
        `stored ${createdAt ?? 'nothing'}`, notUrgent);
    }

    const bad = await rest('POST', 'fantasy_entries', anonKey, {
      email: `bfl-roundtrip-bad-${stamp}@example.com`,
      picks: [{ x: 1 }],
      total_cost: 0,
      season: PROBE_SEASON,
    }, 'return=minimal');
    check('fantasy: a malformed pick is refused (it would crash the leaderboard)', !bad.ok, `HTTP ${bad.status}`, notUrgent);

    const anonRead = await rest('GET', `fantasy_entries?season=eq.${PROBE_SEASON}&select=email`, anonKey);
    check('fantasy: player emails are not readable anonymously',
      !anonRead.ok || (Array.isArray(anonRead.json) && anonRead.json.length === 0),
      `anon saw ${Array.isArray(anonRead.json) ? anonRead.json.length : '?'} rows`);
  } finally {
    const del = await rest('DELETE', `fantasy_entries?season=eq.${PROBE_SEASON}`, serviceKey, null, 'return=minimal');
    if (!del.ok) console.warn(`fantasy probe cleanup: HTTP ${del.status} ${del.text.slice(0, 160)}`);
  }
}
