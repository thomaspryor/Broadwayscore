/**
 * prune-dead-autodispatch-tabs — pure reclaim predicate for BRO-2586.
 *
 * cmux's terminal-runtime ceiling caps total live dispatch slots. A dead 🤖
 * auto-dispatched tab classified "unmapped" by zombie-tab-sweep.js's
 * classifyZombieTabs (no ledger launch record for its ref, OR a launch
 * record whose task file/status can't be resolved to completed/pending/
 * in_progress) holds a slot but classifyZombieTabs declines to touch it:
 * there's no evidence of the underlying TASK's status, so it reports the tab
 * and stops there, same as it does for genuine 'reconciler-territory'
 * (in_progress) tabs.
 *
 * This module answers a narrower, DIFFERENT question: not "is the task
 * done," but "is this TAB's provenance safe to reclaim" — never an
 * owner-opened tab (🤖 is never stamped on one, owner rule 2026-08-02), never
 * the tab the owner is looking at right now, never a crown (owner-loop) tab,
 * and never one with a live claude process. That's a sufficient, independent
 * basis to close the workspace (freeing the slot) without knowing anything
 * about task status — closing does not touch the task store, so if real work
 * still needs doing it re-enters the normal dispatch funnel later, same as
 * any other dead husk. It is deliberately NOT a basis for re-dispatching
 * (unlike zombie-tab-sweep's `revive` bucket) — there's no known task here to
 * revive.
 */

const { isCrownTab } = require('./prune-closeable.js');

function isReclaimable({ title, selected, hasLiveClaude, isAutoDispatched }) {
  if (selected) return false;
  if (isCrownTab(title)) return false;
  if (!isAutoDispatched) return false;
  if (hasLiveClaude) return false;
  return true;
}

module.exports = { isReclaimable };
