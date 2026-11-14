'use strict';

/**
 * land-train.js — pure decisions for BRO-5282's merge train.
 *
 * Measured 2026-10-13 (20 landings, 14:10-16:05 UTC): the landing mutex was
 * ~95% busy and each hold was land.js re-checking ONE branch on the merged
 * tree (2.7-9 min; the verified-base skip never applied because main had
 * moved across 84-438 substantive files during the ~1h queue wait), so the
 * queue drained at ~10 landings/hour.
 *
 * The train: the mutex holder also takes the branches whose Land runs are
 * WAITING in the mutex queue right now (live tickets only, never parked
 * runs), rebases them after itself in queue order, runs ONE merged-tree
 * re-check on the combined diff, and fast-forwards main once. Each rider is
 * landed only at the exact tip its own checks job verified (the ticket
 * carries that tip and base, and the land/** ref must still point at it),
 * and the combined tree gets the same in-mutex re-check a solo landing gets
 * against a main that already holds the others, on a superset of files. A
 * red train falls back to the holder alone (today's behavior). The riders'
 * own runs see a marker ref and finish without the lock:
 *
 *   refs/land-mutex/landed/<rider tip>  →  the rider's landed commit on main
 *
 * The rider tip and verified base ride in the queue ticket's commit message
 * (Land-Branch/Land-Tip/Land-Base trailers written by scripts/land-mutex.js),
 * so forming a train costs git ls-remote/fetch plus one run lookup per rider.
 */

const { isMainRedBranch } = require('./land-main-red');

const MARKER_PREFIX = 'refs/land-mutex/landed/';
// Holder + 3 riders. The park depth (land-mutex PARK_DEPTH = 4) keeps about
// that many live tickets, so a larger cap would rarely fill.
const DEFAULT_TRAIN_MAX = 4;
const SHA_RE = /^[0-9a-f]{40}$/;

const markerRef = (tip) => {
  if (!SHA_RE.test(String(tip || ''))) throw new Error(`markerRef: tip must be a 40-hex sha (got ${JSON.stringify(tip)})`);
  return `${MARKER_PREFIX}${tip}`;
};

/** `git ls-remote origin 'refs/land-mutex/*'` text → { <tip>: <landed sha> }. */
function parseMarkers(text) {
  const out = {};
  for (const line of String(text || '').split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref || !ref.startsWith(MARKER_PREFIX)) continue;
    const tip = ref.slice(MARKER_PREFIX.length);
    if (SHA_RE.test(tip) && SHA_RE.test(sha)) out[tip] = sha;
  }
  return out;
}

/** Trailers a ticket commit carries (scripts/land-mutex.js newTicketCommit). */
function ticketTrailers({ branch, tip, base }) {
  const lines = [];
  if (branch) lines.push(`Land-Branch: ${branch}`);
  if (SHA_RE.test(String(tip || ''))) lines.push(`Land-Tip: ${tip}`);
  if (SHA_RE.test(String(base || ''))) lines.push(`Land-Base: ${base}`);
  return lines;
}

/** Ticket commit message → {branch, tip, base}; null unless branch and tip are both there. */
function parseTicketMessage(message) {
  const get = (k) => {
    const m = new RegExp(`^${k}:\\s*(\\S+)\\s*$`, 'm').exec(String(message || ''));
    return m ? m[1] : null;
  };
  const branch = get('Land-Branch');
  const tip = get('Land-Tip');
  const base = get('Land-Base');
  if (!branch || !SHA_RE.test(String(tip || ''))) return null;
  return { branch, tip, base: SHA_RE.test(String(base || '')) ? base : null };
}

/** LAND_TRAIN_MAX (repo variable): train size including the holder; < 2 turns trains off. */
function trainMax(env = process.env) {
  const raw = env.LAND_TRAIN_MAX;
  if (raw === undefined || raw === '') return DEFAULT_TRAIN_MAX;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : DEFAULT_TRAIN_MAX;
}

/**
 * Which queued landings ride with the holder.
 *   holderBranch  this run's land/** branch
 *   self          {runId, attempt} of this run (its own ticket is skipped)
 *   tickets       land-mutex parseLsRemote().tickets, queue order, each with
 *                 info ({branch, tip, base} from its commit or null),
 *                 remoteTip (the land/** ref's sha now, or null) and
 *                 liveness ('live' | 'gone' | undefined when unreadable)
 *   markers       parseMarkers() — a tip that already has one is not taken again
 *   max           trainMax()
 * Returns {riders:[{branch, tip, base, runId, attempt}], skipped:[{ref, reason}], reason}.
 * Fails closed: anything not proven eligible stays in the queue for its own turn.
 */
