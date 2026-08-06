/**
 * dispatch-card-drift.js — "is this running session executing the card that
 * Notion currently shows?"
 *
 * Why (card #1009, live instance 2026-08-04): scripts/bsc-next.js seeds a
 * session with the card body exactly ONCE, at launch. If the card is corrected
 * afterwards, the running session never learns — it keeps executing the
 * original text while Notion (and anyone reading it) shows the corrected
 * version. Task #1002 launched 04:03:37; a plan-review found two P0 defects in
 * its acceptance criteria and the card was corrected ~04:10. The correction
 * only reached workspace:156 because a human-driven session happened to run
 * `cmux send` by hand. Nothing automatic would have done that, and nothing
 * anywhere recorded that the session was running stale instructions.
 *
 * This is the detector half: a PURE decision layer over the existing
 * append-only dispatch ledger (scripts/lib/dispatch-ledger.js). No fs, no
 * exec, no network — callers read the ledger and fetch the cards; this file
 * only decides. CLAUDE.md §15: the test require()s these functions.
 *
 * Two drift signals, deliberately not equal in strength:
 *
 *   'hash-mismatch'      (confidence 'exact') — the launch entry carries the
 *                        contentHash of the card body it seeded (same
 *                        computeContentHash() the autonomous loop's
 *                        attempt-memory.js already uses, reused verbatim so
 *                        one card has ONE hash across both systems), and the
 *                        card's current body hashes differently. This is
 *                        proof: the work text changed after dispatch.
 *
 *   'edited-after-dispatch' (confidence 'weak') — the launch predates this
 *                        feature and carries no hash, so all that can be
 *                        compared is Notion's last_edited_time against the
 *                        launch timestamp. ANY property edit bumps that
 *                        timestamp (status, tags, a sync writing the card
 *                        back), so it over-reports: it is loud enough to
 *                        surface in a digest, never strong enough to block a
 *                        close. This is the signal that catches the real
 *                        2026-08-04 #1002 case, whose launch entry — written
 *                        before this shipped — has no contentHash.
 *
 * An 'amend' ledger entry (written by `bsc-next.js --id N --amend`, which
 * re-delivers the current card body into the live workspace) carrying the
 * card's CURRENT hash clears the drift: the session has now seen the
 * correction. An amend recorded as delivered:false — a workspace that could
 * not be reached — deliberately does NOT clear it, because that is exactly
 * the "corrected on paper only" state this module exists to make visible.
 */

'use strict';

const { computeContentHash } = require('./attempt-memory.js');
const { TERMINAL_LAUNCH_EVENTS, TERMINAL_JOB_EVENTS } = require('./dispatch-ledger.js');

// Events that end a launch's life. A launch with any of these after it is no
// longer in flight, so its card can be edited freely without anyone running
// stale instructions. (`prune` — the sweep-summary line, taskId 'sweep' — is
// NOT terminal for a task; it is bookkeeping for the sweep itself.)
//
// Composed from dispatch-ledger's OWN sets rather than re-listed here (the
// "must match X" comment IS the bug — CLAUDE.md): a future terminal event
// added there must not silently leave this detector calling dead sessions
// in-flight. 'launch-failed' is added on top: dispatch-ledger treats it as a
// journal line rather than a terminal state, but for drift purposes a launch
// that never started is not a session anyone can mislead.
const TERMINAL_EVENTS = new Set([
  ...TERMINAL_LAUNCH_EVENTS,   // dead, vanished, prune-closed, remapped
  ...TERMINAL_JOB_EVENTS,      // job-done, job-failed, job-orphaned
  'launch-failed',
]);

const AMEND_EVENT = 'amend';

const STATUS = {
  NO_DRIFT: 'no-drift',
  DRIFTED: 'drifted',
  AMENDED: 'amended',
  UNKNOWN: 'unknown',
};

const SIGNALS = {
  HASH_MISMATCH: 'hash-mismatch',
  EDITED_AFTER: 'edited-after-dispatch',
};

// Dispatch itself touches the card (status → In progress, the sync writing the
// mirror back), which bumps last_edited_time by seconds. Only the weak,
// timestamp-only signal needs this; the hash signal is immune by construction.
const LEGACY_EDIT_GRACE_MS = 3 * 60 * 1000;

