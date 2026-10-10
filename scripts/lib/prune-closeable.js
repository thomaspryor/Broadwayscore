/**
 * prune-closeable — pure closeability predicate for bsc-prune (card #709).
 *
 * bsc-prune's pruneDone() (scripts/lib/cmux-workspaces.js) has always
 * skipped every ✅-marked workspace with a live claude process — correct for
 * owner-driven tabs (2026-07-21 incident: sweep closed tabs the owner was
 * actively reviewing), but it also means an auto-dispatched (🤖) session
 * that finishes and sits idle at the prompt is NEVER closed autonomously —
 * only a session that fully exits does. Owner mandate 2026-07-31: relax the
 * live-claude skip specifically for 🤖 auto-dispatched ✅ workspaces that are
 * idle at the prompt (not mid-turn). Non-🤖 (owner-driven) ✅ tabs keep the
 * full protection regardless of idle/running state.
 *
 * "Idle at the prompt" vs "mid-turn" reuses cmux-workspaces.js's existing
 * two-state distinction rather than parsing title spinner glyphs:
 *   hasRunningClaude  — tag status === 'Running'          (mid-turn/busy)
 *   hasLiveClaude     — any claude_code process row at all (includes idle-
 *                        at-prompt, where the tag status column is empty)
 * So "idle at the prompt" = hasLiveClaude(tsv) && !hasRunningClaude(tsv).
 * Callers pass that as `isRunning` here; this module has no cmux I/O itself.
 */

const AUTO_GLYPH = '🤖';

// A leading ✅ rename (workspace-mark-done.js: `✅ ${workspaceTitle}`) never
// strips the original title's own 🤖 — it just prepends the checkmark — so
// a plain substring test finds the marker anywhere in the title.
function hasAutoDispatchMarker(title) {
  return String(title || '').includes(AUTO_GLYPH);
}

// hasLiveClaude: whether any claude_code process exists for this workspace
// (false = fully dead — same "closeable regardless of marker" rule prune
// already had). isAutoDispatched: caller-computed hasAutoDispatchMarker(title)
// result — taken as a bool rather than re-deriving from title here, since
// pruneDone already needs that same fact itself (to decide whether it's
// worth spending a cmux call finding out isRunning) and re-parsing the same
// string twice for the same fact invites the two checks drifting apart.
// isRunning: whether the live claude is mid-turn (true) vs idle-at-prompt
// (false) — irrelevant when hasLiveClaude is false, so callers may pass
// anything (or omit it) in that case.
// ACCEPTED LIMITATION: "auto-dispatched" is inferred from the 🤖 title glyph
// OR an unreconciled dispatch-ledger launch record for the ref (card #971 —
// see dispatchLedger.isLedgerAutoDispatched, which pruneDone ORs in before
// calling isCloseable here), not from interaction history — cmux exposes no
// "has the owner typed here" signal. If the owner reclaims a 🤖 tab and works
// in it, either signal still makes it closeable once idle/dead; renaming away
// the 🤖 glyph no longer opts a tab out on its own, since the ledger still
// remembers the dispatch until a dead/vanished/remapped event reconciles
// that ref (isLedgerAutoDispatched deliberately excludes 'prune-closed' from
// that set — it is written speculatively for every ✅ tab, including ones
// pruneDone skips, so it cannot serve as evidence the ref is really gone).
// The SELECTED tab is never closed (covers actively-in-use) — that is now
// the only reclaim mitigation.
//
// 2026-08-02 owner rule #3 (supersedes same-day escalation #2): auto-close
// is limited to 🤖 auto-dispatched tabs, full stop — "closing sessions that
// were automatically spun up by other sessions... not sessions that I am
// actively typing in myself or have been." A ✅ tab the owner opened stays
// open even when its claude process is fully dead; pruneDone reports it as
// skipped and the owner closes it by hand. Within the 🤖 class the #709
// rule stands: dead or idle-at-prompt closes, mid-turn never. pruneDone's
// outer protections (never the SELECTED tab — re-checked immediately before
// close — never mid-turn, never unmarked) are unchanged.
// Crown (owner-loop) tabs are NEVER auto-closed, whatever the auto-dispatch
// signals say (task #1751, 2026-08-26). An owner session ran on Opus for 8
// days titled "✅ 🤖🔮 Data·OWNER: drive the Linear migration to done — own, m":
// it was dispatched through bsc-next, so buildAutoTitle stamped the 🤖 on it,
// so hasAutoDispatchMarker matched, so it was ✅-auto-marked on its first Stop
// and became closeable the moment it sat idle at the prompt — the owner spotted
// it only because the sidebar showed no 👑. The two auto-dispatch signals are
// both about HOW a tab was launched; a crown is a statement about what the tab
// IS, and it outranks them. This is deliberately belt-and-braces: a crowned
// title carries no 🤖 today, so the glyph signal alone would usually acquit it,
// but isLedgerAutoDispatched can still match a crowned tab by ref+subject (cmux
// renumbers refs across restarts), and that path has no title-shape opinion at
// all. Placing the veto here rather than in the title means no title matcher
// changes shape — a second-opinion review on 2026-08-26 killed the alternative
// (rewriting buildAutoTitle to lead with 👑), which desynchronised
// titleMatchesSubject and would have let the SAME card be dispatched twice.
//
// Regex mirrors dispatch-watchdog-core.js:81 CROWN_TAB_RE, which is private to
// that module and lives in the tier-"critical" dispatch layer (editing it needs
// a gated review, per CLAUDE.md rule 18). prune-closeable.test.mjs asserts the
// two literals stay byte-identical, so drift fails a test instead of silently
// splitting the definition of "crown tab" in half. Collapse them into this one
// export the next time the dispatch layer is opened under review.
const CROWN_TAB_RE = /^[^\p{L}\p{N}]*👑/u;

function isCrownTab(title) {
  return CROWN_TAB_RE.test(String(title || ''));
}

// title is OPTIONAL: callers that don't know it (or don't have one) keep the
// pre-#1751 behaviour byte-for-byte, since an absent title is not a crown.
function isCloseable({ hasLiveClaude, isAutoDispatched, isRunning, title }) {
  if (isCrownTab(title)) return false;
  if (!isAutoDispatched) return false;
  if (!hasLiveClaude) return true;
  return !isRunning;
}

module.exports = { AUTO_GLYPH, CROWN_TAB_RE, hasAutoDispatchMarker, isCrownTab, isCloseable };
