'use strict';
/**
 * red-cause-tag.js — BRO-7102 item 5: why did main go red? One `CAUSE:` line on
 * the close of every main test.yml red card, so the mix of causes is counted
 * instead of guessed.
 *
 *   CAUSE: data-drift | stale-test | landing-collision | flake | infra
 *
 * data-drift         live or bot-committed data broke a test (the code was fine)
 * stale-test         a test asserted something no longer true (a date, a count)
 * landing-collision  two landings that each passed alone broke main together
 * flake              passed on re-run with no change
 * infra              runner, network, quota, timeout: nothing in the repo
 *
 * The close check warned only (CLAUDE.md §19) from 2026-11-08. The advisory
 * read 0 of 9 red closes tagged over its first 14 days (after the archived-
 * comment read fix, below), so it REFUSES from RED_CAUSE_BLOCKING_FROM.
 * RED_CAUSE_CLOSE_GATE=advisory rolls that back; =blocking arms it early.
 * Automated closers (AUTOMATED_CLOSER_MARKERS, matched on the close comment
 * only) cannot know the cause and stay advisory, so a green card is never
 * stranded open.
 * ci-green-rate.js --cause-mix reports the mix over closed red cards, with
 * canceled red cards counted apart (Cancel is the way around a Done gate).
 * PURE except causeMixFromLinear (reads Linear).
 */