// How long a launch stays interesting to the watcher. A tab that has been open
// for days without a terminal breadcrumb is a zombie, not a session anyone is
// about to mislead. Callers pass their own; null disables the cutoff.
const DEFAULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function toMs(ts) {
  if (!ts) return null;
  const n = new Date(ts).getTime();
  return Number.isFinite(n) ? n : null;
}

/**
 * Hash of the card text a session would be told to execute. Delegates to
 * attempt-memory's computeContentHash so a card has one hash everywhere;
 * this only normalizes the field names the two card sources use
 * (notion-brain get → {name, notes}; the task mirror → {subject, description}).
 */
function computeCardContentHash(card) {
  if (!card) return null;
  const name = card.name != null ? card.name : (card.title != null ? card.title : card.subject);
  const notes = card.notes != null ? card.notes : card.description;
  return computeContentHash({ name: name || '', notes: notes || '' });
}

/**
 * The launches that are still in flight: for each task, its most recent
 * 'launch' entry, provided nothing terminal has happened to it since.
 *
 * Terminal entries are matched on workspaceRef when they carry one (refs are
 * recycled, so a ref match is only trusted at/after this launch's own ts) and
 * fall back to taskId for the headless job events, which carry no ref.
 *
 * @param {Array<object>} entries - dispatch-ledger readEntries(), any order.
 * @param {{now?:number, maxAgeMs?:number|null}} [opts]
 * @returns {Array<object>} launch entries, oldest first.
 */
