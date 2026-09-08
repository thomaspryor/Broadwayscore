// Colocated test for the nightly UX walkthrough's filing decision. It
// require()s the real module (CLAUDE.md rule 15) so a change to the policy
// fails here rather than drifting.
//
// The regression this exists to prevent has two halves, and the second is the
// dangerous one:
//   1. The walkthrough shelled out to notion-brain.js create, dead since the
//      2026-08-30 read-only flip — every finding logged one line and vanished.
//   2. Its dedup read ALSO shelled out to Notion, and caught its own failure
//      by returning [] — "no existing issues". Repointing only the create path
//      at Linear would have made every night refile every historical finding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PRIORITY_HIGH,
  PRIORITY_NORMAL,
  MIN_AGREEMENT,
  DUPE_SIMILARITY,
  similarity,
  titleFor,
  priorityFor,
  planFilings,
} from './ux-walkthrough-filing.js';

const model = (summary, extra = {}) => ({ summary, agreementCount: MIN_AGREEMENT, models: ['a', 'b'], severity: 'medium', ...extra });
const okBoard = (titles = []) => ({ titles, ok: true });

test('a FAILED board read files nothing — it is not an empty board', () => {
  // The whole point. ok:false must never be treated as "nothing on the board".
  const findings = [model('Watchlist button does nothing on mobile'), model('Diary date wheel is unreadable')];
  for (const bad of [null, undefined, { titles: [], ok: false }, { titles: [] }, { ok: 'yes', titles: [] }]) {
    const plan = planFilings({ findings, existing: bad });
    assert.equal(plan.refused, true);
    assert.deepEqual(plan.toFile, []);
    assert.match(plan.reason, /refusing to file|duplicating/i);
  }
});

test('an EMPTY board that read successfully does file', () => {
  // The mirror of the case above: a genuinely empty board is not an error.
  const plan = planFilings({ findings: [model('Watchlist button does nothing on mobile')], existing: okBoard([]) });
  assert.equal(plan.refused, false);
  assert.equal(plan.toFile.length, 1);
});

test('a finding already on the board is skipped, not refiled', () => {
  const title = titleFor(model('Watchlist button does nothing on mobile'));
  const plan = planFilings({
    findings: [model('Watchlist button does nothing on mobile')],
    existing: okBoard([title]),
  });
  assert.equal(plan.toFile.length, 0);
  assert.deepEqual(plan.skippedDuplicate, [title]);
});

test('two near-identical findings in ONE run file only once', () => {
  // The board read cannot know about a title minted seconds ago, so the
  // in-run queue has to be part of the dedup set. Without this a model
  // finding and a deterministic detector describing the same defect both file.
  const plan = planFilings({
    findings: [
      model('Watchlist button does nothing when tapped on mobile'),
      model('Watchlist button does nothing when tapped on mobile', { deterministic: true, models: ['ux-walkthrough:dead-control'] }),
    ],
    existing: okBoard([]),
  });
  assert.equal(plan.toFile.length, 1);
  assert.equal(plan.skippedDuplicate.length, 1);
});

test('a single-model finding is dropped, a deterministic one is not', () => {
  const plan = planFilings({
    findings: [
      model('Only one model saw this hierarchy problem', { agreementCount: 1 }),
      { summary: 'Dead control on the diary sheet', deterministic: true, models: ['ux-walkthrough:dead-control'], severity: 'high' },
    ],
    existing: okBoard([]),
  });
  assert.equal(plan.toFile.length, 1);
  assert.equal(plan.toFile[0].title, 'UX audit: Dead control on the diary sheet');
  assert.equal(plan.skippedLowAgreement.length, 1);
});

test('priority is a Linear NUMBER, never a Notion priority string', () => {
  // notion-brain took "P1 Next"/"P2 Later"; linear-brain takes 0-4. Passing
  // the old strings through would be a silent no-op on the wrong field.
  assert.equal(priorityFor({ severity: 'high' }), PRIORITY_HIGH);
  assert.equal(priorityFor({ severity: 'medium' }), PRIORITY_NORMAL);
  assert.equal(priorityFor({}), PRIORITY_NORMAL);
  for (const p of [PRIORITY_HIGH, PRIORITY_NORMAL]) {
    assert.equal(typeof p, 'number');
    assert.ok(p >= 0 && p <= 4, `Linear priority out of range: ${p}`);
  }
  const plan = planFilings({ findings: [model('x y z alpha beta', { severity: 'high' })], existing: okBoard([]) });
  assert.equal(plan.toFile[0].priority, PRIORITY_HIGH);
});

test('titles are prefixed and length-capped', () => {
  const t = titleFor({ summary: 'q'.repeat(400) });
  assert.ok(t.startsWith('UX audit: '));
  assert.ok(t.length <= 120, t.length);
  assert.equal(titleFor({}), 'UX audit: ');
});

test('similarity is symmetric, bounded, and empty-safe', () => {
  assert.equal(similarity('', 'anything at all here'), 0);
  assert.equal(similarity('watchlist button broken mobile', 'watchlist button broken mobile'), 1);
  const a = similarity('watchlist button broken mobile', 'watchlist button broken desktop');
  assert.equal(a, similarity('watchlist button broken desktop', 'watchlist button broken mobile'));
  assert.ok(a > 0 && a < 1);
  assert.ok(DUPE_SIMILARITY > 0 && DUPE_SIMILARITY <= 1);
});

test('unrelated findings are not collapsed into one', () => {
  const plan = planFilings({
    findings: [model('Watchlist button does nothing on mobile'), model('Diary calendar wheel truncates the year')],
    existing: okBoard([]),
  });
  assert.equal(plan.toFile.length, 2);
  assert.equal(plan.skippedDuplicate.length, 0);
});