const CAUSES = ['data-drift', 'stale-test', 'landing-collision', 'flake', 'infra'];
const RED_CAUSE_BLOCKING_FROM = '2026-11-24';
// Close comments written by machines that close a card on a passing check.
// Matched against THIS close's comment only, and anchored at its start (each
// writer opens its comment with the marker; red-cause-tag.test.mjs builds the
// real comments): a card the closer once touched and a person later closes by
// hand is still held to the tag, and pasting a marker mid-comment does not exempt.
const AUTOMATED_CLOSER_MARKERS = [
  /^AUTO-CLOSED by stuck-card-closer/, // lib/stuck-card-closer.js CLOSER_MARKER
  /^Auto-closed by the nightly acceptance re-check/, // lib/autonomous-recheck-core.js buildAutoCloseComment
  /^Closed by sweep-recovered-alert-cards/, // lib/board-closer.js landedComment
  /^Auto-reset by bsc-reconcile's Linear zombie sweep/, // lib/linear-started-zombie-sweep-verify.js buildZombieActionComment
  /^## Codex runner: (?:landed|already fixed on main, no code change)\n/, // codex/daily-runner.js Done closes
];
// The titles route-main-streak-signatures.js and red-escalation.js file.
const RED_TITLE_RE = /^(?:\[[^\]]*\]\s*)?main test\.yml (?:still )?red\b/i;
// Per-test red cards and the "still red" escalation (test-yml:main-streak-escalation).
const RED_KEY_MARKERS = ['[conditionKey:test-yml:red', '[conditionKey:test-yml:main-streak'];
// Upper-case CAUSE: at a line start or after a space/punctuation ("Fixed. CAUSE: flake"),
// tolerant of markdown (**CAUSE:** flake, `CAUSE: flake`, CAUSE: **flake**). Never
// ROOT-CAUSE: / ROOT CAUSE: (BRO-7103's field), and never the pasted hint line
// ("CAUSE: data-drift | stale-test | ...", a tag followed by " |").
const CAUSE_LINE_RE = /(?:^|[\s.;,(>*`])(?<!ROOT[ _-])CAUSE:[*`]*[ \t]*[*`]*([A-Za-z-]+)(?![A-Za-z-]*[*`]*[ \t]*\|)/gm;

/** PURE. Is this a main test.yml red card (by title, or by the router's conditionKey marker)? */
function isRedCard({ title = '', description = '' } = {}) {
  if (RED_TITLE_RE.test(String(title).trim())) return true;
  const d = String(description).replace(/\\([[\]_])/g, '$1');
  return RED_KEY_MARKERS.some((m) => d.includes(m));
}

/** PURE. The last `CAUSE:` line across texts (oldest first): { tag, valid } or null. */
function parseCauseTag(texts) {
  let last = null;
  for (const t of Array.isArray(texts) ? texts : [texts]) {
    // Linear stores markdown-escaped text (data\-drift).
    for (const m of String(t || '').replace(/\\([-_*`[\]])/g, '$1').matchAll(CAUSE_LINE_RE)) last = m[1].toLowerCase();
  }
  if (last === null) return null;
  return { tag: last, valid: CAUSES.includes(last) };
}

/** PURE. Was this close comment written by an automated closer? */
function isAutomatedClose(commentText) {
  const t = String(commentText || '').trimStart();
  return AUTOMATED_CLOSER_MARKERS.some((re) => re.test(t));
}

/** PURE. Does a missing tag refuse the close? Never for an automated closer. */
function redCauseCloseBlocking({ nowMs = Date.now(), env = process.env, commentText = '' } = {}) {
  const mode = String(env.RED_CAUSE_CLOSE_GATE || '').toLowerCase();
  if (mode === 'advisory') return false;
  if (isAutomatedClose(commentText)) return false;
  if (mode === 'blocking') return true;
  return nowMs >= Date.parse(`${RED_CAUSE_BLOCKING_FROM}T00:00:00Z`);
}

/** PURE. The close check: { applies, ok, tag, message, blocking }. texts oldest first, the close comment last. */
function checkRedCauseClose({ identifier = '', title = '', description = '', texts = [], commentText = '', nowMs = Date.now(), env = process.env } = {}) {
  if (!isRedCard({ title, description })) return { applies: false, ok: true, tag: null, message: null, blocking: false };
  const p = parseCauseTag(texts);
  if (p && p.valid) return { applies: true, ok: true, tag: p.tag, message: null, blocking: false };
  const why = p ? `"CAUSE: ${p.tag}" is not one of the tags` : 'no CAUSE: line';
  const blocking = redCauseCloseBlocking({ nowMs, env, commentText });
  return {
    applies: true,
    ok: false,
    tag: null,
    blocking,
    message: `${identifier || 'this card'} is a main test.yml red card closing with ${why}. Add one line to the close comment: `
      + `CAUSE: ${CAUSES.join(' | ')}  (BRO-7102; `
      + (blocking ? 'the close is refused without it).' : `advisory now, refused from ${RED_CAUSE_BLOCKING_FROM}).`),
  };
}

/**
 * PURE. Cause mix over closed red cards. cards: [{ title, description, state: {type}, texts: [] }].
 * Only Done (completed) cards count; untagged and invalid tags are counted apart.
 */
function causeMix(cards) {
  const mix = Object.fromEntries(CAUSES.map((c) => [c, 0]));
  let untagged = 0;
  let invalid = 0;
  let total = 0;
  let canceled = 0;
  for (const c of Array.isArray(cards) ? cards : []) {
    if (c && isRedCard(c) && c.state && c.state.type === 'canceled') { canceled++; continue; }
    if (!c || !isRedCard(c) || !(c.state && c.state.type === 'completed')) continue;
    total++;
    const p = parseCauseTag([c.description, ...(c.texts || [])]);
    if (!p) untagged++;
    else if (!p.valid) invalid++;
    else mix[p.tag]++;
  }
  return { total, mix, untagged, invalid, canceled };
}

function formatCauseMix(r, days) {
  const parts = CAUSES.map((c) => `${c} ${r.mix[c]}`).join(', ');
  return `CAUSE-MIX: ${r.total} closed main-red cards over ${days}d: ${parts}, untagged ${r.untagged}${r.invalid ? `, bad tag ${r.invalid}` : ''}${r.canceled ? ` (+${r.canceled} canceled, not counted)` : ''}`;
}

/** Reads closed red cards updated in the window from Linear, with their comments. */
async function causeMixFromLinear(days, lc = require('./linear-client.js')) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const cards = await lc.listIssuesByProvenance({ since, titlePrefixes: ['main test.yml'], descriptionMarkers: RED_KEY_MARKERS });
  const done = cards.filter((c) => c.state && c.state.type === 'completed' && (!c.completedAt || Date.parse(c.completedAt) >= Date.parse(since)));
  const canceled = cards.filter((c) => c.state && c.state.type === 'canceled' && (!c.canceledAt || Date.parse(c.canceledAt) >= Date.parse(since)));
  // Closed cards auto-archive ~2 days after close; without includeArchived
  // Linear returns NO comments for them, and every close read as untagged.
  const comments = done.length ? await lc.listIssueComments(done.map((c) => c.identifier), undefined, { includeArchived: true }) : new Map();
  const withTexts = done.map((c) => {
    const nodes = (comments.get ? comments.get(c.identifier) : comments[c.identifier]) || [];
    // Comment pages come newest first; parseCauseTag wants oldest first.
    const texts = nodes.slice().sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0)).map((n) => n.body || '');
    return { ...c, texts };
  });
  return causeMix([...withTexts, ...canceled]);
}

module.exports = { CAUSES, RED_CAUSE_BLOCKING_FROM, AUTOMATED_CLOSER_MARKERS, isRedCard, parseCauseTag, isAutomatedClose, redCauseCloseBlocking, checkRedCauseClose, causeMix, formatCauseMix, causeMixFromLinear };
