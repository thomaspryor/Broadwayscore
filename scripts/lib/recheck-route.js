'use strict';
/**
 * recheck-route.js (BRO-7138 part 3). A Done card whose own VERIFY command now
 * FAILS on fresh main used to be reported in the ledger and the morning email,
 * then nothing happened: nobody owned the regression. This routes the night's
 * real failures to ONE batched worker card, so a worker reproduces each one on
 * main and fixes it (or rewrites a stale VERIFY) under that card.
 *
 * What it never does: move the original cards (BRO-7697 reopen is a separate, enforcement-gated
 * path in recheck-reopen.js that skips cards an open card already names), route a check that could not run on the recheck machine
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
// BRO-7557: a live-routed card used to be skipped for DEDUP_DAYS and, because a Done card is
// rechecked on one night only, never looked at again. Now it is re-run (rewatch) and, if it
// still fails, routed again once the retry window has passed AND no open card mentions it.
const ROUTE_RETRY_NIGHTS = 3;
// After this many live routes of one card, stop rewatching it: the VERIFY or the fix needs a
// human, and a fourth identical card would be noise.
const MAX_REROUTES = 3;
const MAX_REWATCH = 5;
// An alert-absent check fails while the alert fired inside the router's quiet
// window (up to 168h), so it keeps "failing" for days after the alert stopped.
// Replay of 110 nights (2026-11-08): 8 cards failed 61-138h after the last fire.
// They still route (a Done card is rechecked on one night only, so holding one
// would drop it for good), but the entry says so, so the worker checks the alert
// ledger before anything else.
const QUIET_ALERT_NOTE_H = 48;

/** PURE. Hours since the alert last fired when an alert-absent fail is quiet past QUIET_ALERT_NOTE_H, else null. */
function quietAlertHours(r) {
  if (!r || !/check-alert-condition-absent\.js/.test(String(r.verifyCmd || ''))) return null;
  const m = /still firing .*?last fired \S+ \(([\d.]+)h ago, within \d+h\)/.exec(String(r.detail || r.note || ''));
  return m && Number(m[1]) > QUIET_ALERT_NOTE_H ? Number(m[1]) : null;
}

/**
 * @returns {{mode:'off'|'shadow'|'live', from:string, why:string}}
 */
function routeMode({ env = process.env, now = Date.now() } = {}) {
  if (String(env.RECHECK_ROUTE || '').toLowerCase() === 'off') return { mode: 'off', from: null, why: 'RECHECK_ROUTE=off' };
  const raw = String(env.RECHECK_ROUTE_FROM || '').trim();
  let parsed = raw ? Date.parse(`${raw.slice(0, 10)}T00:00:00Z`) : NaN;
  // V8 rolls impossible dates over (2026-02-30 -> March 2): a round trip catches them.
  if (Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) !== raw.slice(0, 10)) parsed = NaN;
  // A typo in the variable must not arm routing early: fall back to the default date.
  const from = Number.isFinite(parsed) ? raw.slice(0, 10) : DEFAULT_ROUTE_FROM;
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  if (now < fromMs) return { mode: 'shadow', from, why: `shadow until ${from}${raw && !Number.isFinite(parsed) ? ` (RECHECK_ROUTE_FROM "${raw}" unreadable, default used)` : ''}` };
  return { mode: 'live', from, why: `armed since ${from}` };
}

/** Card ids a LIVE route already filed within DEDUP_DAYS (shadow rows do not count). */
function alreadyRouted(ledgerEntries, { now = Date.now(), coverKnown = false } = {}) {
  // With a live open-card index the open-card check carries the long-term dedupe, so the ledger
  // window shrinks to the retry window. Without one (Linear fetch failed) keep the long window:
  // never route twice because a lookup failed.
  const since = now - (coverKnown ? ROUTE_RETRY_NIGHTS : DEDUP_DAYS) * 86400000;
  const ids = new Set();
  for (const e of ledgerEntries || []) {
    // maybeFiled: the create timed out, so a card may exist; never risk a second one.
    if (!e || e.event !== 'recheck-route' || e.mode !== 'live' || !(e.filed || e.maybeFiled)) continue;
    const t = Date.parse(e.ts);
    if (Number.isFinite(t) && t < since) continue;
    for (const id of e.cardIds || []) ids.add(id);
  }
  return ids;
}


