/**
 * recurrence-classes.js — group Linear cards into PROBLEM CLASSES and decide
 * which classes are recurring (BRO-7103, child of BRO-3425).
 *
 * WHY THIS EXISTS. Owner, 2026-11-07: "ensure most or all of our work is not
 * just spot fixing but fixing root causes and adding systems to improve
 * things. Continuous improvement". Evidence on the card: in 30 days 37 titles
 * were filed 3+ times (286 cards) while the structural card BRO-3425 sat in
 * Todo for 8 weeks and the instance cards kept closing Done. Nothing noticed
 * that the same problem kept coming back. This module is the "notice" half:
 * pure functions over cards + the alert ledger, no I/O, so the CLI
 * (scripts/recurrence-detector.js), the Done gate (linear-brain.js), the
 * worker picker (cloud-worker-pick.js) and the digest row (health-check.js)
 * all read the same verdict.
 *
 * A CLASS is card-dedupe.js titleKind() of the title once filer prefixes
 * ("Auto-fix (second try):", "[E2E Canary]", "Fix:") are stripped: the
 * same key the flood/rollup rules use, so the two never disagree about what
 * "the same kind of card" means (plan review 2026-11-07). titleKind drops
 * quoted subjects, parentheticals, numbers and dates, so every "main test.yml
 * red: Unit Tests / Run unit tests — "<test>"" card is one class per JOB (the
 * per-signature split of BRO-3865 stays for routing instances), and
 * "National tour pages show wrong information: 8 page problem(s)
 * (poster-missing)" joins its siblings; the subtype is kept (`subtypes`) and
 * listed on the root-cause card instead of splitting the class.
 *
 * Expected repeats (canaries, dated scheduled audits) are classified but
 * never escalated: they are SUPPOSED to be filed every day.
 */

'use strict';

const cardDedupe = require('./card-dedupe.js');

// Versioned: a change to the key function bumps KEY_VERSION, and a root card
// carrying an older version is still found through its listed instances
// (rootCardByOverlap) instead of getting a duplicate.
const KEY_VERSION = 'v1';
// Plain text lines: Linear drops HTML comments from descriptions and comments
// (only 1 card in 200 days kept a "<!--", inside prose; ship-check BRO-7103).
// The old comment form is still parsed.
const ROOT_CAUSE_MARKER_RE = /^[ \t]*(?:<!--[ \t]*)?root-cause-class:[ \t]*(?:(v\d+):)?([^\n]+?)[ \t]*(?:-->)?[ \t]*$/m;
const STATUS_COMMENT_MARKER = 'recurrence-detector-status:';

// Filer prefixes that say WHO filed a card, not WHAT the problem is. Applied
// repeatedly (a card can be "BSC Daily: Auto-fix: …").
const FILER_PREFIX_RE = /^\s*(?:\[[^\]]{1,40}\]\s*|(?:bsc daily|auto-fix(?:\s*\([^)]*\))?|fix|p[0-4]|re-?open(?:ed)?|follow-?up)\s*:\s*)/i;

// Cards that are SUPPOSED to repeat. Matched against the raw TITLE (the key
// loses words like "[E2E Canary]"). Each entry carries the reason, which the
// backtest report prints. Failures of a scheduled thing ("Morning digest did
// not arrive") are NOT expected repeats: they are the thing breaking again.
const EXPECTED_REPEATS = [
  { re: /canary/i, reason: 'canary: filed on purpose to prove the alert chain works' },
  { re: /^\s*opening-night (?:audit|watch) \d{4}-\d{2}-\d{2}\b/i, reason: 'scheduled per-night opening-night audit/watch log card' },
  { re: /^\s*week in review\b/i, reason: 'weekly report' },
  { re: /^\s*land dependabot pr\b/i, reason: 'dependabot landing, one per bump' },
  { re: /^\s*commercial scorecard corrections part\b/i, reason: 'numbered work batches of one project' },
  { re: /^\s*commercial data: pending review\b/i, reason: 'owner review queue, one card per batch' },
];