function selectRiders({ holderBranch, self, tickets = [], markers = {}, max = DEFAULT_TRAIN_MAX } = {}) {
  const none = (reason) => ({ riders: [], skipped: [], reason });
  if (!(max >= 2)) return none(`trains off (max ${max})`);
  if (isMainRedBranch(holderBranch)) return none('holder is a main-red lane: it lands alone');
  const isSelf = (t) => self && t.runId === String(self.runId) && Number(t.attempt) === Number(self.attempt);
  const others = tickets.filter((t) => !isSelf(t));
  // BRO-5096: a main-red fix waiting behind us must not wait for a longer hold.
  if (others.some((t) => t.prio === 0)) return none('a main-red landing is queued: no train');
  const riders = [];
  const skipped = [];
  const seen = new Set([holderBranch]);
  for (const t of others) {
    const skip = (reason) => skipped.push({ ref: t.ref, reason });
    if (riders.length >= max - 1) { skip('train full'); continue; }
    const info = t.info;
    if (!info) { skip('ticket carries no verified tip'); continue; }
    if (isMainRedBranch(info.branch)) { skip('main-red lane'); continue; }
    if (seen.has(info.branch)) { skip('branch already in the train'); continue; }
    if (info.tip !== t.remoteTip) { skip(`land ref moved (${String(t.remoteTip || 'gone').slice(0, 10)} ≠ verified ${info.tip.slice(0, 10)})`); continue; }
    if (markers[info.tip]) { skip('already landed by an earlier train'); continue; }
    if (t.liveness !== 'live') { skip(`run not confirmed live (${t.liveness || 'unreadable'})`); continue; }
    seen.add(info.branch);
    riders.push({ branch: info.branch, tip: info.tip, base: info.base, runId: t.runId, attempt: t.attempt });
  }
  return { riders, skipped, reason: riders.length ? `${riders.length} rider(s)` : 'no eligible rider' };
}

/**
 * The landed commit of each train segment. commits: base..HEAD oldest first;
 * counts: [holder, rider1, ...] commit counts as assembled. A re-rebase that
 * dropped or added commits shifts every position, so a length mismatch
 * returns null (no rider gets a marker; each rider's own run lands itself).
 */
function segmentHeads(commits, counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!Array.isArray(commits) || commits.length !== total || counts.some((c) => !(c > 0))) return null;
  const heads = [];
  let at = 0;
  for (const c of counts) { at += c; heads.push(commits[at - 1]); }
  return heads;
}

/**
 * A follower's verdict from its marker: landed only when the marker exists
 * AND its sha is an ancestor of origin/main (ancestor: true | false | null).
 */
function decideFollower({ markerSha, ancestor }) {
  if (!markerSha) return { landed: false, reason: 'no train marker' };
  if (ancestor !== true) return { landed: false, reason: `train marker ${String(markerSha).slice(0, 10)} is not ${ancestor === false ? '' : 'confirmed '}on main` };
  return { landed: true, reason: `landed by a merge train as ${String(markerSha).slice(0, 10)}` };
}

/**
 * The verified tip of a Land run whose workflow file predates the train (it
 * passes no LAND_TIP): a push-triggered run's head_sha is the tip it was
 * started for, and it counts only while the land/** ref still points there
 * (a newer push has its own run). Anything else → null (never a rider).
 */
function tipFromRun({ event, headSha, refSha }) {
  if (event !== 'push') return null;
  if (!SHA_RE.test(String(headSha || '')) || headSha !== refSha) return null;
  return headSha;
}

/** Does `self` hold the landing lock in this ls-remote state? */
function holdsLock(state, self) {
  const lock = state && state.lock;
  if (!lock || !self) return false;
  return (state.tickets || []).some((x) => x.sha === lock.sha && x.runId === String(self.runId) && Number(x.attempt) === Number(self.attempt));
}

/**
 * Merge trains in data/audit/landings.jsonl rows: the holder's run writes its
 * own row and its riders' rows with the same runUrl, so a runUrl naming 2+
 * distinct branches is one train. Rows before `since` (ISO) are ignored.
 * → [{runUrl, branches:[...], shas:[...]}]
 */
function trainsFromLandings(rows, since = '') {
  const byRun = new Map();
  for (const r of rows || []) {
    if (!r || !r.runUrl || !r.branch || String(r.ts || '') < since) continue;
    const g = byRun.get(r.runUrl) || { runUrl: r.runUrl, branches: [], shas: [] };
    if (!g.branches.includes(r.branch)) { g.branches.push(r.branch); g.shas.push(r.sha); }
    byRun.set(r.runUrl, g);
  }
  return [...byRun.values()].filter((g) => g.branches.length >= 2);
}

// A rider's own run reads its marker within one queue poll; past the Land
// job's whole life (125 min) a marker can only be a leak.
const MARKER_MAX_AGE_SEC = 6 * 3600;

/**
 * Markers nobody needs: no land/** ref points at the tip any more, or the
 * landed commit is older than MARKER_MAX_AGE_SEC (ageSec: {tip: seconds},
 * from the commit date; unknown age keeps the marker).
 */
function staleMarkers(markers, landTips, ageSec = {}) {
  const live = new Set(landTips || []);
  return Object.keys(markers || {}).filter((tip) => !live.has(tip) || (ageSec[tip] !== undefined && ageSec[tip] > MARKER_MAX_AGE_SEC));
}

module.exports = {
  MARKER_PREFIX, DEFAULT_TRAIN_MAX, MARKER_MAX_AGE_SEC, markerRef, parseMarkers, ticketTrailers, parseTicketMessage, trainMax,
  selectRiders, segmentHeads, tipFromRun, holdsLock, trainsFromLandings, decideFollower, staleMarkers,
};