function inFlightLaunches(entries, { now = null, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  const list = (Array.isArray(entries) ? entries : []).filter(Boolean);
  const sorted = [...list].sort((a, b) => {
    const at = toMs(a.ts) || 0;
    const bt = toMs(b.ts) || 0;
    return at - bt;
  });

  const latestByTask = new Map();
  for (const e of sorted) {
    if (e.event !== 'launch' || e.taskId == null) continue;
    latestByTask.set(String(e.taskId), e);
  }

  const nowMs = now == null ? Date.now() : now;
  const out = [];
  for (const launch of latestByTask.values()) {
    const launchMs = toMs(launch.ts);
    if (maxAgeMs != null && launchMs != null && nowMs - launchMs > maxAgeMs) continue;

    const ended = sorted.some((e) => {
      if (!TERMINAL_EVENTS.has(e.event)) return false;
      const ems = toMs(e.ts);
      if (ems != null && launchMs != null && ems < launchMs) return false;
      if (e.workspaceRef) return e.workspaceRef === launch.workspaceRef;
      return String(e.taskId) === String(launch.taskId);
    });
    if (ended) continue;
    out.push(launch);
  }
  return out.sort((a, b) => (toMs(a.ts) || 0) - (toMs(b.ts) || 0));
}

/** The newest amend delivered into this launch, or null. */
function lastAmendFor(launch, entries) {
  const launchMs = toMs(launch && launch.ts);
  let best = null;
  for (const e of (Array.isArray(entries) ? entries : [])) {
    if (!e || e.event !== AMEND_EVENT) continue;
    if (String(e.taskId) !== String(launch.taskId)) continue;
    const ems = toMs(e.ts);
    if (ems != null && launchMs != null && ems < launchMs) continue;
    if (e.workspaceRef && launch.workspaceRef && e.workspaceRef !== launch.workspaceRef) continue;
    if (!best || (toMs(e.ts) || 0) >= (toMs(best.ts) || 0)) best = e;
  }
  return best;
}

/**
 * Has this dispatch's card changed since it was seeded into the session?
 *
 * @param {{launch:object, card?:object|null, currentHash?:string|null,
 *   cardLastEditedAt?:string|null, amendments?:Array<object>}} o
 *   launch — the dispatch-ledger 'launch' entry (needs ts, taskId; contentHash
 *            when it was written by a post-#1009 bsc-next).
 *   card   — the CURRENT card (notion-brain get). currentHash/cardLastEditedAt
 *            override its derived values (test seam / already-hashed callers).
 * @returns {{taskId:string|null, workspaceRef:string|null, status:string,
 *   signal:string|null, confidence:'exact'|'weak'|null, drifted:boolean,
 *   dispatchHash:string|null, currentHash:string|null, launchedAt:string|null,
 *   cardLastEditedAt:string|null, amendedAt:string|null, reason:string}}
 */
function detectDrift({ launch, card = null, currentHash = null, cardLastEditedAt = null, amendments = [] } = {}) {
  if (!launch || typeof launch !== 'object') {
    throw new Error('detectDrift requires the dispatch-ledger launch entry');
  }
  const base = {
    taskId: launch.taskId != null ? String(launch.taskId) : null,
    workspaceRef: launch.workspaceRef || null,
    subject: launch.subject || null,
    notionId: launch.notionId || null,
    launchedAt: launch.ts || null,
    dispatchHash: launch.contentHash || null,
    currentHash: currentHash || computeCardContentHash(card),
    cardLastEditedAt: cardLastEditedAt || (card && card.lastEditedAt) || null,
    amendedAt: null,
  };

  const unknown = (reason) => ({
    ...base, status: STATUS.UNKNOWN, signal: null, confidence: null, drifted: false, reason,
  });

  if (!base.currentHash && !base.cardLastEditedAt) {
    return unknown('current card unavailable (no Notion id, or the fetch failed) — drift cannot be decided');
  }

  let drifted = false;
  let signal = null;
  let confidence = null;
  let reason = '';

  if (base.dispatchHash && base.currentHash) {
    drifted = base.dispatchHash !== base.currentHash;
    signal = drifted ? SIGNALS.HASH_MISMATCH : null;
    confidence = drifted ? 'exact' : null;
    reason = drifted
      ? `card body changed after dispatch (dispatched ${base.dispatchHash}, now ${base.currentHash})`
      : `card body unchanged since dispatch (${base.currentHash})`;
  } else {
    // Legacy launch (no hash stamped). Timestamps are all there is.
    const launchMs = toMs(base.launchedAt);
    const editMs = toMs(base.cardLastEditedAt);
    if (launchMs == null || editMs == null) {
      return unknown('launch predates content hashing and has no comparable timestamps');
    }
    drifted = editMs - launchMs > LEGACY_EDIT_GRACE_MS;
    signal = drifted ? SIGNALS.EDITED_AFTER : null;
    confidence = drifted ? 'weak' : null;
    reason = drifted
      ? `card edited ${Math.round((editMs - launchMs) / 60000)} min AFTER dispatch and the launch carries no content hash — ` +
        'the edit may be a status/tag change rather than the work text, so this is a warning, not proof'
      : 'no hash at dispatch, and the card has not been edited since (beyond the dispatch grace window)';
  }

  if (!drifted) return { ...base, status: STATUS.NO_DRIFT, signal, confidence, drifted: false, reason };

  const amend = lastAmendFor(launch, amendments);
  // Only a DELIVERED amend carrying the card's current text clears the drift.
  // An undelivered one (unreachable workspace) is the whole point of the guard.
  if (amend && amend.delivered !== false && base.currentHash && amend.contentHash === base.currentHash) {
    return {
      ...base,
      status: STATUS.AMENDED,
      signal,
      confidence,
      drifted: false,
      amendedAt: amend.ts || null,
      reason: `${reason} — corrected text re-delivered to ${amend.workspaceRef || base.workspaceRef} at ${amend.ts || 'unknown time'}`,
    };
  }

  return {
    ...base,
    status: STATUS.DRIFTED,
    signal,
    confidence,
    drifted: true,
    amendedAt: amend && amend.delivered !== false ? (amend.ts || null) : null,
    reason: amend
      ? `${reason} — an amend was attempted (${amend.delivered === false ? 'NOT delivered' : 'stale text'}) and did not reach the session`
      : reason,
  };
}

/**
 * Drift for every in-flight dispatch.
 *
 * @param {{entries:Array<object>, cards?:object, now?:number,
 *   maxAgeMs?:number|null}} o
 *   cards — { [taskId]: card|null } as fetched by the caller. A task absent
 *           here (or mapped to null) reports 'unknown', never 'no-drift':
 *           a failed fetch must not read as "all good".
 */
function driftReport({ entries = [], cards = {}, now = null, maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
  return inFlightLaunches(entries, { now, maxAgeMs }).map((launch) =>
    detectDrift({ launch, card: cards[String(launch.taskId)] || null, amendments: entries })
  );
}

function summarizeDrift(rows = []) {
  const list = (Array.isArray(rows) ? rows : []).filter(Boolean);
  const drifted = list.filter((r) => r.status === STATUS.DRIFTED);
  const exact = drifted.filter((r) => r.confidence === 'exact');
  return {
    total: list.length,
    drifted: drifted.length,
    exact: exact.length,
    weak: drifted.length - exact.length,
    amended: list.filter((r) => r.status === STATUS.AMENDED).length,
    unknown: list.filter((r) => r.status === STATUS.UNKNOWN).length,
    driftedRows: drifted,
    line: `dispatch-card drift: ${drifted.length}/${list.length} in-flight session(s) are running instructions their card no longer shows ` +
      `(${exact.length} proven by content hash, ${drifted.length - exact.length} suspected from edit time)`,
  };
}

/**
 * The correction to deliver into a live workspace. ONE LINE on purpose: cmux
 * send treats a newline as Enter (submitting a half-typed message), and the
 * literal two-character sequence "\n" the same way — so every newline and
 * backslash in the card body has to go before it is handed to cmux.
 */
function formatAmendMessage({ launch, card, drift, maxChars = 3500 } = {}) {
  const flatten = (s) => String(s == null ? '' : s)
    .replace(/\\/g, '/')          // "\n" typed literally in a card would submit
    .replace(/[\r\n\t]+/g, ' ⏎ ')
    .replace(/\s{2,}/g, ' ')
    .trim();

  const taskId = (launch && launch.taskId) || (drift && drift.taskId) || '?';
  const title = flatten((card && card.name) || (launch && launch.subject) || '');
  const notionId = (card && card.id) || (launch && launch.notionId) || null;
  const body = flatten(card && card.notes);
  const when = (drift && drift.cardLastEditedAt) || 'unknown time';

  // A forced re-delivery of an UNCHANGED card must not claim the session is
  // running stale instructions — that would be the same false statement about
  // dispatch state this module exists to prevent, pointed the other way.
  const head = drift && drift.drifted
    ? `⚠️ CARD CORRECTED SINCE DISPATCH — task #${taskId} "${title}". ` +
      `The instructions you were seeded with are STALE (card last edited ${when}; ${flatten(drift.reason)}). ` +
      `Follow the CURRENT card text below instead, and re-check any work already done against it. `
    : `ℹ️ CARD RE-DELIVERED — task #${taskId} "${title}". ` +
      `No change was detected since dispatch (${flatten(drift && drift.reason)}); this is the current card text for reference. `;
  const tail = notionId
    ? ` — full current card: node scripts/notion-brain.js get ${notionId}`
    : '';

  const room = Math.max(200, maxChars - head.length - tail.length - 30);
  const clipped = body.length > room ? `${body.slice(0, room)}… [truncated]` : body;
  return `${head}CURRENT CARD: ${clipped}${tail}`;
}

// ── watcher policy (bsc-reconcile's 5-min tick) ────────────────────────────

// Every tick costs one Notion read per in-flight session, and bsc-reconcile
// fires 288 times a day. 30 min is fast enough that a correction reaches a
// session while it still matters and slow enough to stay cheap.
const DRIFT_PASS_INTERVAL_MS = 30 * 60 * 1000;
const DRIFT_PASS_EVENT = 'card-drift-pass';
const MAX_DELIVERIES_PER_TICK = 3;

/**
 * Has enough time passed since the last drift pass? Reads the reconcile
 * report's own jsonl lines — no new state file.
 */
function shouldRunDriftPass(reportEntries = [], { now = null, intervalMs = DRIFT_PASS_INTERVAL_MS } = {}) {
  const nowMs = now == null ? Date.now() : now;
  let last = 0;
  for (const e of reportEntries) {
    if (!e || e.kind !== DRIFT_PASS_EVENT) continue;
    const t = toMs(e.ts);
    if (t != null && t > last) last = t;
  }
  return nowMs - last >= intervalMs;
}

/**
 * Which drifted sessions should the watcher auto-correct this tick?
 *
 * ONLY hash-proven drift is delivered. The timestamp-only signal fires on any
 * property edit, so auto-typing a "your instructions are stale" message into
 * a live session on that basis would interrupt working sessions for a tag
 * change. Weak rows are reported, never delivered. Capped per tick so a first
 * run against a backlog of drifted sessions can't spray cmux (and the owner's
 * screen) all at once.
 */
function selectDriftDeliveries(rows = [], { maxPerTick = MAX_DELIVERIES_PER_TICK } = {}) {
  const eligible = (Array.isArray(rows) ? rows : []).filter(
    (r) => r && r.status === STATUS.DRIFTED && r.confidence === 'exact' && r.workspaceRef
  );
  return {
    deliver: eligible.slice(0, maxPerTick),
    deferred: eligible.slice(maxPerTick),
    reportOnly: (Array.isArray(rows) ? rows : []).filter(
      (r) => r && r.status === STATUS.DRIFTED && r.confidence !== 'exact'
    ),
  };
}

/**
 * Is it unsafe to type into this session right now? (ship-check P0, GPT pass.)
 *
 * `cmux send <text>` + Enter is keystrokes, not an API. Typed into a normal
 * Claude Code prompt they queue harmlessly (verified live 2026-08-05 against
 * this session's own workspace: the text landed as a queued user message).
 * Typed at a SELECTION prompt — the permission dialog's "Do you want to
 * proceed? ❯ 1. Yes / 2. Yes, and don't ask again / 3. No" — the same
 * keystrokes answer the dialog instead, choosing an option nobody chose.
 * That is the one state where delivering a correction can do real harm, so
 * refuse there and let the next pass retry (self-healing: the drift is still
 * recorded, and 30 minutes later the dialog is usually gone).
 *
 * Scoped to the BOTTOM of the screen and to line-start matches, both learned
 * from a real false positive (2026-08-05): the first version scanned the whole
 * 60-line dump and refused to deliver into a healthy session because the
 * scrollback happened to be showing THIS FILE's own test fixture — the string
 * "❯ 1. Yes" quoted inside a diff. A live dialog always renders in the input
 * region at the bottom and always starts its own line; transcript text
 * quoting one does neither.
 *
 * @param {string} screenText - `cmux read-screen` output.
 * @param {{tailLines?: number}} [opts]
 */
function looksUnsafeToType(screenText, { tailLines = 15 } = {}) {
  const s = String(screenText || '');
  if (!s.trim()) return false; // no reading = no evidence of a dialog; other guards cover liveness
  const tail = s.split('\n').slice(-Math.max(1, tailLines)).join('\n');
  // An arrow-marked numbered choice list is the shape every Claude Code
  // permission/selection dialog shares, whatever its wording.
  if (/^\s*❯\s*\d+\.\s/m.test(tail)) return true;
  if (/^\s*\d+\.\s+(Yes|No)\b/m.test(tail)) return true;
  if (/\(y\/n\)\s*$/im.test(tail)) return true;
  if (/^\s*Do you want to (proceed|continue|make this edit|create)/im.test(tail)) return true;
  return false;
}

/** The ledger line to append after an amend attempt (delivered or not). */
function amendEntry({ taskId, workspaceRef, contentHash, delivered, signal = null, note = null }) {
  return {
    event: AMEND_EVENT,
    taskId: String(taskId),
    workspaceRef: workspaceRef || null,
    contentHash: contentHash || null,
    delivered: delivered === true,
    signal,
    note,
  };
}

module.exports = {
  TERMINAL_EVENTS, AMEND_EVENT, STATUS, SIGNALS,
  LEGACY_EDIT_GRACE_MS, DEFAULT_MAX_AGE_MS,
  DRIFT_PASS_INTERVAL_MS, DRIFT_PASS_EVENT, MAX_DELIVERIES_PER_TICK,
  computeCardContentHash, inFlightLaunches, lastAmendFor,
  detectDrift, driftReport, summarizeDrift, formatAmendMessage, amendEntry,
  shouldRunDriftPass, selectDriftDeliveries, looksUnsafeToType,
};