/** PURE. Live route rows (filed or maybeFiled) per card, oldest first: [{ts, identifier}]. */
function liveRoutesByCard(ledgerEntries) {
  const m = new Map();
  for (const e of ledgerEntries || []) {
    if (!e || e.event !== 'recheck-route' || e.mode !== 'live' || !(e.filed || e.maybeFiled)) continue;
    for (const id of e.cardIds || []) {
      if (!m.has(id)) m.set(id, []);
      m.get(id).push({ ts: e.ts, identifier: e.identifier || null });
    }
  }
  for (const list of m.values()) list.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  return m;
}

/**
 * PURE. Map of card id -> identifiers of OPEN Linear cards whose title or description names it
 * (word-boundary: BRO-12 never matches BRO-123). A card is never covered by itself.
 * Returns null when issues is not an array (fetch failed): callers must then fall back to the
 * long ledger window, never treat "unknown" as "uncovered".
 */
function buildCoverIndex(openIssues) {
  if (!Array.isArray(openIssues)) return null;
  const idx = new Map();
  for (const issue of openIssues) {
    if (!issue || !issue.identifier) continue;
    const text = `${issue.title || ''}\n${issue.description || ''}`;
    for (const m of text.matchAll(/(?<![A-Za-z0-9-])BRO-(\d+)(?!\d)/g)) {
      const id = `BRO-${m[1]}`;
      if (id === issue.identifier) continue;
      if (!idx.has(id)) idx.set(id, new Set());
      idx.get(id).add(issue.identifier);
    }
  }
  return idx;
}

/**
 * PURE. THE one "is this failing card already someone's work" predicate, used by both the
 * batch builder and the rewatch selector: an open card names it, or a live route filed it
 * inside the retry window (long window when the open-card index is unknown).
 */
function coveredBy(cardId, { coverIndex = null, routed = new Set() } = {}) {
  if (coverIndex && coverIndex.has(cardId)) return [...coverIndex.get(cardId)][0];
  if (routed.has(cardId)) return 'recent-route';
  return null;
}

/**
 * PURE. Cards whose LATEST recheck is a real fail and that nobody covers: the shadow-era
 * failures (never routed live) and persistent failures past the retry window. Oldest check
 * first so one card cannot starve the rest. Cards already live-routed MAX_REROUTES times stop.
 * @returns {{targets:object[], exhausted:string[]}}
 */
function selectRewatchTargets({ ledgerEntries, now = Date.now(), limit = MAX_REWATCH, since = null, exclude = [], coverIndex = null, tsxTests, minAgeHours = 20 } = {}) {
  const latest = new Map();
  for (const e of ledgerEntries || []) {
    if (!e || e.event !== 'recheck' || !e.cardId || e.skip) continue;
    // An env-cause row (could not run here) says nothing about the card, so it must not hide an earlier real fail.
    if (recheckVerdict(e, { tsxTests }).envCause) continue;
    latest.set(e.cardId, e); // ledger is append-ordered: last wins, even outside the look-back
  }
  const routed = alreadyRouted(ledgerEntries, { now, coverKnown: !!coverIndex });
  const routes = liveRoutesByCard(ledgerEntries);
  const skip = new Set(exclude);
  const cands = [];
  const exhausted = [];
  for (const r of latest.values()) {
    if (skip.has(r.cardId) || !r.verifyCmd) continue;
    if (since && String(r.ts) < since) continue; // latest row is older than the look-back
    const age = now - Date.parse(r.ts);
    if (!(age >= minAgeHours * 3600000)) continue; // rechecked tonight already, or unparseable ts
    if (recheckVerdict(r, { tsxTests }).status !== 'fail') continue;
    if (coveredBy(r.cardId, { coverIndex, routed })) continue;
    const prior = routes.get(r.cardId) || [];
    if (prior.length >= MAX_REROUTES) { exhausted.push(r.cardId); continue; }
    cands.push({ cardId: r.cardId, name: r.name, verifyCmd: r.verifyCmd, reason: null, skip: null, rewatch: true, priorRoutes: prior, lastTs: r.ts });
  }
  cands.sort((a, b) => String(a.lastTs).localeCompare(String(b.lastTs)));
  return { targets: cands.slice(0, limit), exhausted };
}