// Classes whose per-day card is a work queue item produced by a scanner,
// where the instance count measures the scanner's output, not a failure
// coming back. Still classified; escalated only on ledger reopen, never on
// count. Empty on purpose until the backtest shows a real false positive.

// Static root-cause cards that predate the detector, matched against the
// raw TITLE of the class's instances (majority wins). Keep tiny: the marker
// (a `root-cause-class: v1:KEY` line) is the normal path. BRO-3425 is the
// structural "main CI keeps going red" card; every per-job main-red class
// reuses it so the detector never files a second one (BRO-7103 card text).
const ROOT_CAUSE_OVERRIDES = [
  { re: /^\s*(?:p[0-4]:\s*)?(?:fix )?main(?: test\.yml| ci)? (?:is )?(?:still )?red\b/i, card: 'BRO-3425' },
];

function stripFilerPrefixes(title) {
  let t = String(title || '');
  for (let i = 0; i < 5; i++) {
    const next = t.replace(FILER_PREFIX_RE, '');
    if (next === t) break;
    t = next;
  }
  return t;
}

/** The parenthetical subtype of a title, e.g. "poster-missing". */
function subtypeOf(title) {
  const m = String(title || '').match(/\(([^)]{2,60})\)\s*$/);
  return m ? m[1].trim().toLowerCase() : null;
}

/**
 * classKey(title) -> string. Deterministic, order-sensitive normaliser.
 * Never returns '' for a non-empty title (falls back to the lowercased title).
 */
function classKey(title) {
  return cardDedupe.titleKind(stripFilerPrefixes(title));
}

function expectedRepeatReason(title) {
  const hit = EXPECTED_REPEATS.find((e) => e.re.test(String(title || '')));
  return hit ? hit.reason : null;
}

/** Override root card for a class: the one most of its instance titles match. */
function overrideRootCause(instances) {
  for (const o of ROOT_CAUSE_OVERRIDES) {
    const n = instances.filter((c) => o.re.test(c.title || '') || o.re.test(stripFilerPrefixes(c.title))).length;
    if (n && n * 2 > instances.length) return o.card;
  }
  return null;
}

/** {version, key} carried by a root-cause card's description, or null. */
function rootCauseMarker(description) {
  const m = String(description || '').match(ROOT_CAUSE_MARKER_RE);
  return m ? { version: m[1] || 'v0', key: m[2] } : null;
}

function markerLine(key) {
  return `root-cause-class: ${KEY_VERSION}:${key}`;
}

/** BRO ids a root card lists (its description names its instances). */
function listedIds(description) {
  return new Set(String(description || '').match(/\bBRO-\d+\b/g) || []);
}

const ms = (iso) => (iso ? Date.parse(iso) : NaN);
const DAY = 864e5;

/**
 * Ledger conditions that REOPENED after a resolve: the router keeps
 * firstSeen forever and moves incidentOpenedAt when a resolved condition
 * fires again (owner-alert-router.js "A resolved condition that reoccurs is
 * treated as a NEW incident"). An hour of slack absorbs same-run writes.
 */
function ledgerReopens(ledger) {
  const out = [];
  const conds = (ledger && ledger.conditions) || {};
  for (const [key, c] of Object.entries(conds)) {
    const first = ms(c.firstSeen);
    const opened = ms(c.incidentOpenedAt);
    // A real reopen needs a recorded resolve BEFORE the current incident
    // opened. incidentOpenedAt also moves after a 96h quiet gap with no
    // resolve at all (owner-alert-router.js currentIncidentOpenedAt), which
    // is not "fixed, then came back" (plan review: 49 of 163 were that).
    const resolved = ms(c.resolvedAt);
    if (Number.isFinite(first) && Number.isFinite(opened) && opened - first > 36e5
        && Number.isFinite(resolved) && resolved <= opened) {
      out.push({ conditionKey: key, reopenedAt: c.incidentOpenedAt, firstSeen: c.firstSeen, card: c.linearIdentifier || null, title: c.title || '' });
    }
  }
  return out;
}

