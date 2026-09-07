/**
 * crown-duplicate-detector — report-only detection of live duplicate Crown
 * (owner-loop) cmux tabs.
 *
 * Incident (2026-09-07): a succession hand-off chain for Linear card BRO-343
 * ("P1 backlog triage + dispatch loop") accumulated 55 concurrent LIVE
 * duplicate tabs (titled Crown v20 through v46) all running simultaneously
 * on the same shared bare checkout (~/Broadwayscore, not separate
 * worktrees) — 323% CPU, 22.8GB RAM. Root cause: Crown tabs are deliberately
 * exempt from every existing auto-close path (see prune-closeable.js's
 * isCrownTab, prune-dead-autodispatch-tabs.js, zombie-tab-sweep.js), on the
 * theory that closing an owner-loop tab is an owner decision requiring a
 * "periodic owner-approved manual sweep" (memory/
 * feedback_never_close_unmarked_cmux_workspaces.md) — but nothing ever
 * surfaced that a sweep was overdue, so successors piled up silently for
 * ~6 weeks. dispatch-ledger.js's SUCCESSION_DEPTH_CAP does not prevent this:
 * it only bounds a single unbroken succession sub-chain (depth resets to 1
 * whenever a launch lacks successionOf/succession), so repeated fresh
 * re-dispatches of the same card each start a new capped sub-chain while
 * every prior sub-chain's tabs sit open forever.
 *
 * This module NEVER closes anything. It exists purely to make the problem
 * loud on every bsc-prune run (which already executes synchronously and
 * reliably on the Stop hook, unlike the 5-min launchd backstop, whose
 * orphaned process is rejected by cmux's socket ACL) instead of letting it
 * silently reaccumulate.
 *
 * Grouping key (card #1938 second-opinion review): the dispatch ledger's
 * taskId is the primary, authoritative key — the SAME two-tier rule
 * zombie-tab-sweep.js's classifyZombieTabs already uses for "duplicate"
 * detection (taskId when the ledger has one, title only as a fallback).
 * Title-only grouping is a known-dangerous shortcut in this codebase:
 * zombie-tab-sweep.js's own header cites a caught bug where a bare
 * title-prefix match closed a pending SIBLING task as a false "duplicate."
 * Grouping purely by title here would repeat that mistake.
 */

// Strips a standalone "v<digits>" version token (e.g. "v42") so two titles
// that differ only by succession version number normalize to the same
// family key. Word-bounded so it never touches a Linear ID like "BRO-343"
// (no "v" token there) or a ticket number embedded elsewhere in the title.
function stripVersionToken(title) {
  return String(title || '').replace(/\bv\d+\b/gi, '').replace(/\s+/g, ' ').trim();
}

// Fallback family key when the ledger has no taskId for a ref: strip leading
// glyphs/emoji/status markers (mirrors dispatch-ledger.titleMatchesSubject's
// own prefix-stripping) and the version token, then lowercase. Used only as
// a fallback — see module header for why taskId is preferred.
function titleFamilyKey(title) {
  const stripped = stripVersionToken(String(title || '').replace(/^[^\p{L}\p{N}]+/u, ''));
  return stripped.toLowerCase();
}

function extractVersion(title) {
  const m = /\bv(\d+)\b/i.exec(String(title || ''));
  return m ? parseInt(m[1], 10) : null;
}

/**
 * @param {Array<{ref:string,title:string,selected?:boolean,cwd?:string|null}>} workspaces
 *        from cmux-workspaces.listWorkspacesWithCwd() (or an equivalent fixture).
 * @param {Array} entries dispatch-ledger entries (dispatchLedger.readEntries()).
 * @param {string} repoRoot bare-checkout path; only workspaces whose cwd
 *        matches exactly are candidates — a worktree-scoped Crown tab may
 *        hold real uncommitted branch-specific work and is never flagged.
 * @param {(title:string)=>boolean} isCrownTab
 * @param {(ref:string, entries:Array)=>({taskId?:string}|null)} launchByRef
 * @param {(ref:string, aliveFn:Function, surfaceAliveFn:Function)=>({dead:boolean})} checkLivenessFn
 * @param {(ref:string)=>boolean} aliveFn
 * @param {(ref:string)=>boolean} surfaceAliveFn
 * @returns {{duplicateGroups: Array<{key:string, keyType:'taskId'|'title', keep:{ref:string,title:string}, stale:Array<{ref:string,title:string,selected:boolean}>}>}}
 */
function detectDuplicateCrownTabs({ workspaces, entries, repoRoot, isCrownTab, launchByRef, checkLivenessFn, aliveFn, surfaceAliveFn }) {
  // Selected tabs are NOT excluded from candidacy (adversarial review,
  // 2026-09-07): a group of exactly 2 — one selected, one not — would
  // otherwise shrink to 1 member and silently report NOTHING, precisely
  // while the owner is looking at the live duplicate. Selection is honored
  // downstream instead, by never recommending the selected tab's own
  // closure (see the `stale` filtering below) — the group itself must
  // still be visible.
  const candidates = (workspaces || []).filter(w =>
    w && w.ref && w.cwd === repoRoot && isCrownTab(w.title)
  );

  const live = candidates.filter(w => {
    try {
      return !checkLivenessFn(w.ref, aliveFn, surfaceAliveFn).dead;
    } catch {
      // Fail-safe direction matches this codebase's checkLiveness convention
      // (cmux-workspaces.js: "uncertainty must never resolve to dead") even
      // though this path never closes anything — for a REPORT, the unsafe
      // direction is silently hiding a real duplicate behind a liveness
      // error, not over-reporting one (adversarial review, 2026-09-07).
      return true;
    }
  });

  const groups = new Map(); // key -> { keyType, items: [] }
  for (const w of live) {
    let launch = null;
    try { launch = launchByRef(w.ref, entries); } catch { launch = null; }
    const taskId = launch && launch.taskId != null ? String(launch.taskId) : null;
    const key = taskId != null ? `task:${taskId}` : `title:${titleFamilyKey(w.title)}`;
    const keyType = taskId != null ? 'taskId' : 'title';
    if (!groups.has(key)) groups.set(key, { keyType, items: [] });
    groups.get(key).items.push(w);
  }

  const duplicateGroups = [];
  for (const [key, { keyType, items }] of groups) {
    if (items.length < 2) continue;
    const sorted = [...items].sort((a, b) => {
      const va = extractVersion(a.title);
      const vb = extractVersion(b.title);
      if (va != null && vb != null) return vb - va;
      if (va != null) return -1;
      if (vb != null) return 1;
      return 0;
    });
    const [keep, ...stale] = sorted;
    duplicateGroups.push({
      key,
      keyType,
      keep: { ref: keep.ref, title: keep.title },
      // `selected: true` on a stale entry means "do not close via this
      // report" — the owner is looking at it right now. Still SURFACED
      // (never dropped), just without a close command; see bsc-prune.js's
      // print loop for how this renders.
      stale: stale.map(s => ({ ref: s.ref, title: s.title, selected: !!s.selected })),
    });
  }

  return { duplicateGroups };
}

module.exports = { detectDuplicateCrownTabs, stripVersionToken, titleFamilyKey, extractVersion };