/**
 * Re-reads each rewatch candidate's CARD, so the command is the one the card carries NOW
 * (a worker that rewrote a stale VERIFY in a comment must not be re-failed on the old one,
 * BRO-3446 comment corrections) and so only Done cards are re-run (an open card already has
 * an owner and a normal recheck path). A card that cannot be read, is not completed, or has
 * retracted its VERIFY is dropped and counted, never guessed at.
 * @param {object[]} targets selectRewatchTargets output
 * @param {{getIssue:Function, toCard:Function, gateFor:Function}} deps injected: linear-client getIssue, linear-recheck-source mapIssueToCard, autonomous-recheck-core verifiabilityForCard
 * @returns {Promise<{targets:object[], dropped:{cardId:string, why:string}[]}>}
 */
async function refreshRewatchTargets(targets, { getIssue, toCard, gateFor } = {}) {
  const out = [];
  const dropped = [];
  for (const t of targets || []) {
    let issue = null;
    try { issue = await getIssue(t.cardId); } catch (err) { dropped.push({ cardId: t.cardId, why: `card unreadable: ${String((err && err.message) || err).slice(0, 80)}` }); continue; }
    const card = toCard(issue);
    if (!card) { dropped.push({ cardId: t.cardId, why: 'card not found' }); continue; }
    if (card.stateType !== 'completed') { dropped.push({ cardId: t.cardId, why: `card is ${card.status}, not Done` }); continue; }
    const gate = gateFor(card);
    if (gate && gate.kind === 'retracted') { dropped.push({ cardId: t.cardId, why: 'VERIFY retracted on the card' }); continue; }
    out.push({ ...t, name: card.name || t.name, verifyCmd: (gate && gate.cmd) || t.verifyCmd, ...(gate && gate.cmd && gate.cmd !== t.verifyCmd ? { cmdChanged: true } : {}) });
  }
  return { targets: out, dropped };
}

/**
 * The night's routable failures, as one card's title and body.
 * @param {{rows:object[], handedOff?:string[], ledgerEntries?:object[], now?:number, tsxTests?:Set<string>, sha?:string}} o
 *   rows: this run's results or its ledger 'recheck' rows (same fields)
 *   sha: the fresh-main commit the checks ran on (each entry names it)
 * @returns {{cards:object[], overflow:number, title:string|null, body:string|null, skipped:{env:number, handedOff:number, routed:number}}}
 */
/**
 * BRO-8403. PURE. Card ids from tonight's results whose card is NOT Done and is held on the owner
 * or a real PARKED line: the same isHeldForHandoff rule decideHandoff (recheck-handoff.js) uses to
 * refuse a hand-off. Such a failure is the expected state of an open decision, not a regression.
 * A Done card is never held: its failing check is a real "done claim no longer holds".
 * @param {{cardId?:string}[]} results
 * @param {Map<string,{stateType?:string,notes?:string}>} cardsById
 * @returns {string[]}
 */
function heldForOwner(results, cardsById) {
  const { isHeldForHandoff } = require('./recheck-past-date.js');
  const out = [];
  for (const r of results || []) {
    const c = r && r.cardId && cardsById && cardsById.get(r.cardId);
    if (c && c.stateType !== 'completed' && isHeldForHandoff(c.notes) && !out.includes(r.cardId)) out.push(r.cardId);
  }
  return out;
}