const isDone = (card) => (card.state && card.state.type === 'completed') || (!!card.completedAt && !card.canceledAt);
const isOpen = (card) => !card.state || !['completed', 'canceled', 'duplicate'].includes(card.state.type);

/**
 * detectClasses(cards, ledger, opts) -> Map<key, cls>
 *   cards: [{identifier,title,createdAt,completedAt,canceledAt,state:{type},description,relationIds?:string[]}]
 *   opts.now (ms), opts.windowDays (30), opts.minInstances (3)
 * cls: {key, instances, inWindow, firstSeen, lastSeen, reopens, expected,
 *       recurring, reasons, rootCause, subtypes}
 */
function detectClasses(cards, ledger, opts = {}) {
  const now = opts.now != null ? opts.now : Date.now();
  const windowDays = opts.windowDays || 30;
  const minInstances = opts.minInstances || 3;
  const since = now - windowDays * DAY;
  const byId = new Map();
  const classes = new Map();
  const rootCards = []; // [{card, marker, listed}]

  for (const card of cards) {
    if (!card || !card.title || ms(card.createdAt) > now) continue;
    byId.set(card.identifier, card);
    const marker = rootCauseMarker(card.description);
    if (marker) {
      rootCards.push({ card, marker, listed: listedIds(card.description) });
      continue; // a root-cause card is never its own instance
    }
    const key = classKey(card.title);
    if (!key) continue; // junk title ("x"): nothing to group on
    if (!classes.has(key)) {
      classes.set(key, { key, instances: [], inWindow: 0, firstSeen: null, lastSeen: null, reopens: [], subtypes: {} });
    }
    const cls = classes.get(key);
    cls.instances.push(card);
    if (ms(card.createdAt) >= since) cls.inWindow++;
    const st = subtypeOf(card.title);
    if (st) cls.subtypes[st] = (cls.subtypes[st] || 0) + 1;
    if (!cls.firstSeen || card.createdAt < cls.firstSeen) cls.firstSeen = card.createdAt;
    if (!cls.lastSeen || card.createdAt > cls.lastSeen) cls.lastSeen = card.createdAt;
  }

  // Ledger reopens join the class of the card the condition filed.
  for (const r of ledgerReopens(ledger)) {
    const at = ms(r.reopenedAt);
    if (!(at >= since && at <= now)) continue;
    const card = r.card && byId.get(r.card);
    const key = card && !rootCauseMarker(card.description) ? classKey(card.title) : null;
    if (key && classes.has(key)) classes.get(key).reopens.push(r);
  }

  for (const cls of classes.values()) {
    cls.instances.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    // Expected when most of its cards are scheduled repeats (canary etc.).
    const exp = cls.instances.map((c) => expectedRepeatReason(c.title)).filter(Boolean);
    cls.expected = exp.length * 2 > cls.instances.length ? exp[0] : null;
    cls.reasons = [];
    if (cls.inWindow >= minInstances) cls.reasons.push(`${cls.inWindow} cards in ${windowDays} days`);
    if (cls.reopens.length) cls.reasons.push(`${cls.reopens.length} alert(s) came back after being resolved`);
    cls.suspect = suspectReason(cls.instances, cls.reopens);
    cls.recurring = !cls.expected && !cls.suspect && cls.reasons.length > 0;
    // Root card: exact current-version marker first, then any marker whose
    // listed instances overlap this class by half or more (survives a key
    // change), then the static override.
    const ids = new Set(cls.instances.map((c) => c.identifier));
    const exact = rootCards.filter((r) => r.marker.key === cls.key);
    const overlap = rootCards.filter((r) => r.marker.key !== cls.key && r.listed.size
      && [...r.listed].filter((id) => ids.has(id)).length * 2 >= Math.min(r.listed.size, ids.size));
    const marked = [...exact, ...overlap].map((r) => r.card).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    const live = marked.filter((c) => c.state && c.state.type !== 'canceled' && c.state.type !== 'duplicate');
    const pick = live[0] || marked[0];
    cls.rootCause = pick ? pick.identifier : overrideRootCause(cls.instances);
    cls.extraRootCauses = exact.map((r) => r.card.identifier).filter((id) => id !== cls.rootCause); // >0 = duplicate bug, reported
  }
  return classes;
}

