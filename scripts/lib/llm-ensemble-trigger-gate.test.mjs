/**
 * BRO-2985 — "LLM Ensemble Score Reviews cannot be re-triggered for work it
 * will never do."
 *
 * THE INCIDENT
 * llm-ensemble-score.yml ran 49 times in 2 days (29 times in the 8.5h to
 * 14:38 UTC on 2026-09-08 alone) for the-story-west-end-2026 with nothing to
 * score. Every re-run's only diff was data/collection-state/scoring-progress.json
 * (+2/-2 — lastUpdated + runId).
 *
 * THE ACTUAL TRIGGER (the card's hypothesis was a `push:` path — it was not)
 * llm-ensemble-score.yml has NO push trigger at all; it is schedule +
 * workflow_dispatch only. The loop was:
 *
 *   verify-all-scored.js  (runs in rebuild-fast.yml AND rebuild-reviews.yml)
 *     └─ sees an orphan-unscored file
 *     └─ workflow_dispatch llm-ensemble-score.yml (show_id, fast_rebuild=true)
 *          └─ scorer refuses the file pre-LLM ("Processed: 0 / Skipped: 1")
 *          └─ writes scoring-progress.json, which satisfies that workflow's own
 *             has_changes gate
 *          └─ workflow_dispatch rebuild-fast.yml
 *               └─ runs verify-all-scored.js  ──── back to the top, forever
 *
 * The pinned file was the-spectator-uk--unknown.json: a spectator.co.uk/submit
 * CONTACT PAGE scraped from a 2020 archive.org snapshot (70 words / 583 chars),
 * carrying rescoreBlockedReason 'input_validation_failed:body_too_short'. Zero
 * LLM tokens were ever spent — the cost was ~32 min of runner time per lap,
 * plus a chained rebuild-fast runner.
 *
 * WHAT THIS FILE LOCKS
 *   1. The dispatch edge: no dispatcher may fire the scoring workflow for a
 *      file the scorer's own selector would skip. This is the load-bearing
 *      half — it is what stops the runner booting at all.
 *   2. The workflow shape: the scoring workflow must not gain a push trigger
 *      that its own checkpoint write (data/collection-state/**) would match.
 *      Nothing broke here, but adding such a trigger would reopen the loop at
 *      a layer no unit test watches.
 *   3. The guard must NOT have "fixed" the loop by going blind: a genuine
 *      orphan (rebuild includes it, no score, scorer would take it) must still
 *      dispatch. That is the Lost Boys 2026-04-26 #8 class this guard exists
 *      for, and the cheapest wrong fix here would silence it.
 *
 * Run: node --test scripts/lib/llm-ensemble-trigger-gate.test.mjs
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');

// The REAL production functions — never a reimplementation (CLAUDE.md §15).
const { auditShow } = require(path.join(REPO_ROOT, 'scripts', 'verify-all-scored.js'));
const { unscoredSkipReason } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'scoring-queue-counts.js'));
const { classifySilentGap } = require(path.join(REPO_ROOT, 'scripts', 'lib', 't1-silent-gap.js'));
const { indentOf } = require(path.join(REPO_ROOT, 'scripts', 'lib', 'ci-cancellation-guard.js'));

// The file that pinned the loop, reduced to the fields that decide its fate.
// Values copied verbatim from
// data/review-texts/the-story-west-end-2026/the-spectator-uk--unknown.json.
const SPECTATOR_SUBMIT_PAGE = {
  showId: 'the-story-west-end-2026',
  outletId: 'the-spectator-uk',
  outlet: 'The Spectator  (UK)',
  criticName: 'Unknown',
  url: 'https://www.spectator.co.uk/submit/',
  source: 'outlet-listing-poller',
  publishDate: null,
  contentTier: 'truncated',
  fullText:
    'Have a story to share with us? Contact the right member of the editorial team below.\n\n' +
    'Will Moore\nwmoore@spectator.co.uk\n News editorJohn Connolly\njconnolly@spectator.co.uk\n ' +
    'PodcastsCindy Yu\ncindy.yu@spectator.co.uk\n \n \n Literary editorSam Leith\nsam@spectator.co.uk\n ' +
    'Arts editorIgor Torony-Lalic\nigor@spectator.co.uk\n LettersLetters\nletters@spectator.co.uk\n\n \n \n' +
    'The editor\nFraser Nelson\ntheeditor@spectator.co.uk\n\nAlternatively, please write to us at:\n\n' +
    '22 Old Queen Street\nLondon\nSW1A 0A\n\nOther contact details, such as for our customer services ' +
    'or marketing teams, can be found here.',
  isFullReview: false,
  textWordCount: 70,
  textQuality: 'truncated',
  textStatus: 'truncated',
  wordCount: 70,
  rescoreAttempts: 1,
  rescoreBlockedReason: 'input_validation_failed:body_too_short',
  rescoreBlockedAt: '2026-09-06T15:11:26.316Z',
  rescoreBlockedTextLength: 583,
  rescoreBlockedHadExcerpt: false,
};

const THE_STORY = { id: 'the-story-west-end-2026', title: 'The Story', openingDate: '2026-09-03' };

// A real orphan: substantive text, no exclusion flags, no score anywhere.
// Shaped after Lost Boys 2026-04-26 amNY Matt Windman / Exeunt Loren Noveck.
const GENUINE_ORPHAN = {
  outletId: 'exeunt-magazine',
  criticName: 'Loren Noveck',
  url: 'https://exeunt.example/the-story-review',
  fullText: 'The Story is a considerable piece of theatre. '.repeat(80),
  contentTier: 'complete',
};

// ── 1. The dispatch edge ────────────────────────────────────────────────────

test('the file that pinned BRO-2985 is not dispatchable work', () => {
  const reason = unscoredSkipReason(SPECTATOR_SUBMIT_PAGE, {
    show: THE_STORY,
    showTitle: THE_STORY.title,
  });
  assert.notEqual(
    reason,
    null,
    'the spectator.co.uk/submit contact page must have a skip reason — if this ' +
      'is null the scorer would take it and dispatching is legitimate',
  );
});

test('a genuine orphan IS still dispatchable work (the guard did not go blind)', () => {
  const reason = unscoredSkipReason(GENUINE_ORPHAN, {
    show: THE_STORY,
    showTitle: THE_STORY.title,
  });
  assert.equal(
    reason,
    null,
    `a substantive unscored review must stay dispatchable, got skip reason "${reason}". ` +
      'Silencing this is the Lost Boys 2026-04-26 #8 regression, not a fix.',
  );
});

// auditShow walks REPO_ROOT/data/review-texts/<showId>/, so stage a synthetic
// show inside it under an obviously-fake id and clean up. Same approach as
// tests/unit/verify-all-scored.test.mjs.
const SYNTHETIC_SHOW_ID = '__bro-2985-trigger-gate-fixture__';
const SYNTHETIC_DIR = path.join(REPO_ROOT, 'data', 'review-texts', SYNTHETIC_SHOW_ID);

function stage(files) {
  fs.mkdirSync(SYNTHETIC_DIR, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    fs.writeFileSync(path.join(SYNTHETIC_DIR, name), JSON.stringify(data, null, 2) + '\n');
  }
}

test('auditShow: a show whose ONLY orphan is scorer-refused yields zero dispatchable orphans', (t) => {
  t.after(() => fs.rmSync(SYNTHETIC_DIR, { recursive: true, force: true }));
  stage({ 'the-spectator-uk--unknown.json': SPECTATOR_SUBMIT_PAGE });

  const result = auditShow(SYNTHETIC_SHOW_ID, THE_STORY);

  // Still REPORTED — the operator must be able to see it.
  assert.equal(result.orphans.length, 1, 'the junk file must still surface as an orphan');
  // But NOT dispatchable — this is the assertion that breaks the loop.
  assert.equal(
    result.actionableOrphans.length,
    0,
    'BRO-2985 REGRESSION: verify-all-scored.js would workflow_dispatch ' +
      'llm-ensemble-score.yml for a file the scorer refuses pre-LLM. That is ' +
      'the 49-runs-in-2-days loop.',
  );
  assert.equal(result.blockedOrphans.length, 1);
  assert.equal(result.orphans[0].dispatchActionable, false);
  assert.ok(result.orphans[0].skipReason, 'the skip reason must be recorded, not silently dropped');
  // opening-night-broadcast.yml:963 renders this field into the overdue alert.
  assert.equal(
    result.orphans[0].rescoreBlockedReason,
    'input_validation_failed:body_too_short',
  );
});

test('auditShow: a self-clearing backoff is not dispatchable, but is still counted as an orphan', (t) => {
  // Caught by running the fix against the real corpus: 28 of 173 blocked
  // orphans were in the manual-clear Haiku backoff (24h-7d,
  // manual-clear-fallback-cooldown.js). Dispatching now is futile, but the
  // file WILL score itself — and it stays in `orphans`, so the broadcast gate
  // (which counts orphans, never actionableOrphans) keeps blocking on it.
  t.after(() => fs.rmSync(SYNTHETIC_DIR, { recursive: true, force: true }));
  stage({
    'guardian--in-backoff.json': {
      ...GENUINE_ORPHAN,
      outletId: 'guardian',
      criticName: 'Arifa Akbar',
      manualClearFallbackFailedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      manualClearFallbackAttempts: 1,
    },
  });

  const result = auditShow(SYNTHETIC_SHOW_ID, THE_STORY);

  assert.equal(result.orphans.length, 1);
  assert.equal(result.actionableOrphans.length, 0, 'a file in backoff must not be dispatched');
  assert.equal(result.orphans[0].skipReason, 'manual_clear_fallback_cooldown');
});

test('auditShow: a genuine orphan alongside the junk still triggers a dispatch', (t) => {
  t.after(() => fs.rmSync(SYNTHETIC_DIR, { recursive: true, force: true }));
  stage({
    'the-spectator-uk--unknown.json': SPECTATOR_SUBMIT_PAGE,
    'exeunt-magazine--loren-noveck.json': GENUINE_ORPHAN,
  });

  const result = auditShow(SYNTHETIC_SHOW_ID, THE_STORY);

  assert.equal(result.orphans.length, 2);
  assert.equal(
    result.actionableOrphans.length,
    1,
    'one junk file must never suppress the dispatch a real orphan needs',
  );
  assert.equal(result.actionableOrphans[0].outletId, 'exeunt-magazine');
});

test('t1 silent-gap sweep marks the same file non-dispatchable', () => {
  // The second dispatcher of llm-ensemble-score.yml (audit-t1-silent-gaps.js,
  // hourly, capped at one dispatch per show per DISPATCH_RETRY_HOURS=6). Same
  // blind spot, bounded rather than unbounded — 4 wasted runner boots a day.
  const gap = classifySilentGap({
    file: SPECTATOR_SUBMIT_PAGE,
    show: THE_STORY,
    tier: 1,
    outletScored: false,
    now: new Date('2026-09-08T14:00:00Z'),
  });
  if (gap && gap.type === 'unscored') {
    assert.equal(
      gap.dispatchable,
      false,
      'BRO-2985 REGRESSION: the T1 sweep would dispatch scoring for a file the ' +
        'scorer refuses, 4x/day/show forever.',
    );
  }
});

// ── 2. The workflow shape ───────────────────────────────────────────────────

// No js-yaml: it is a transitive dep only and test.yml's lint-workflows job runs
// no `npm ci`. Same indentation-aware reading as scripts/lib/ci-cancellation-guard.js
// (whose indentOf we reuse rather than re-deriving).
function topLevelOnBlock(raw) {
  const lines = raw.split('\n');
  const onIdx = lines.findIndex((l) => /^['"]?on['"]?\s*:/.test(l) && indentOf(l) === 0);
  if (onIdx === -1) return null;
  const out = [];
  for (let i = onIdx + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (indentOf(line) <= 0) break;
    out.push(line);
  }
  return out;
}

// The workflow's own checkpoint write. If any trigger path can match this, the
// workflow re-triggers itself on its own commit.
const SELF_WRITTEN_PATHS = [
  'data/collection-state/scoring-progress.json',
  'data/collection-state/',
  'data/collection-state/**',
  'data/**',
  'data/',
];

test('llm-ensemble-score.yml has no push trigger its own checkpoint write could match', () => {
  const raw = fs.readFileSync(path.join(WORKFLOWS, 'llm-ensemble-score.yml'), 'utf8');
  const onBlock = topLevelOnBlock(raw);
  assert.ok(onBlock, 'llm-ensemble-score.yml must have a top-level `on:` block');

  const hasPush = onBlock.some((l) => /^\s{2}push\s*:/.test(l));
  if (!hasPush) return; // the shape that holds today

  // A push trigger appeared. It must exclude the checkpoint file, or the
  // workflow re-triggers on every one of its own no-op runs.
  const body = onBlock.join('\n');
  const guarded = /paths-ignore\s*:/.test(body)
    && SELF_WRITTEN_PATHS.some((p) => body.includes(p));
  assert.ok(
    guarded,
    'llm-ensemble-score.yml gained a push trigger without a paths-ignore ' +
      'excluding data/collection-state/scoring-progress.json — it writes that ' +
      'file on EVERY run, including runs that score nothing, so this re-triggers ' +
      'itself indefinitely (BRO-2985).',
  );
});

test('the workflows that run verify-all-scored.js cannot be push-triggered by the checkpoint file', () => {
  // rebuild-fast.yml and rebuild-reviews.yml close the loop: they run
  // verify-all-scored.js, which dispatches llm-ensemble-score.yml. If either
  // gained a push trigger matching the scoring checkpoint, the cycle is live
  // again regardless of the dispatch-side gate above.
  for (const wf of ['rebuild-fast.yml', 'rebuild-reviews.yml']) {
    const file = path.join(WORKFLOWS, wf);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(
      raw.includes('scripts/verify-all-scored.js'),
      `${wf} no longer runs verify-all-scored.js — this test's premise moved; re-trace the dispatch graph.`,
    );
    const onBlock = topLevelOnBlock(raw);
    assert.ok(onBlock, `${wf} must have a top-level \`on:\` block`);
    const hasPush = onBlock.some((l) => /^\s{2}push\s*:/.test(l));
    assert.equal(
      hasPush,
      false,
      `${wf} gained a push trigger. It runs verify-all-scored.js, which dispatches ` +
        'llm-ensemble-score.yml, which commits data/collection-state/scoring-progress.json ' +
        '— a push trigger here closes that cycle (BRO-2985). If this is intentional, ' +
        'it needs a paths-ignore for data/collection-state/ and this assertion updated.',
    );
  }
});
