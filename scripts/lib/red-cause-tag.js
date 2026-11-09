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
 * The close check is ADVISORY (CLAUDE.md §19): it warns, never refuses. Turning
 * it blocking is its own card once the advisory data shows people use it.
 * ci-green-rate.js --cause-mix reports the mix over closed red cards.
 * PURE except causeMixFromLinear (reads Linear).
 */

const CAUSES = ['data-drift', 'stale-test', 'landing-collision', 'flake', 'infra'];
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

/** PURE. The advisory close check: { applies, ok, tag, message }. */
function checkRedCauseClose({ identifier = '', title = '', description = '', texts = [] } = {}) {
  if (!isRedCard({ title, description })) return { applies: false, ok: true, tag: null, message: null };
  const p = parseCauseTag(texts);
  if (p && p.valid) return { applies: true, ok: true, tag: p.tag, message: null };
  const why = p ? `"CAUSE: ${p.tag}" is not one of the tags` : 'no CAUSE: line';
  return {
    applies: true,
    ok: false,
    tag: null,
    message: `${identifier || 'this card'} is a main test.yml red card closing with ${why}. Add one line to the close comment: `
      + `CAUSE: ${CAUSES.join(' | ')}  (BRO-7102; advisory, it does not block).`,
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
  for (const c of Array.isArray(cards) ? cards : []) {
    if (!c || !isRedCard(c) || !(c.state && c.state.type === 'completed')) continue;
    total++;
    const p = parseCauseTag([c.description, ...(c.texts || [])]);
    if (!p) untagged++;
    else if (!p.valid) invalid++;
    else mix[p.tag]++;
  }
  return { total, mix, untagged, invalid };
}

function formatCauseMix(r, days) {
  const parts = CAUSES.map((c) => `${c} ${r.mix[c]}`).join(', ');
  return `CAUSE-MIX: ${r.total} closed main-red cards over ${days}d: ${parts}, untagged ${r.untagged}${r.invalid ? `, bad tag ${r.invalid}` : ''}`;
}

/** Reads closed red cards updated in the window from Linear, with their comments. */
async function causeMixFromLinear(days, lc = require('./linear-client.js')) {
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const cards = await lc.listIssuesByProvenance({ since, titlePrefixes: ['main test.yml'], descriptionMarkers: RED_KEY_MARKERS });
  const done = cards.filter((c) => c.state && c.state.type === 'completed' && (!c.completedAt || Date.parse(c.completedAt) >= Date.parse(since)));
  const comments = done.length ? await lc.listIssueComments(done.map((c) => c.identifier)) : new Map();
  const withTexts = done.map((c) => {
    const nodes = (comments.get ? comments.get(c.identifier) : comments[c.identifier]) || [];
    // Comment pages come newest first; parseCauseTag wants oldest first.
    const texts = nodes.slice().sort((a, b) => Date.parse(a.createdAt || 0) - Date.parse(b.createdAt || 0)).map((n) => n.body || '');
    return { ...c, texts };
  });
  return causeMix(withTexts);
}

module.exports = { CAUSES, isRedCard, parseCauseTag, checkRedCauseClose, causeMix, formatCauseMix, causeMixFromLinear };
