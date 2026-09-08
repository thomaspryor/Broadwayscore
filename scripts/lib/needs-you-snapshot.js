/**
 * needs-you-snapshot — {generatedAt, bannerText, items} view of pending-
 * decision cmux tabs for the "Needs You" tab triage (card #870, owner pain
 * 2026-08-02: "giant list of tabs and I can't tell which ones actually need
 * decisions from me"). Shared by bsc-needs-you.js (one-shot CLI) and
 * send-morning-digest.js (digest section) — same pattern as the other
 * lib/*.js modules used by more than one caller.
 *
 * State is written by ~/.claude/hooks/lib/workspace-mark-done.js: whenever a
 * session's final message carries a `DECISION NEEDED:` line, that hook
 * ❓-prefixes the workspace title AND drops a small JSON at
 * ~/.claude/state/needs-you/<ref>.json with the captured question. This
 * module reads that state and cross-references it against LIVE cmux
 * workspaces — a tab only counts if it's still open AND still carries the ❓
 * prefix, so a resolved decision or a closed tab never shows a stale
 * question (the hook clears the state file on resolution, but title + state
 * writes are two separate fs calls, so a crash between them is possible).
 *
 * BRO-2989: sequential crown-succession generations (v25 -> v48+) that hit
 * the SAME unanswered owner decision each write their own state file, so raw
 * per-ref items would show N indistinguishable "fresh" rows for one open
 * question. collapseCrownLineages() folds a crown title-family down to its
 * latest generation, annotated with how long the underlying decision has
 * actually been pending — see that function's header for the full incident.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { cmuxAvailable, listWorkspaces } = require('./cmux-workspaces.js');
const { isCrownLaunchTitle } = require('./crown-fanout-guard.js');
const { extractVersion } = require('./crown-duplicate-detector.js');

const NEEDS_YOU_DIR = process.env.CLAUDE_CODE_NEEDS_YOU_DIR
  || path.join(os.homedir(), '.claude', 'state', 'needs-you');

function readNeedsYouState(dir = NEEDS_YOU_DIR) {
  let files;
  try { files = fs.readdirSync(dir); } catch { return []; }
  return files
    .filter(f => f.endsWith('.json'))
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
}

// A ❓ must lead within the same glyph zone workspace-mark-done.js itself
// tolerates (cmux's activity-glyph prefix in list output).
function isNeedsYouTitle(title) {
  return String(title || '').trim().slice(0, 4).includes('❓');
}

// Card #940 (owner screenshot 2026-08-03): a session sometimes emits a stub
// "DECISION NEEDED: none — no pending decision" line instead of omitting the
// block entirely when it has nothing to ask. workspace-mark-done.js's
// hasDecisionNeeded() only pattern-matches the literal "DECISION NEEDED:"
// prefix — it can't tell that stub apart from a real question — so the ❓
// glyph and the extracted content disagree: the title says "waiting on
// you", the content says there's nothing to wait on. Any "none"-shaped (or
// empty) extraction is treated as no pending decision, never rendered.
// Ambiguous bare words only count as empty when immediately followed by
// end-of-string or punctuation — "none of the 3 vendors quoted under
// budget..." is a real decision, not a stub, even though it starts with
// "none".
const BARE_EMPTY_RE = /^\s*(none|n\/a|nothing)\s*(?:[.,;:\-—–]|$)/i;
// "no decision"-shaped phrasings — same termination discipline as
// BARE_EMPTY_RE above: "No decision has been made about vendor X — should
// we wait?" is a real question that happens to start with "No decision",
// not a stub, so the phrase must end (punctuation or end-of-string)
// immediately after the stub shape, not just match as a prefix.
const PHRASE_EMPTY_RE = /^\s*no\s+(?:pending\s+)?decision(?:\s+(?:needed|pending))?\s*(?:[.,;:\-—–]|$)|^\s*nothing\s+pending\s*(?:[.,;:\-—–]|$)/i;
function isEmptyDecisionContent(question) {
  const q = String(question || '').trim();
  if (!q) return true;
  return BARE_EMPTY_RE.test(q) || PHRASE_EMPTY_RE.test(q);
}

// Pure: cross-reference persisted questions against live workspace titles,
// dropping any whose extracted content is empty/none regardless of glyph.
function pendingDecisions(states, workspaces) {
  const byRef = new Map(workspaces.map(w => [w.ref, w.title]));
  return states
    .filter(s => s && s.ref && byRef.has(s.ref))
    .map(s => ({ ...s, title: byRef.get(s.ref) }))
    .filter(s => isNeedsYouTitle(s.title))
    .filter(s => !isEmptyDecisionContent(s.question));
}

// BRO-2989: a crown succession hand-off (launchCmuxSession({successorOf})
// in cmux-launch.js) launches a fresh "👑 OWNER — Crown vNN: ..." workspace
// but never retires the PREDECESSOR's ❓ mark or state file — crown tabs are
// deliberately exempt from every auto-close path (crown-duplicate-
// detector.js's header; owner policy: closing an owner-loop tab is a manual,
// owner-approved sweep, never automatic). Each generation restates whatever
// it currently thinks is outstanding, but confirmed live (real
// ~/.claude/state/needs-you/*.json on this machine) generations REWORD the
// same decision every hand-off ("Cancel the Cyrus Team Cloud subscription at
// $120/mo?" / "Keep or cancel Cyrus Team Cloud at $120/mo." / "Cyrus Team
// Cloud, $120/mo — keep or drop.") — even the TITLE text varies generation to
// generation, not just a version-token suffix — so grouping by title family
// (crown-duplicate-detector.js's titleFamilyKey, built for its OWN
// exact-title duplicate sweep) under-merges here and was tried first and
// rejected (it left every reworded generation in its own group). What is
// stable is that they are all the SAME "👑 OWNER" crown mandate loop
// (isCrownLaunchTitle) — this collapses every LIVE crown-titled ❓ tab into
// ONE row: the most recent generation's own question (freshest signal wins)
// annotated with how many older generations also sat blocked and how long
// the thread has been open in total, rather than N indistinguishable "fresh"
// rows that let three real generations (v25/v32/v33) go unanswered long
// enough to be reaped as dead. Non-crown ❓ tabs are untouched —
// isCrownLaunchTitle is a no-op for every other title shape, so an unrelated
// one-off decision never gets folded into the crown row.
function collapseCrownLineages(pending) {
  const crown = [];
  const rest = [];
  for (const p of pending) (isCrownLaunchTitle(p.title) ? crown : rest).push(p);
  if (!crown.length) return rest;
  const sorted = [...crown].sort((a, b) => {
    const va = extractVersion(a.title);
    const vb = extractVersion(b.title);
    if (va != null && vb != null) return vb - va;
    if (va != null) return -1;
    if (vb != null) return 1;
    return String(b.ts || '').localeCompare(String(a.ts || ''));
  });
  const [latest, ...superseded] = sorted;
  // Falsy ts (missing/empty — defended against elsewhere in this file, e.g.
  // the digest sort's `String(a.ts || '')`) is skipped rather than compared:
  // an earlier version's `!min` sentinel check re-triggered on every falsy
  // ts, silently overwriting the true earliest with whatever came next
  // (ship-check finding).
  const earliestTs = crown.reduce(
    (min, it) => (it.ts && (min === null || it.ts < min)) ? it.ts : min,
    null,
  );
  return [...rest, { ...latest, supersededCount: superseded.length, pendingSinceTs: earliestTs }];
}

// The digest's HTML renderer (autonomous-email-render.js's
// renderNamedDigestBlock) only ever reads item.title/detail/url/moreCount —
// baking the age/count into the rendered detail string (rather than adding
// new structured fields the renderer doesn't know about) is what actually
// gets it in front of the owner, and keeps this module the single source of
// truth for how a pending decision reads.
function formatDetail(p) {
  const base = p.question || '(no question captured)';
  if (!p.supersededCount) return base;
  const since = p.pendingSinceTs ? String(p.pendingSinceTs).slice(0, 10) : 'unknown';
  const gens = p.supersededCount + 1;
  return `${base} (pending since ${since}, asked across ${gens} crown generations)`;
}

function buildNeedsYouSnapshot({ dir = NEEDS_YOU_DIR } = {}) {
  if (!cmuxAvailable()) return null;
  let workspaces;
  try { workspaces = listWorkspaces(); } catch { return null; }
  const states = readNeedsYouState(dir);
  const pending = collapseCrownLineages(pendingDecisions(states, workspaces))
    .sort((a, b) => String(a.pendingSinceTs || a.ts || '').localeCompare(String(b.pendingSinceTs || b.ts || '')));
  // Glyph/content mismatch count (card #940): ❓-titled tabs whose extracted
  // question was empty/none, so they were excluded above. Logged, not
  // thrown — this must never block the digest, only make the mismatch
  // visible for the hook-side extraction bug it points at.
  const byRef = new Map(workspaces.map(w => [w.ref, w.title]));
  const glyphMatched = states.filter(s => s && s.ref && byRef.has(s.ref) && isNeedsYouTitle(byRef.get(s.ref)));
  const mismatches = glyphMatched.length - pending.length;
  if (mismatches > 0) {
    console.error(`[needs-you] WARN ${mismatches} tab(s) ❓-marked but decision content was empty/none — excluded from "Needs your decision"`);
  }
  return {
    generatedAt: new Date().toISOString(),
    bannerText: pending.length
      ? `${pending.length} tab${pending.length === 1 ? '' : 's'} waiting on your decision`
      : 'Nothing waiting on you',
    items: pending.map(p => ({ title: p.title, detail: formatDetail(p) })),
  };
}

module.exports = {
  NEEDS_YOU_DIR, readNeedsYouState, isNeedsYouTitle, isEmptyDecisionContent, pendingDecisions,
  collapseCrownLineages, formatDetail, buildNeedsYouSnapshot,
};