function buildRouteBatch({ rows, handedOff = [], held = [], ledgerEntries = [], now = Date.now(), tsxTests, sha = null, coverIndex = null } = {}) {
  const handed = new Set(handedOff);
  // BRO-8403: a Paused/Backlog card parked on an owner DECISION NEEDED (or a real PARKED hold)
  // is not a done claim that regressed. decideHandoff already refuses it; routing it anyway
  // dispatched a worker that could only re-report "still waiting on the owner".
  const heldSet = new Set(held);
  const routed = alreadyRouted(ledgerEntries, { now, coverKnown: !!coverIndex });
  const routes = liveRoutesByCard(ledgerEntries);
  const skipped = { env: 0, handedOff: 0, held: 0, routed: 0, coveredOpen: 0, exhausted: 0, coveredBy: {} };
  const seen = new Set();
  const fails = [];
  for (const r of rows || []) {
    if (!r || r.skip || !r.cardId || seen.has(r.cardId)) continue;
    const v = recheckVerdict(r, { tsxTests });
    if (v.status !== 'fail') { if (v.envCause) skipped.env++; continue; }
    seen.add(r.cardId);
    if (handed.has(r.cardId)) { skipped.handedOff++; continue; }
    if (heldSet.has(r.cardId)) { skipped.held++; continue; }
    if (routed.has(r.cardId)) { skipped.routed++; continue; }
    if (coverIndex && coverIndex.has(r.cardId)) { skipped.coveredOpen++; skipped.coveredBy[r.cardId] = coveredBy(r.cardId, { coverIndex }); continue; }
    if ((routes.get(r.cardId) || []).length >= MAX_REROUTES) { skipped.exhausted++; continue; }
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
  const quietNote = (c) => {
    const h = quietAlertHours(c);
    return h === null ? '' : `\n  - note: the alert last fired ${Math.round(h)}h ago and the check still counts it until its quiet window ends. Look at data/audit/alert-ledger.json first. If it has not fired since the card closed, confirm the condition itself is gone (quiet alone proves nothing for weekly or throttled alerts) before saying on the original card that the fix holds.`;
  };
  const priorNote = (c) => {
    const p = routes.get(c.cardId) || [];
    if (!p.length) return '';
    const last = p[p.length - 1];
    const nights = Math.max(1, Math.round((now - Date.parse(last.ts)) / 86400000));
    return `\n  - note: routed before (${p.map((x) => x.identifier || 'a card filed ' + String(x.ts).slice(0, 10)).join(', ')}) and still failing ${nights} night${nights === 1 ? '' : 's'} later. If that card is Done, its fix did not hold or its VERIFY is stale: say which on the original card.`;
  };
  const commit = sha ? String(sha).slice(0, 12) : 'unknown';
  const body = [
    `The nightly acceptance recheck (BRO-7138) re-ran each card's own VERIFY command on fresh main and it FAILED. These were closed as done; the effect did not hold.`,
    '',
    'For each card below: reproduce on main, then either fix the regression, or (if the VERIFY itself went stale) rewrite it into a real check and say why in a comment on the original card. Do not reopen the original cards; do the work here.',
    '',
    ...cards.map((c) => `- ${c.cardId} ${oneLine(c.name)}\n  - check: \`${c.verifyCmd}\`\n  - failed on main at ${commit}, output tail: ${tail(c.detail || c.note) || '(no output kept)'}${quietNote(c)}${priorNote(c)}`),
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
 * @returns {Promise<{filed:boolean, identifier:string|null, error:string|null, maybeFiled?:boolean}>}
 * On a timeout the create may still finish later: the result says maybeFiled
 * (dedup counts it) and process.exit stays trapped until main() settles, so a
 * late failure in it can never kill the recheck process.
 */
async function fileRouteBatch({ title, body, linearBrainMain, timeoutMs = 60000 } = {}) {
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
  const restore = () => { process.exit = realExit; console.error = realErr; };
  let timedOut = false;
  const run = Promise.resolve().then(() => main(['create', title, '--dispatch', '--priority', '2', '--source', 'acceptance-recheck', '--new-anyway', 'a nightly recheck batch lists only cards not routed before', '--notes', body]));
  try {
    await Promise.race([
      run,
      new Promise((_, rej) => setTimeout(() => { timedOut = true; rej(new Error(`route create timed out after ${timeoutMs / 1000}s`)); }, timeoutMs).unref()),
    ]);
    return { filed: !!identifier, identifier, error: identifier ? null : 'linear-brain create printed no card id' };
  } catch (err) {
    if (err instanceof ExitTrap) return { filed: err.exitCode === 0 && !!identifier, identifier, error: err.exitCode === 0 ? null : `linear-brain create exited ${err.exitCode}` };
    return { filed: false, identifier, error: String((err && err.message) || err).slice(0, 200), ...(timedOut ? { maybeFiled: true } : {}) };
  } finally {
    if (timedOut) run.then(restore, restore); else restore();
  }
}

module.exports = { heldForOwner, DEFAULT_ROUTE_FROM, MAX_ROUTED, ROUTE_RETRY_NIGHTS, MAX_REROUTES, MAX_REWATCH, liveRoutesByCard, buildCoverIndex, coveredBy, selectRewatchTargets, refreshRewatchTargets, QUIET_ALERT_NOTE_H, quietAlertHours, routeMode, alreadyRouted, buildRouteBatch, fileRouteBatch };