/**
 * Why a class that crossed the count is probably NOT a problem coming back,
 * or null. Backtest 2026-11-07: 13 of 65 flagged classes were one of these.
 *  - every card canceled/duplicate: nobody had anything to fix (a noisy
 *    filer the flood rules already fold, or a retitled plan);
 *  - every card filed within 24h: one incident filed several times.
 * Ledger reopens override both (a resolved alert came back: real).
 */
function suspectReason(instances, reopens = []) {
  if (reopens.length) return null;
  if (!instances.some((c) => isDone(c) || isOpen(c))) return 'every card was canceled or a duplicate';
  const ts = instances.map((c) => ms(c.createdAt)).filter(Number.isFinite);
  if (ts.length && Math.max(...ts) - Math.min(...ts) < DAY) return 'all cards filed within 24 hours (one incident, not a repeat)';
  return null;
}

/** PREVENTION: lines in a text blob. */
function preventionLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    const m = line.match(/^\s*(?:[-*]\s+)?(?:\*\*)?PREVENTION:(?:\*\*)?\s*(.+)$/);
    if (m) out.push(m[1].trim().slice(0, 300));
  }
  return out;
}

/**
 * Prevention claims of a class, each checked against what happened next:
 * a claim FAILED when another instance of the class was filed after the
 * claiming card was completed. `commentsById` maps identifier -> [body].
 */
function checkPreventionClaims(cls, commentsById = {}) {
  const claims = [];
  for (const card of cls.instances) {
    if (!isDone(card) || !card.completedAt) continue;
    const texts = [card.description || '', ...(commentsById[card.identifier] || [])];
    const lines = texts.flatMap(preventionLines);
    const doneAt = ms(card.completedAt);
    const next = cls.instances.find((c) => ms(c.createdAt) > doneAt);
    // claim:null = closed with no PREVENTION line at all (counted apart, so
    // "no failed preventions" can't come from nobody claiming any).
    claims.push({ card: card.identifier, completedAt: card.completedAt, claim: lines.length ? lines[lines.length - 1] : null, failed: !!(lines.length && next), recurredAs: next ? next.identifier : null });
  }
  return claims;
}

/**
 * Kind of finished work: 'root-cause' (a root-cause card), 'instance' (a
 * member of a class with 2+ cards, or auto-filed), or 'system' (one-off
 * build). The digest's root-cause share = (root-cause + system) / all Done.
 */
const AUTO_FILED_RE = /^\s*(?:\[[^\]]+\]|bsc daily:|auto-fix|main test\.yml|main red|cron stale|time-bomb test armed|t1\/t2 review stuck)/i;
function workKind(card, classes, ledgerCards = new Set(), comments = null) {
  // What the closer declared wins (item 8): a full ROOT-CAUSE block is
  // root-cause work, NO-ROOT-CAUSE is a spot fix (root-cause-close.js).
  if (comments && comments.length) {
    const declared = require('./root-cause-close.js').checkRootCauseClose({ title: card.title, texts: comments });
    if (declared.kind === 'root-cause') return 'root-cause';
    if (declared.kind === 'spot') return 'instance';
  }
  if (rootCauseMarker(card.description)) return 'root-cause';
  if (ROOT_CAUSE_OVERRIDES.some((o) => o.card === card.identifier)) return 'root-cause';
  const cls = classes.get(classKey(card.title));
  if (cls && cls.instances.length >= 2) return 'instance';
  if (AUTO_FILED_RE.test(card.title) || ledgerCards.has(card.identifier)) return 'instance';
  // A one-off fix that declared nothing is a spot fix, not system work
  // (BRO-7103 review: counting it as system inflated the share).
  if (require('./root-cause-close.js').isFixCard({ title: card.title })) return 'instance';
  return 'system';
}

