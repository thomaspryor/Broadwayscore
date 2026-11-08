'use strict';
/**
 * recheck-route.js (BRO-7138 part 3). A Done card whose own VERIFY command now
 * FAILS on fresh main used to be reported in the ledger and the morning email,
 * then nothing happened: nobody owned the regression. This routes the night's
 * real failures to ONE batched worker card, so a worker reproduces each one on
 * main and fixes it (or rewrites a stale VERIFY) under that card.
 *
 * What it never does: reopen or move the original cards (shadow-mode rule for
 * Done cards stands), route a check that could not run on the recheck machine
 * (recheckVerdict: those are environment, not regressions), or route a card a
 * BRO-6853 handoff already moved to a worker the same night.
 *
 * Owner decision (2026-11-08, option A): automatic, armed one week after the
 * honest recheck (part 2) lands. Until RECHECK_ROUTE_FROM it runs in SHADOW:
 * the ledger gets a 'recheck-route' row naming what it WOULD file, and nothing
 * is created. Off switch, no code change: `gh variable set RECHECK_ROUTE --body off`.
 *
 * buildRouteBatch / routeMode are pure; fileRouteBatch is the I/O half, shaped
 * like recheck-handoff.js handoffCard (linear-brain main, exit trapped).
 */

const { recheckVerdict } = require('./check-env-cause.js');
const { ExitTrap } = require('./recheck-autoclose.js');

// Part 2 landed 2026-11-08; one week later per the owner's option A.
const DEFAULT_ROUTE_FROM = '2026-11-15';
const MAX_ROUTED = 10;
const DEDUP_DAYS = 30;

/**
 * @returns {{mode:'off'|'shadow'|'live', from:string, why:string}}
 */
function routeMode({ env = process.env, now = Date.now() } = {}) {
  if (String(env.RECHECK_ROUTE || '').toLowerCase() === 'off') return { mode: 'off', from: null, why: 'RECHECK_ROUTE=off' };
  const raw = String(env.RECHECK_ROUTE_FROM || '').trim();
  const parsed = raw ? Date.parse(`${raw.slice(0, 10)}T00:00:00Z`) : NaN;
  // A typo in the variable must not arm routing early: fall back to the default date.
  const from = Number.isFinite(parsed) ? raw.slice(0, 10) : DEFAULT_ROUTE_FROM;
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  if (now < fromMs) return { mode: 'shadow', from, why: `shadow until ${from}${raw && !Number.isFinite(parsed) ? ` (RECHECK_ROUTE_FROM "${raw}" unreadable, default used)` : ''}` };
  return { mode: 'live', from, why: `armed since ${from}` };
}

/** Card ids a LIVE route already filed within DEDUP_DAYS (shadow rows do not count). */
function alreadyRouted(ledgerEntries, { now = Date.now() } = {}) {
  const since = now - DEDUP_DAYS * 86400000;
  const ids = new Set();
  for (const e of ledgerEntries || []) {
    if (!e || e.event !== 'recheck-route' || e.mode !== 'live' || !e.filed) continue;
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t < since) continue;
    for (const id of e.cardIds || []) ids.add(id);
  }
  return ids;
}

/**
 * The night's routable failures, as one card's title and body.
 * @param {{rows:object[], handedOff?:string[], ledgerEntries?:object[], now?:number, tsxTests?:Set<string>, sha?:string}} o
 *   rows: this run's results or its ledger 'recheck' rows (same fields)
 *   sha: the fresh-main commit the checks ran on (each entry names it)
 * @returns {{cards:object[], overflow:number, title:string|null, body:string|null, skipped:{env:number, handedOff:number, routed:number}}}
 */
