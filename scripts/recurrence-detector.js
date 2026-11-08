#!/usr/bin/env node
/**
 * Recurrence detector (BRO-7103): notices when we keep spot-fixing the same
 * problem and turns the problem CLASS into one root-cause card.
 *
 * A class is recurring at 3+ cards in 30 days, or when one of its alert
 * conditions came back after being resolved. Each recurring class gets
 * exactly one root-cause card (P1, START-NOW, marker
 * `<!-- root-cause-class: v1:KEY -->`); later runs comment the new instances
 * on it instead of filing again. Grouping logic: scripts/lib/recurrence-classes.js.
 *
 * Modes:
 *   (default)                dry run: print what --apply would do, write the snapshot
 *   --apply                  file/comment root-cause cards (cap 3 new per run)
 *   --backtest [--days 60]   replay day by day, write data/audit/recurrence-backtest.json
 *                            + docs/recurrence-backtest.md (hit list, false positives)
 *   --check                  exit 0 when the snapshot is fresh, complete and has no
 *                            class with two root cards (BRO-7103's VERIFY)
 *   --check-class KEY|SLUG   exit 0 when the class has had no new card for 21 days
 *                            (a root-cause card's VERIFY); 3 = snapshot stale
 *   --input FILE             read cards from a JSON file instead of Linear
 *   --no-write               don't write the snapshot
 *
 * Kill switch: RECURRENCE_DETECTOR_DISABLED=1 (exits 0, writes nothing).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const rc = require('./lib/recurrence-classes.js');

const ROOT = path.join(__dirname, '..');
const SNAPSHOT = path.join(ROOT, 'data/audit/recurrence-classes.json');
const LEDGER = path.join(ROOT, 'data/audit/alert-ledger.json');
const BACKTEST_JSON = path.join(ROOT, 'data/audit/recurrence-backtest.json');
const BACKTEST_MD = path.join(ROOT, 'docs/recurrence-backtest.md');
const DAY = 864e5;
const WINDOW_DAYS = 30;
const QUIET_DAYS = 21;
const NEW_ROOT_CAP = 3;
const STALE_MS = 48 * 36e5;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const has = (name) => process.argv.includes(name);

const slugOf = (key) => String(key).trim().replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

// ---------- Linear reads ----------

const ISSUE_FIELDS = 'id identifier title createdAt completedAt canceledAt archivedAt priority state { name type } description';

async function fetchCards(days) {
  const lc = require('./lib/linear-client.js');
  const since = new Date(Date.now() - days * DAY).toISOString();
  const q = `query($since: DateTimeOrDuration!, $after: String) {
    issues(first: 100, after: $after, includeArchived: true, filter: { team: { key: { eq: "BRO" } }, createdAt: { gte: $since } }) {
      nodes { ${ISSUE_FIELDS} } pageInfo { hasNextPage endCursor } } }`;
  const out = [];
  let after = null;
  for (let page = 0; page < 200; page++) {
    const d = await lc.graphql(q, { since, after });
    out.push(...d.issues.nodes);
    if (!d.issues.pageInfo.hasNextPage) return { cards: out, complete: true };
    after = d.issues.pageInfo.endCursor;
  }
  return { cards: out, complete: false };
}

// Root-cause cards can be older than the window; fetch them by marker, and
// the static override cards by id, so a class never gets a second one.
async function fetchRootCards(known) {
  const lc = require('./lib/linear-client.js');
  const since = new Date(Date.now() - 365 * DAY).toISOString();
  const byMarker = await lc.listIssuesByProvenance({ since, descriptionMarkers: ['root-cause-class:'] });
  const ids = new Set(known.map((c) => c.identifier));
  const extra = byMarker.filter((c) => !ids.has(c.identifier));
  for (const o of rc.ROOT_CAUSE_OVERRIDES) {
    if (ids.has(o.card) || extra.some((c) => c.identifier === o.card)) continue;
    const c = await lc.getIssue(o.card);
    if (c) extra.push({ ...c, description: '' }); // description unused: overrides match by title
  }
  return extra;
}

// ---------- snapshot ----------

function buildSnapshot({ cards, ledger, now, complete, commentsById = {} }) {
  const classes = rc.detectClasses(cards, ledger, { now, windowDays: WINDOW_DAYS });
  const byId = new Map(cards.map((c) => [c.identifier, c]));
  const recurring = [...classes.values()].filter((c) => c.recurring);
  const instances = {};
  const lastSeenByKey = {};
  for (const cls of classes.values()) {
    if (Date.parse(cls.lastSeen) >= now - WINDOW_DAYS * DAY) lastSeenByKey[cls.key] = cls.lastSeen;
  }
  const out = [];
  let failed = 0; let claimed = 0; let unclaimed = 0;
  for (const cls of recurring.sort((a, b) => b.inWindow - a.inWindow)) {
    const root = cls.rootCause ? byId.get(cls.rootCause) : null;
    for (const c of cls.instances) instances[c.identifier] = { rootCause: cls.rootCause, classKey: cls.key };
    const prev = rc.checkPreventionClaims(cls, commentsById);
    const f = prev.filter((p) => p.failed);
    claimed += prev.filter((p) => p.claim).length; failed += f.length; unclaimed += prev.filter((p) => !p.claim).length;
    out.push({
      key: cls.key,
      slug: slugOf(cls.key),
      inWindow: cls.inWindow,
      total: cls.instances.length,
      reasons: cls.reasons,
      firstSeen: cls.firstSeen,
      lastSeen: cls.lastSeen,
      rootCause: cls.rootCause,
      rootCauseState: root && root.state ? root.state.type : null,
      rootCauseStartedNow: root ? /^START-NOW:/m.test(root.description || '') : false,
      rootCauseCreatedAt: root ? root.createdAt : null,
      extraRootCauses: cls.extraRootCauses,
      subtypes: cls.subtypes,
      example: cls.instances[cls.instances.length - 1].title,
      instances: cls.instances.map((c) => c.identifier),
      failedPreventions: f.map((p) => ({ card: p.card, claim: p.claim, recurredAs: p.recurredAs })),
    });
  }
  const expected = [...classes.values()].filter((c) => c.expected && c.inWindow >= 3)
    .map((c) => ({ key: c.key, inWindow: c.inWindow, reason: c.expected }));
  const ledgerCards = new Set(Object.values((ledger && ledger.conditions) || {}).map((c) => c.linearIdentifier).filter(Boolean));
  const week = (k) => rc.rootCauseShare(cards, classes, { from: now - (k + 1) * 7 * DAY, to: now - k * 7 * DAY, ledgerCards });
  return {
    generatedAt: new Date(now).toISOString(),
    complete,
    windowDays: WINDOW_DAYS,
    quietDays: QUIET_DAYS,
    closeGateBlockingFrom: rc.CLOSE_GATE_BLOCKING_FROM,
    keyVersion: rc.KEY_VERSION,
    share: { thisWeek: week(0), lastWeek: week(1) },
    recurringCount: out.length,
    withRootCause: out.filter((c) => c.rootCause).length,
    preventions: { claimed, failed, unclaimed },
    classes: out,
    expected,
    instances,
    lastSeenByKey,
  };
}

// ---------- root-cause card text ----------

// The class in words: the latest title minus its per-case parts (quoted
// show names, counts, parentheticals), so the root card names the family.
function readableName(cls) {
  return rc.stripFilerPrefixes(cls.example)
    .replace(/["“”][^"“”]{1,120}["“”]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/\b\d+\b/g, ' ')
    .replace(/\s+([:,.])/g, '$1')
    .replace(/[\s—:-]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 90).trim();
}

function rootCardTitle(cls) {
  return `Root cause: "${readableName(cls)}" keeps coming back (${cls.inWindow} cards in ${WINDOW_DAYS} days)`;
}

function rootCardDescription(cls) {
  const list = cls.instances.slice(-25).map((id) => `- ${id}`).join('\n');
  const subtypes = Object.entries(cls.subtypes || {}).map(([k, n]) => `${k} (${n})`).join(', ');
  return [
    `START-NOW: recurring problem class found by the recurrence detector (BRO-7103). Any worker may take it.`,
    '',
    `The same problem has been filed and closed again and again: ${cls.reasons.join('; ')}. ` +
      `Each card fixed one case. This card is for the cause, so it stops being filed.`,
    '',
    `Class: \`${cls.key}\`${subtypes ? `. Subtypes: ${subtypes}` : ''}.`,
    '',
    'Recent cases:',
    list,
    '',
    '## What to do',
    '1. Read the recent cases above and find what they have in common (the code path, the data source, the job).',
    '2. Land a change that stops the class at the source, plus a test, guard or check that would have caught it.',
    '3. Comment the Outcome with a `PREVENTION:` line naming what now catches this class.',
    // No "RECHECK-AFTER" + colon here: that marks a card as a deferred wait
    // and the cloud picker would never take it (headless-dispatchability.js).
    `4. Pause this card with a RECHECK-AFTER date ${QUIET_DAYS} days after the land. The check below passes once ${QUIET_DAYS} days go by with no new case.`,
    '',
    'New cases of this class are commented here by the detector each day, and their close shows a warning until they link this card.',
    '',
    '## Acceptance criteria',
    `VERIFY: node scripts/recurrence-detector.js --check-class ${cls.slug} --quiet`,
    '',
    rc.markerLine(cls.key),
  ].join('\n');
}

function statusComment(rootId, newIds) {
  return `${rc.STATUS_COMMENT_MARKER}\nRecurrence detector: ${newIds.length} new case(s) of this class since the last note: ${newIds.join(', ')}. ` +
    `The class is still coming back, so the prevention is not in place yet (BRO-7103).`;
}

// ---------- apply ----------

async function apply(snapshot, prevSnapshot) {
  const lc = require('./lib/linear-client.js');
  const { createLinearIssue } = require('./lib/linear-issue-create.js');
  const prevById = new Map(((prevSnapshot && prevSnapshot.classes) || []).map((c) => [c.key, c]));
  const filed = [];
  const commented = [];
  let pending = 0;
  for (const cls of snapshot.classes) {
    if (cls.extraRootCauses && cls.extraRootCauses.length) {
      console.warn(`[recurrence] class "${cls.key}" has ${cls.extraRootCauses.length + 1} root cards (${[cls.rootCause, ...cls.extraRootCauses].join(', ')}); not filing`);
      continue;
    }
    if (!cls.rootCause) {
      if (filed.length >= NEW_ROOT_CAP) { pending++; continue; }
      const { issue } = await createLinearIssue({
        title: rootCardTitle(cls),
        description: rootCardDescription(cls),
        dispatch: true,
        priority: 2,
        dedupeOptOut: 'recurrence-detector',
        source: 'recurrence-detector',
      });
      cls.rootCause = issue.identifier;
      cls.rootCauseState = 'unstarted';
      cls.rootCauseStartedNow = true;
      cls.rootCauseCreatedAt = new Date().toISOString();
      for (const id of cls.instances) snapshot.instances[id] = { rootCause: issue.identifier, classKey: cls.key };
      filed.push({ key: cls.key, card: issue.identifier });
      continue;
    }
    const prev = prevById.get(cls.key);
    if (!prev || prev.rootCause !== cls.rootCause) continue; // first sight of this root: its own text lists the cases
    const seen = new Set(prev.instances);
    const fresh = cls.instances.filter((id) => !seen.has(id));
    if (!fresh.length || ['completed', 'canceled', 'duplicate'].includes(cls.rootCauseState)) continue;
    const root = await lc.getIssue(cls.rootCause);
    if (!root || !root.id) continue;
    await lc.createComment(root.id, statusComment(cls.rootCause, fresh));
    commented.push({ key: cls.key, card: cls.rootCause, fresh });
  }
  snapshot.withRootCause = snapshot.classes.filter((c) => c.rootCause).length;
  snapshot.pendingRootCards = pending;
  return { filed, commented, pending };
}

// ---------- backtest ----------

function backtest(cards, ledger, days) {
  const end = Date.now();
  const start = end - days * DAY;
  const firstFlag = new Map(); // key -> {at, inWindow, reasons, expected}
  const expectedFlag = new Map();
  for (let t = start + DAY; t <= end + 1; t += DAY) {
    // Ledger reopens use only the CURRENT incident, so replaying them into the
    // past would invent history; they count on the final day only.
    const L = t + DAY > end ? ledger : null;
    const classes = rc.detectClasses(cards.filter((c) => Date.parse(c.createdAt) <= t), L, { now: t, windowDays: WINDOW_DAYS });
    for (const cls of classes.values()) {
      if (!cls.reasons.length) continue;
      const target = cls.expected ? expectedFlag : firstFlag;
      if (!target.has(cls.key)) target.set(cls.key, { at: new Date(Math.min(t, end)).toISOString().slice(0, 10), inWindow: cls.inWindow, reasons: cls.reasons, expected: cls.expected });
    }
  }
  const final = rc.detectClasses(cards, ledger, { now: end, windowDays: WINDOW_DAYS });
  const hits = [...firstFlag.entries()].map(([key, f]) => {
    const cls = final.get(key);
    const after = cls.instances.filter((c) => c.createdAt.slice(0, 10) > f.at);
    const done = cls.instances.filter(rc.isDone).length;
    return {
      key, firstFlagged: f.at, flaggedBecause: f.reasons, total: cls.instances.length, filedAfterFlag: after.length,
      done, rootCause: cls.rootCause, example: cls.instances[cls.instances.length - 1].title.slice(0, 120),
      ids: cls.instances.map((c) => c.identifier),
      // Likely false positive, not filed live (recurrence-classes.js suspectReason).
      suspect: cls.suspect,
    };
  }).sort((a, b) => b.total - a.total);
  const expected = [...expectedFlag.entries()].map(([key, f]) => ({ key, firstFlagged: f.at, reason: f.expected, total: final.get(key).instances.length }))
    .sort((a, b) => b.total - a.total);
  return { generatedAt: new Date(end).toISOString(), days, cards: cards.length, windowDays: WINDOW_DAYS, hits, expected };
}

function backtestMarkdown(bt) {
  const lines = [
    '# Recurrence detector backtest (BRO-7103)',
    '',
    `Generated ${bt.generatedAt.slice(0, 10)} over the last ${bt.days} days (${bt.cards} cards), replayed one day at a time with the ${bt.windowDays}-day window. ` +
      'A class is flagged at 3+ cards in the window, or when one of its alerts came back after being resolved.',
    '',
    `Flagged: ${bt.hits.length} classes. Likely false positives: ${bt.hits.filter((h) => h.suspect).length} (shown with a note; the live detector does not file these). Expected repeats excluded: ${bt.expected.length}.`,
    '',
    '## Hit list',
    '',
    '| Class | First flagged | Cards | Filed after flag | Root card | Note |',
    '|---|---|---|---|---|---|',
    ...bt.hits.map((h) => `| ${h.key.replace(/\|/g, '/')} | ${h.firstFlagged} | ${h.total} | ${h.filedAfterFlag} | ${h.rootCause || ''} | ${h.suspect || ''} |`),
    '',
    `Cards filed after the first flag (${bt.hits.reduce((n, h) => n + h.filedAfterFlag, 0)} in all) are the ones a root-cause fix on the flag date could have prevented.`,
    '',
    '## Expected repeats (excluded)',
    '',
    '| Class | Cards | Why it is expected |',
    '|---|---|---|',
    ...bt.expected.map((e) => `| ${e.key.replace(/\|/g, '/')} | ${e.total} | ${e.reason} |`),
    '',
  ];
  return lines.join('\n');
}

// ---------- checks ----------

function loadFreshSnapshot() {
  const snap = readJson(SNAPSHOT);
  if (!snap || !snap.generatedAt) return { snap: null, why: 'no snapshot' };
  if (Date.now() - Date.parse(snap.generatedAt) > STALE_MS) return { snap, why: `snapshot is stale (${snap.generatedAt})` };
  return { snap, why: null };
}

function checkAll() {
  const { snap, why } = loadFreshSnapshot();
  if (why) { console.log(`FAIL: ${why}`); return 3; }
  if (!snap.complete) { console.log('FAIL: last run read Linear only partly (complete:false)'); return 1; }
  const dup = snap.classes.filter((c) => c.extraRootCauses && c.extraRootCauses.length);
  if (dup.length) { console.log(`FAIL: ${dup.length} class(es) with more than one root card: ${dup.map((c) => `${c.key} (${c.rootCause}, ${c.extraRootCauses.join(', ')})`).join('; ')}`); return 1; }
  console.log(`OK: ${snap.recurringCount} recurring classes, ${snap.withRootCause} with a root-cause card, ${snap.pendingRootCards || 0} waiting behind the per-run cap; root-cause share this week ${snap.share.thisWeek.share}%`);
  return 0;
}

function checkClass(want, quiet) {
  const { snap, why } = loadFreshSnapshot();
  if (why) { console.log(`FAIL: ${why}`); return 3; }
  const keys = Object.keys(snap.lastSeenByKey || {});
  const key = keys.find((k) => k === want || slugOf(k) === slugOf(want));
  if (!key) {
    console.log(`OK: no case of "${want}" in the last ${snap.windowDays} days`);
    return snap.complete ? 0 : 1;
  }
  const last = snap.lastSeenByKey[key];
  const quietFor = Math.floor((Date.now() - Date.parse(last)) / DAY);
  if (quietFor >= QUIET_DAYS) { console.log(`OK: "${key}" quiet for ${quietFor} days (last case ${last.slice(0, 10)})`); return 0; }
  if (!quiet) console.log(`FAIL: "${key}" had a new case ${quietFor} day(s) ago (${last.slice(0, 10)}); needs ${QUIET_DAYS} quiet days`);
  else console.log(`FAIL: last case ${quietFor}d ago, needs ${QUIET_DAYS}`);
  return 1;
}

// ---------- main ----------

async function main() {
  if (['1', 'true'].includes(String(process.env.RECURRENCE_DETECTOR_DISABLED || '').toLowerCase())) { console.log('recurrence detector disabled (RECURRENCE_DETECTOR_DISABLED=1)'); return 0; }
  if (has('--check')) return checkAll();
  if (has('--check-class')) return checkClass(arg('--check-class', ''), has('--quiet'));

  const ledger = readJson(LEDGER, { conditions: {} });
  const input = arg('--input');
  const days = Number(arg('--days', has('--backtest') ? 60 : WINDOW_DAYS));
  let cards; let complete = true;
  if (input) {
    cards = readJson(input, []);
  } else {
    // Backtest needs a window of history before its first day.
    ({ cards, complete } = await fetchCards(has('--backtest') ? days + WINDOW_DAYS : WINDOW_DAYS + 7));
    cards = cards.concat(await fetchRootCards(cards));
  }

  if (has('--backtest')) {
    const bt = backtest(cards, ledger, days);
    fs.writeFileSync(BACKTEST_JSON, JSON.stringify(bt, null, 2) + '\n');
    fs.writeFileSync(BACKTEST_MD, backtestMarkdown(bt));
    console.log(`backtest: ${bt.hits.length} classes flagged (${bt.hits.filter((h) => h.suspect).length} suspect), ${bt.expected.length} expected repeats excluded -> ${path.relative(ROOT, BACKTEST_MD)}`);
    return 0;
  }

  const now = Date.now();
  // Prevention claims live in Outcome comments of finished instances.
  let commentsById = {};
  if (!input) {
    const pre = rc.detectClasses(cards, ledger, { now, windowDays: WINDOW_DAYS });
    const doneIds = [...pre.values()].filter((c) => c.recurring).flatMap((c) => c.instances.filter(rc.isDone).map((x) => x.identifier));
    try {
      const m = await require('./lib/linear-client.js').listIssueComments(doneIds, undefined, { includeArchived: true });
      for (const [id, nodes] of m) commentsById[id] = nodes.map((n) => n.body || '');
    } catch (e) {
      console.warn(`[recurrence] comment read failed (${e.message}); prevention stats are partial`);
      complete = false;
      commentsById = {};
    }
  }
  const prev = readJson(SNAPSHOT);
  const snap = buildSnapshot({ cards, ledger, now, complete, commentsById });
  snap.pendingRootCards = snap.classes.filter((c) => !c.rootCause).length;

  if (has('--apply')) {
    if (!complete) { console.error('[recurrence] Linear read was partial; refusing to file (would risk a duplicate root card)'); process.exitCode = 1; }
    else {
      const r = await apply(snap, prev);
      console.log(`apply: filed ${r.filed.length} root-cause card(s)${r.filed.length ? ` (${r.filed.map((f) => f.card).join(', ')})` : ''}, commented on ${r.commented.length}, ${r.pending} waiting behind the cap`);
    }
  } else {
    const todo = snap.classes.filter((c) => !c.rootCause);
    console.log(`dry run: ${snap.recurringCount} recurring classes, ${snap.withRootCause} with a root card; --apply would file ${Math.min(NEW_ROOT_CAP, todo.length)} now (${todo.length} without one):`);
    for (const c of todo.slice(0, NEW_ROOT_CAP)) console.log(`  + ${rootCardTitle(c)}`);
  }
  console.log(`root-cause share: this week ${snap.share.thisWeek.share}% of ${snap.share.thisWeek.total} done, last week ${snap.share.lastWeek.share}% of ${snap.share.lastWeek.total}; preventions claimed ${snap.preventions.claimed}, failed ${snap.preventions.failed}, closed without one ${snap.preventions.unclaimed}`);
  if (!has('--no-write')) fs.writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 2) + '\n');
  return process.exitCode || 0;
}

if (require.main === module) {
  main().then((code) => process.exit(code), (e) => { console.error(`[recurrence] ${e.stack || e.message}`); process.exit(1); });
}

module.exports = { buildSnapshot, backtest, rootCardTitle, rootCardDescription, slugOf, checkClass, checkAll };