/** Share of Done work in [from,to) that was root-cause or system work. */
function rootCauseShare(cards, classes, { from, to, ledgerCards, commentsById = {} } = {}) {
  const done = cards.filter((c) => isDone(c) && c.completedAt && ms(c.completedAt) >= from && ms(c.completedAt) < to && !expectedRepeatReason(c.title));
  const counts = { 'root-cause': 0, system: 0, instance: 0 };
  for (const c of done) counts[workKind(c, classes, ledgerCards, commentsById[c.identifier])]++;
  const total = done.length;
  return { total, ...counts, share: total ? Math.round(((counts['root-cause'] + counts.system) / total) * 1000) / 10 : null };
}

/**
 * Advisory close check for one card, from the committed classes snapshot
 * (data/audit/recurrence-classes.json). Returns null when nothing to say.
 * `relatedIds` are identifiers the card already relates to.
 */
const CLOSE_GATE_BLOCKING_FROM = '2026-12-15';
const CLOSE_GATE_SNAPSHOT_MAX_MS = 48 * 36e5;

/**
 * PURE. Does the "name the root card" check refuse the close? Only from
 * CLOSE_GATE_BLOCKING_FROM, only on a snapshot under 48h old (a stale one
 * fails open), and never with RECURRENCE_CLOSE_GATE=advisory (rollback, no deploy).
 */
function recurrenceCloseBlocking(snapshot, nowMs = Date.now(), env = process.env) {
  if (String(env.RECURRENCE_CLOSE_GATE || '').toLowerCase() === 'advisory') return false;
  if (!snapshot || !(nowMs - ms(snapshot.generatedAt) < CLOSE_GATE_SNAPSHOT_MAX_MS)) return false;
  return nowMs >= Date.parse(`${CLOSE_GATE_BLOCKING_FROM}T00:00:00Z`);
}

function recurrenceCloseWarning(identifier, snapshot, relatedIds = [], blocking = false) {
  if (!snapshot || !snapshot.instances) return null;
  const hit = snapshot.instances[identifier];
  if (!hit || !hit.rootCause || hit.rootCause === identifier) return null;
  if (relatedIds.includes(hit.rootCause)) return null;
  return `${identifier} is one more case of a problem that keeps coming back ("${hit.classKey}"). ` +
    `Name the root-cause card ${hit.rootCause} in the close comment (or link it) so the fix lands on the cause, not one more case. ` +
    (blocking
      ? `Refused until it is named (BRO-7103; rollback: RECURRENCE_CLOSE_GATE=advisory).`
      : `Advisory now; blocking from ${CLOSE_GATE_BLOCKING_FROM} (BRO-7103).`);
}

/**
 * PURE. Why the cloud picker should leave this instance card for now, or
 * null. Only while its root-cause card is actually being worked: In Progress,
 * or a START-NOW Todo under 48h old (cloud-worker-pick's START-NOW window).
 * A P0 (Urgent) card is never held back: a live outage beats the cause.
 * A stale snapshot (>48h) routes nothing.
 */
const ROUTE_STALE_MS = 48 * 36e5;
const ROOT_WORK_MAX_MS = 14 * 24 * 36e5;
function rootCauseRouteReason(issue, snapshot, nowMs = Date.now()) {
  // Urgent and High cases (main red, outages) are never held back.
  if (!issue || !snapshot || !snapshot.instances || [1, 2].includes(Number(issue.priority))) return null;
  if (!(nowMs - ms(snapshot.generatedAt) <= ROUTE_STALE_MS)) return null;
  const hit = snapshot.instances[issue.identifier];
  if (!hit || !hit.rootCause || hit.rootCause === issue.identifier) return null;
  const cls = (snapshot.classes || []).find((c) => c.key === hit.classKey && c.rootCause === hit.rootCause);
  if (!cls) return null;
  // A root card left In Progress for weeks is not being worked: stop holding
  // its cases back (startedAt, not updatedAt: the detector's own comments
  // bump updatedAt every day).
  const startedAt = ms(cls.rootCauseStartedAt);
  // No start time means no way to age it out: do not hold cases behind it.
  const working = (cls.rootCauseState === 'started' && Number.isFinite(startedAt) && nowMs - startedAt <= ROOT_WORK_MAX_MS)
    || (cls.rootCauseState === 'unstarted' && cls.rootCauseStartedNow && nowMs - ms(cls.rootCauseCreatedAt) < ROUTE_STALE_MS);
  return working ? 'routed-to-root-cause' : null;
}