function buildRouteBatch({ rows, handedOff = [], ledgerEntries = [], now = Date.now(), tsxTests, sha = null } = {}) {
  const handed = new Set(handedOff);
  const routed = alreadyRouted(ledgerEntries, { now });
  const skipped = { env: 0, handedOff: 0, routed: 0 };
  const seen = new Set();
  const fails = [];
  for (const r of rows || []) {
    if (!r || r.skip || !r.cardId || seen.has(r.cardId)) continue;
    const v = recheckVerdict(r, { tsxTests });
    if (v.status !== 'fail') { if (v.envCause) skipped.env++; continue; }
    seen.add(r.cardId);
    if (handed.has(r.cardId)) { skipped.handedOff++; continue; }
    if (routed.has(r.cardId)) { skipped.routed++; continue; }
    fails.push(r);
  }
  const cards = fails.slice(0, MAX_ROUTED);
  const overflow = fails.length - cards.length;
  if (!cards.length) return { cards, overflow: 0, title: null, body: null, skipped };
  const day = new Date(now).toISOString().slice(0, 10);
  const n = cards.length + overflow;
  const title = `Recheck ${day}: ${n} done ${n === 1 ? 'claim' : 'claims'} no longer hold on main`;
  const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 220);
  // The END of the output names the failure (assertion, exit line); the head is often setup noise.
  const tail = (s) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > 220 ? `...${t.slice(-220)}` : t; };
  const commit = sha ? String(sha).slice(0, 12) : 'unknown';
  const body = [
    `The nightly acceptance recheck (BRO-7138) re-ran each card's own VERIFY command on fresh main and it FAILED. These were closed as done; the effect did not hold.`,
    '',
    'For each card below: reproduce on main, then either fix the regression, or (if the VERIFY itself went stale) rewrite it into a real check and say why in a comment on the original card. Do not reopen the original cards; do the work here.',
    '',
    ...cards.map((c) => `- ${c.cardId} ${oneLine(c.name)}\n  - check: \`${c.verifyCmd}\`\n  - failed on main at ${commit}, output tail: ${tail(c.detail || c.note) || '(no output kept)'}`),
    ...(overflow > 0 ? ['', `${overflow} more failed tonight and will be routed on a later night once these are cleared (cap ${MAX_ROUTED} per batch).`] : []),
    '',
    '## Acceptance criteria',
    ...cards.map((c) => `- \`${c.verifyCmd}\` passes on main (${c.cardId}), or its replacement check does and the original card says why.`),
  ].join('\n');
  return { cards, overflow, title, body, skipped };
}

/**
 * Files the batch as one dispatchable card. --new-anyway: tonight's batch is
 * different work from last night's even though the titles look alike, and the
 * near-duplicate reuse would otherwise fold it into an older card as a comment.
 * @returns {Promise<{filed:boolean, identifier:string|null, error:string|null}>}
 */
async function fileRouteBatch({ title, body, linearBrainMain } = {}) {
  const main = linearBrainMain || require('../linear-brain.js').main;
  const realExit = process.exit;
  const realErr = console.error;
  let firstCode = null;
  let identifier = null;
  process.exit = (code) => {
    if (firstCode === null) firstCode = code == null ? 0 : code;
    throw new ExitTrap(firstCode);
  };
  console.error = (...a) => {
    const m = String(a.join(' ')).match(/__BOARD_CARD_ID__=(BRO-\d+)|ISSUE-(?:FILED|REUSED): (BRO-\d+)/);
    if (m && !identifier) identifier = m[1] || m[2];
    realErr(...a);
  };
  try {
    await Promise.race([
      main(['create', title, '--dispatch', '--priority', '2', '--source', 'acceptance-recheck', '--new-anyway', 'a nightly recheck batch lists only cards not routed before', '--notes', body]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('route create timed out after 60s')), 60000).unref()),
    ]);
    return { filed: !!identifier, identifier, error: identifier ? null : 'linear-brain create printed no card id' };
  } catch (err) {
    if (err instanceof ExitTrap) return { filed: err.exitCode === 0 && !!identifier, identifier, error: err.exitCode === 0 ? null : `linear-brain create exited ${err.exitCode}` };
    return { filed: false, identifier, error: String((err && err.message) || err).slice(0, 200) };
  } finally {
    process.exit = realExit;
    console.error = realErr;
  }
}

module.exports = { DEFAULT_ROUTE_FROM, MAX_ROUTED, routeMode, alreadyRouted, buildRouteBatch, fileRouteBatch };
