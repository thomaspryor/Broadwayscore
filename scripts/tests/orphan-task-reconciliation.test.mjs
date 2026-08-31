/**
 * orphan-task-reconciliation.test.mjs — task #1705 acceptance.
 *
 * #1691 fixed the DOMINANT cause of orphaned in_progress tasks (a mirrored
 * task whose Notion card had already flipped to Done) and drained the
 * backlog 197 -> 90, but never reported the split its own card promised and
 * never finished the remaining 90 — that is what #1705 closes out.
 *
 * This is a LIVE-DATA PROBE, not a unit test (same shape as
 * scripts/verify-main-green-streak.test.mjs): it reads the real shared task
 * mirror (~/.claude/tasks/<list>/) and the real `cmux list-workspaces`
 * output, neither of which exist in CI. It is NOT in EXEMPT_NEVER_CI
 * (verified BRO-2611, 2026-08-31) — it doesn't need to be: findOrphans()'s
 * loadLiveTasks() degrades to [] when ~/.claude/tasks/<list>/ is absent (as
 * on every CI runner), so this test vacuously passes (0 orphans, 0
 * unexplained) rather than failing or erroring there. It only surfaces real
 * findings on a machine with a live task mirror + cmux — i.e. Tom's own
 * dev machine, which is exactly where the triage list below needs updating.
 *
 * "The survivors named ... so they cannot grow silently" (card #1705's own
 * acceptance wording) is enforced literally: every in_progress task with no
 * live workspace match must be a member of JUSTIFIED_SURVIVORS below, with a
 * bucket + reason recorded at the time of the 2026-08-16 triage. A NEW
 * orphan that shows up later (a task some other session claimed and then
 * lost, or a card that drifted back into this state) is NOT auto-forgiven —
 * this test fails loudly and names the unexplained id(s), which is the
 * signal that the triage in scripts/audit-orphan-inprogress.js needs to run
 * again and this list needs an update, not a silent re-widening of the floor.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { findOrphans } = require(path.join(REPO, 'scripts/audit-orphan-inprogress.js'));

// Final snapshot taken 2026-08-16 by `node scripts/audit-orphan-inprogress.js
// --json`, run from the MAIN checkout (not a worktree — see the ledger-null
// note below) after applying --fix. See that script's module docstring for
// what each action name means.
//
// #57, #1407, #1442 carry a real story: an earlier pass of this SAME session
// ran the tool from a worktree, where data/audit/dispatch-ledger.jsonl
// (gitignored) doesn't exist. dispatchedTaskIds() returning null got
// silently coerced to an empty Set, making all three look never-dispatched
// when they had real launch/job-spawned/job-done history — they were
// wrongly reclaimed to LOST/pending. Caught by an adversarial ship-check
// review, reverted (local status + Notion card both restored to
// in_progress/In progress), and the driver now refuses to run at all when
// the ledger is unreadable instead of guessing (audit-orphan-inprogress.js's
// startedIdsRaw === null branch). All three currently read skip-fresh only
// because the revert itself just touched their cards; a later re-run past
// the 48h window will classify them for real, this time with a working ledger.
const JUSTIFIED_SURVIVORS = {
  53: 'skip-fresh (in substance a standing commercial-data review request the digest keeps appending to; not dispatchable work, should probably never have mirrored as in_progress at all — follow-up worth filing, out of scope for #1705)',
  278: 'park-outcome — Outcome present, no keyFile/commit hash in it could be corroborated against the repo',
  1147: 'park-started — description says a branch (worktree-coverage-defects-1147) was pushed to origin but not merged; may hold real unlanded work',
  1217: 'park-outcome — Action-Queue verification-gate stuck retrying "Start" with no VERIFIED/UNVERIFIED confirmation; the claimed DONE was never actually confirmed',
  1279: 'park-outcome — uncorroborated Outcome',
  1286: 'park-outcome — uncorroborated Outcome',
  1287: 'park-outcome — uncorroborated Outcome',
  1305: 'park-outcome — uncorroborated Outcome',
  1307: 'park-outcome — uncorroborated Outcome',
  1313: 'park-outcome — uncorroborated Outcome',
  1317: 'park-outcome — uncorroborated Outcome',
  1318: 'park-outcome — uncorroborated Outcome',
  1326: 'park-outcome — uncorroborated Outcome',
  1334: 'park-outcome — uncorroborated Outcome',
  1356: 'park-outcome — uncorroborated Outcome',
  1407: 'skip-fresh — wrongly-reclaimed-then-reverted (see note above); real ledger history, needs a real re-classification pass once quiet',
  1415: 'park-outcome — uncorroborated Outcome',
  1442: 'skip-fresh — wrongly-reclaimed-then-reverted (see note above); real ledger history, needs a real re-classification pass once quiet',
  1468: 'park-outcome — uncorroborated Outcome',
  1496: 'skip-fresh — card edited within the last 48h',
  1546: 'skip-fresh — card edited within the last 48h',
  1612: 'skip-fresh — card edited within the last 48h',
  1620: 'skip-fresh — card edited within the last 48h',
  1626: 'skip-fresh — card edited within the last 48h',
  1639: 'skip-fresh — card edited within the last 48h',
  1640: 'skip-fresh — card edited within the last 48h',
  1664: 'skip-fresh — card edited within the last 48h',
  1670: 'skip-fresh — card edited within the last 48h',
  1682: 'recheck-after-pending — "Disk full 99pct - worktree-gc frees 0KB" names a RECHECK-AFTER date that has not passed yet',
  1700: 'skip-fresh — card edited within the last 48h',
  57: 'skip-fresh — wrongly-reclaimed-then-reverted (see note above); real ledger history, needs a real re-classification pass once quiet',
};

// Two tasks the triage resolved to local status 'completed' — NOT orphans,
// not in the map above, but worth the paper trail: #586 and #1226 both have
// real shipped/corroborated work AND an explicit RECHECK-AFTER date
// (2026-08-18/24 and 2026-08-17) that has not passed. A first pass of this
// triage force-closed both to Notion "Done" before catching the mistake —
// see scripts/lib/orphan-inprogress-triage.js's recheck-after-pending guard,
// added specifically because of these two. Their local mirror status is
// 'completed' (not dispatchable, correctly out of findOrphans()'s population)
// while their Notion card stays Paused (not Done) until the recheck date.

test('every in_progress-with-no-workspace task is a named, justified survivor', () => {
  const orphans = findOrphans();
  const orphanIds = orphans.map((t) => String(t.id));
  const unexplained = orphanIds.filter((id) => !(id in JUSTIFIED_SURVIVORS));

  assert.equal(
    unexplained.length, 0,
    `${unexplained.length} in_progress task(s) with no live workspace are NOT in the justified-survivor list: ` +
    `${unexplained.join(', ')}. Re-run \`node scripts/audit-orphan-inprogress.js\` and either fix them ` +
    `(--fix) or add them to JUSTIFIED_SURVIVORS in this test with a reason — do not silently widen the floor.`
  );
});

test('the justified-survivor floor did not silently grow past its 2026-08-16 size', () => {
  // A named survivor that RESOLVES (dispatched, closed, reclaimed) should be
  // removed from the list, not left stale — this catches the list quietly
  // accumulating entries nobody prunes. 31 is the count as of the #1705
  // triage's FINAL pass (run from the main checkout, with a working ledger,
  // after reverting the 3 wrongly-reclaimed tasks); this is a ceiling, not a
  // target — shrinking it is always fine.
  const floorSize = Object.keys(JUSTIFIED_SURVIVORS).length;
  assert.ok(floorSize <= 31, `JUSTIFIED_SURVIVORS grew to ${floorSize} entries (started at 31) — that is the exact "grows silently" failure mode this test exists to catch. Re-triage before adding more names.`);
});