test('no findings is a clean empty plan, not a refusal', () => {
  const plan = planFilings({ findings: [], existing: okBoard(['UX audit: something old']) });
  assert.equal(plan.refused, false);
  assert.deepEqual(plan.toFile, []);
});

test('null entries in the findings list are ignored, not crashed on', () => {
  const plan = planFilings({ findings: [null, undefined, model('Watchlist button does nothing on mobile')], existing: okBoard([]) });
  assert.equal(plan.refused, false);
  assert.equal(plan.toFile.length, 1);
});

// ─── Source scan of the caller ──────────────────────────────────────────────
// The path entry for scripts/ux-walkthrough.mjs in test.yml buys a CI TRIGGER;
// on its own it does not buy DETECTION — an edit repointing the filing call
// back at notion-brain.js would run CI and pass, because nothing asserts the
// argv. These cases close that, following the precedent set by
// scripts/audit-imageless-scored-shows.js's test (test.yml:36-43), which reads
// its caller's real source to assert a removed loop stays removed.
//
// The file is read, never imported: ux-walkthrough.mjs calls main() at its tail
// with no import.meta.main guard, so importing it would launch the whole
// Playwright walkthrough.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Structural assertions must read CODE, not prose — the same helper and the
// same reason as scripts/lib/notion-write-guard.test.mjs: this module's own
// comments necessarily quote `notion-brain.js create` to explain what was
// wrong, and a scan of the raw source would match that and fail on correct
// code. A test a comment can fool proves nothing.
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, ''))
    .join('\n');
}

const WALKTHROUGH = join(dirname(fileURLToPath(import.meta.url)), '..', 'ux-walkthrough.mjs');
const walkthroughCode = () => stripComments(readFileSync(WALKTHROUGH, 'utf8'));

test('the walkthrough has no live reference to the retired Notion brain', () => {
  const code = walkthroughCode();
  assert.ok(!/notion-brain/.test(code), 'ux-walkthrough.mjs reaches notion-brain.js again — that command has exited 6 since 2026-08-30, so every finding would be silently dropped');
  assert.ok(!/notion/i.test(code), 'ux-walkthrough.mjs mentions Notion in code again — the board is Linear');
});

test('the walkthrough files through the linear-brain chokepoint', () => {
  const code = walkthroughCode();
  assert.ok(/linear-brain\.js/.test(code), 'filing must go through scripts/linear-brain.js — the single creation chokepoint, which is what applies the duplicate gate and cap policy');
  assert.ok(/planFilings/.test(code), 'the filing decision must come from planFilings, not be re-inlined here');
});

test('the caller treats a ZERO-issue board read as a failed read', () => {
  // listOpenIssuesWithDescriptions turns a malformed response into an empty
  // list by design (`data.issues || { nodes: [], … }`), so "empty board" and
  // "unparseable response" are the same value — and the second, taken at face
  // value, refiles every historical finding. The caller must convert a
  // zero-length read into ok:false before it ever reaches planFilings.
  const code = walkthroughCode();
  assert.ok(/titles\.length === 0/.test(code), 'existingCardTitles must guard against a zero-length board read');
  assert.ok(/ok: false/.test(code), 'a zero-length read must return ok:false, not an empty ok:true board');
});

test('dedup covers CLOSED findings, not only the open board', () => {
  // listOpenIssuesWithDescriptions excludes completed/canceled/duplicate. A UX
  // finding closed as won't-fix describes a defect that is usually still there,
  // so the walkthrough re-detects it, fails to match it against an open-only
  // board, and refiles it every night. The old Notion search matched any
  // status; narrowing here would turn this fix into the duplicate generator it
  // exists to prevent.
  const code = walkthroughCode();
  assert.ok(/includeArchived: true/.test(code), 'the closed-findings read must include archived issues (most terminal issues are archived within 48h)');
  assert.ok(/UX audit:/.test(code), 'the closed-findings read must be scoped to UX-audit titles');
});

test('a calibration run does not read the board at all', () => {
  const code = walkthroughCode();
  assert.ok(/args\.noFile \? \{ titles: \[\], ok: false \}/.test(code), '--noFile must skip the paginated board read it never uses');
});

test('the caller persists WHY nothing was filed, not just an empty list', () => {
  // `filed: []` alone cannot tell a clean night from a night where the board
  // read failed and nothing reached Linear. The workflow step is
  // continue-on-error, so a silent zero looks exactly like success.
  const code = walkthroughCode();
  assert.ok(/filingStatus/.test(code), 'review.json must record filingStatus');
  assert.ok(/::warning::/.test(code), 'a refusal or a failed create must emit a CI warning annotation');
});

test('the caller no longer claims linear-brain applies a duplicate gate', () => {
  // It does not — linear-issue-create.js has no duplicate gate, and filing is
  // check-then-create against a snapshot taken before the loop. An earlier
  // comment here asserted otherwise without verifying it.
  const raw = readFileSync(WALKTHROUGH, 'utf8'); // comments INCLUDED on purpose
  assert.ok(
    !/duplicate gate and cap policy apply here for free/.test(raw),
    'the false "duplicate gate for free" claim must not come back'
  );
});

test('the walkthrough does not carry its own copy of titleFor', () => {
  // A byte-identical twin left in the caller is the definition a future "fix
  // the title format" edit lands on, with CI staying green.
  assert.ok(!/function titleFor/.test(walkthroughCode()), 'titleFor is defined in this lib; a second copy in ux-walkthrough.mjs will drift');
});