/**
 * PURE. The morning digest's one improvement line, plain English, from the
 * detector snapshot. Share = root-cause or new-system work / all Done work
 * (expected repeats such as canaries left out).
 */
/**
 * PURE. Cases created after the class's root card was closed (done, canceled
 * or duplicate): the cause fix did not hold. [] when the root is open.
 */
function recurredAfterRootClosed(root, instances) {
  if (!root || !root.state || !['completed', 'canceled', 'duplicate'].includes(root.state.type)) return [];
  const closedAt = ms(root.completedAt || root.canceledAt);
  if (!Number.isFinite(closedAt)) return [];
  return instances.filter((c) => ms(c.createdAt) > closedAt).map((c) => c.identifier);
}

function improvementLine(snap) {
  if (!snap || !snap.share) return null;
  const tw = snap.share.thisWeek || {};
  const lw = snap.share.lastWeek || {};
  const pct = (v) => (v == null ? 'n/a' : `${Math.round(v)}%`);
  const waiting = snap.recurringCount - snap.withRootCause;
  const parts = [
    `Fixing causes: ${pct(tw.share)} of the ${tw.total || 0} cards finished this week fixed a cause or added a system, the rest fixed one more case of a repeat problem (last week ${pct(lw.share)}).`,
    `${snap.recurringCount} problem${snap.recurringCount === 1 ? '' : 's'} keep coming back; ${snap.withRootCause} ha${snap.withRootCause === 1 ? 's' : 've'} a card to fix the cause${waiting > 0 ? `, ${waiting} more get one over the next days` : ''}.`,
  ];
  const p = snap.preventions || {};
  if (p.failed) parts.push(`${p.failed} fix${p.failed === 1 ? '' : 'es'} claimed to stop a repeat, and it came back anyway.`);
  const reopened = (snap.classes || []).filter((c) => c.recurredAfterRootClosed && c.recurredAfterRootClosed.length).length;
  if (reopened) parts.push(`${reopened} problem${reopened === 1 ? '' : 's'} came back after the card fixing the cause was closed.`);
  const smp = snap.sample;
  const decided = smp ? (smp.rootCause || 0) + (smp.spot || 0) : 0;
  if (smp && decided >= 4 && smp.share != null && smp.calibrationOk === true && Date.now() - ms(smp.generatedAt) <= 8 * 24 * 36e5) {
    parts.push(`An independent check of ${decided} fixes from this week, reading only the code, found ${smp.rootCause} of ${decided} fixed the cause.`);
  }
  return parts.join(' ');
}

module.exports = {
  improvementLine,
  recurredAfterRootClosed,
  rootCauseRouteReason,
  KEY_VERSION,
  ROOT_CAUSE_MARKER_RE,
  markerLine,
  listedIds,
  STATUS_COMMENT_MARKER,
  EXPECTED_REPEATS,
  ROOT_CAUSE_OVERRIDES,
  CLOSE_GATE_BLOCKING_FROM,
  recurrenceCloseBlocking,
  stripFilerPrefixes,
  subtypeOf,
  classKey,
  expectedRepeatReason,
  overrideRootCause,
  rootCauseMarker,
  ledgerReopens,
  suspectReason,
  detectClasses,
  preventionLines,
  checkPreventionClaims,
  workKind,
  rootCauseShare,
  recurrenceCloseWarning,
  isDone,
  isOpen,
};
