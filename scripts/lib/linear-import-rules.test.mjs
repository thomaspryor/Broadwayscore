import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNotionId,
  extractPriorityTag,
  mapPriorityToLinear,
  mapStatusToLinearState,
  classifyNoise,
  classifyProject,
  isIdleArchive,
  PRIORITY_SPELLINGS,
  normalizePriorityTier,
  isLivePriorityTier,
} from './linear-import-rules.js';

test('extractNotionId finds the tag anywhere in the description, not just line 1', () => {
  assert.equal(
    extractNotionId('[notion:3b2637c5-416f-81b5-9040-c95cf463ba19]\nP1 Next'),
    '3b2637c5-416f-81b5-9040-c95cf463ba19'
  );
  assert.equal(
    extractNotionId('[zombie-sweep 2026-08-11] reopened\n\n[notion:3b1637c5-416f-0000-0000-000000000000]\nP1 Next'),
    '3b1637c5-416f-0000-0000-000000000000'
  );
  assert.equal(extractNotionId('no tag here'), null);
  assert.equal(extractNotionId(''), null);
  assert.equal(extractNotionId(undefined), null);
});

test('extractPriorityTag reads P0/P1/P2 from anywhere in the description', () => {
  assert.equal(extractPriorityTag('[notion:x] P1 Next · Not started · Product'), 'P1 Next');
  assert.equal(
    extractPriorityTag('[zombie-sweep] reopened\n\n[notion:x] P2 Later · Not started'),
    'P2 Later'
  );
  assert.equal(extractPriorityTag('no priority tag'), null);
});

test('mapPriorityToLinear: P0->Urgent(1), P1->High(2), P2->Medium(3), P3->Low(4)', () => {
  assert.equal(mapPriorityToLinear('P0 Now'), 1);
  assert.equal(mapPriorityToLinear('P1 Next'), 2);
  assert.equal(mapPriorityToLinear('P2 Later'), 3);
  assert.equal(mapPriorityToLinear('P3 Backlog'), 4);
  // No usable priority maps to 0 (No priority), not 4 (Low). Low asserts
  // something the data never said, and across 1,831 imported cards that is the
  // difference between a triageable backlog and a uniformly-grey one.
  assert.equal(mapPriorityToLinear(null), 0);
  assert.equal(mapPriorityToLinear('garbage'), 0);
});

// --- S3-T1: every legacy spelling on the board -----------------------------

// The complete Priority vocabulary, read off the data source schema on
// 2026-08-17 (properties.Priority.select.options) — 26 values, not the 17 the
// sprint plan assumed. Each is asserted INDIVIDUALLY rather than by rerunning
// the implementation's own regex over the list, so a rule change that silently
// reclassifies one spelling fails here.
const EXPECTED_TIERS = {
  'P0 Now': 'P0', 'P0 Urgent': 'P0', P0: 'P0',
  'P1 Next': 'P1', 'P1 Now': 'P1', 'P1 Soon': 'P1', P1: 'P1',
  'P2 Later': 'P2', 'P2 Soon': 'P2', 'P2 Next': 'P2', 'P2 Future': 'P2', 'P2 Backlog': 'P2', P2: 'P2',
  'P3 Backlog': 'P3', 'P3 Low': 'P3', 'P3 Eventually': 'P3', 'P3 Someday': 'P3',
  'P3 Future': 'P3', 'P3 Later': 'P3', P3: 'P3',
  P4: 'P3', P9: 'P3',
  High: 'P1', Medium: 'P2', Low: 'P3',
  // 'Done' is a STATUS someone set in the Priority column. It carries no
  // priority information, so it must not become Low by accident.
  Done: null,
};

test('every one of the 26 board Priority spellings normalises to a tier', () => {
  assert.equal(PRIORITY_SPELLINGS.length, 26, 'the vocabulary changed — re-read the schema');
  for (const spelling of PRIORITY_SPELLINGS) {
    assert.ok(spelling in EXPECTED_TIERS, `no expectation recorded for ${JSON.stringify(spelling)}`);
    assert.equal(
      normalizePriorityTier(spelling),
      EXPECTED_TIERS[spelling],
      `${JSON.stringify(spelling)} normalised wrong`
    );
  }
  for (const spelling of Object.keys(EXPECTED_TIERS)) {
    assert.ok(PRIORITY_SPELLINGS.includes(spelling), `${spelling} is expected but not in the vocabulary`);
  }
});

test('the P0/P1 tiers map to Linear Urgent/High across every legacy spelling', () => {
  // The Sprint 3 acceptance criterion: legacy-spelling P0/P1-tier cards must
  // land on Urgent/High, not fall through to Low.
  for (const [spelling, tier] of Object.entries(EXPECTED_TIERS)) {
    const got = mapPriorityToLinear(spelling);
    const want = { P0: 1, P1: 2, P2: 3, P3: 4 }[tier] ?? 0;
    assert.equal(got, want, `${spelling} -> ${got}, expected ${want}`);
  }
});

test('isLivePriorityTier splits the board exactly at P1/P2', () => {
  // P0/P1 import live; P2/P3 import Canceled + notion-archive. An
  // unprioritised card is NOT live work — routing it into the dispatchable
  // half is how the invisible backlog gets recreated.
  for (const [spelling, tier] of Object.entries(EXPECTED_TIERS)) {
    assert.equal(isLivePriorityTier(spelling), tier === 'P0' || tier === 'P1', spelling);
  }
  assert.equal(isLivePriorityTier(null), false);
  assert.equal(isLivePriorityTier(''), false);
  assert.equal(isLivePriorityTier('nonsense'), false);
});

test('extractPriorityTag prefers the longest spelling and does not invent one from prose', () => {
  assert.equal(extractPriorityTag('[notion:x] P0 Urgent · Not started'), 'P0 Urgent');
  assert.equal(extractPriorityTag('[notion:x] P3 Eventually · Not started'), 'P3 Eventually');
  // 'P1 Next' must win over the bare 'P1' that prefixes it.
  assert.equal(extractPriorityTag('[notion:x] P1 Next · Not started'), 'P1 Next');
  // A bare spelling still matches when that is genuinely what the card says.
  assert.equal(extractPriorityTag('[notion:x] P2 · Not started'), 'P2');
  assert.equal(extractPriorityTag('[notion:x] High · Not started'), 'High');
  // But a loose /P\d/ pattern would read a priority out of ordinary prose, and
  // the mirror descriptions are full of it.
  assert.equal(extractPriorityTag('drain the P1 backlog'), 'P1', 'a real word-boundary hit is still a hit');
  assert.equal(extractPriorityTag('see PR1234 and P10 notes'), null, 'no partial-word matches');
  assert.equal(extractPriorityTag('no priority tag'), null);
});

test('mapStatusToLinearState: in_progress stays In Progress, everything else is Backlog', () => {
  assert.equal(mapStatusToLinearState('in_progress'), 'In Progress');
  assert.equal(mapStatusToLinearState('pending'), 'Backlog');
  assert.equal(mapStatusToLinearState('completed'), 'Backlog');
  assert.equal(mapStatusToLinearState(undefined), 'Backlog');
});

test('classifyNoise catches each documented noise category', () => {
  assert.equal(classifyNoise('BSC Daily: Cron failed: Test Suite'), 'bsc_daily');
  assert.equal(classifyNoise('Rage clicks on /west-end page (4 occurrences)'), 'rage_ux');
  assert.equal(
    classifyNoise("UX audit: Dead end on 'desktop__lists_tab'. No obvious next action"),
    'rage_ux'
  );
  assert.equal(
    classifyNoise('T1/T2 review stuck >24h: Now You See Me Live — thestage'),
    't1t2_alert'
  );
  assert.equal(classifyNoise('T1 Coverage alert: drain 6 post-rollout gap cells'), 't1t2_alert');
  assert.equal(classifyNoise('Missing show: High Society (West End 2026)'), 'missing_show');
  assert.equal(
    classifyNoise('[em-20260810-123602] New submission from Broadway Scorecard Feedback'),
    'email_triage'
  );
  assert.equal(
    classifyNoise('Session-system v2 subtraction V1: queue-first migration'),
    'fleet_selfref'
  );
  assert.equal(
    classifyNoise('P1: the 2-death dispatch cap blames the TASK for infrastructure flakiness'),
    'fleet_selfref'
  );
});

test('classifyNoise passes through real backlog work', () => {
  assert.equal(
    classifyNoise('NYT bot-stub reviews mislabeled contentTier=complete (scored on partial text)'),
    null
  );
  assert.equal(
    classifyNoise('Fix provisionalOutletIdFromHost garbage slugs (.co.uk, *.wordpress.com)'),
    null
  );
});

test('classifyProject routes to the most specific matching workstream', () => {
  assert.equal(classifyProject('iOS Stats P2 polish batch (sim-QA leftovers)'), 'iOS');
  assert.equal(
    classifyProject('Commercial Scorecard: signup-gate the entire card'),
    'Commercial'
  );
  assert.equal(
    classifyProject('T1/T2 silent gap on near-opening show: Disruption — wsj'),
    'Opening night'
  );
  assert.equal(classifyProject('Post revivals post on Reddit'), 'Marketing/distribution');
  assert.equal(
    classifyProject('Comparative within-show anchored scoring (fix 97-clustering)'),
    'Scoring quality'
  );
  assert.equal(
    classifyProject('Author-page critic discovery — NYT/New Yorker/Vulture/BWW per-critic indexes'),
    'Coverage pipeline'
  );
  assert.equal(
    classifyProject('Local pre-push hook does not check the CLAUDE.md byte cap'),
    'Infrastructure'
  );
});

// --- regressions found by running the classifier over the real 200-card
// mirror on 2026-08-12, not by reasoning about the patterns ---

test('isIdleArchive routes idle PENDING cards only', () => {
  assert.equal(isIdleArchive('pending', 40), true);
  assert.equal(isIdleArchive('pending', 12), true); // cutoff is inclusive
  assert.equal(isIdleArchive('pending', 11), false);
  assert.equal(isIdleArchive('pending', null), false); // unknown age is not idle
  // in_progress is live work by definition — someone is holding it right now,
  // and a stale Notion edit time says nothing about that.
  assert.equal(isIdleArchive('in_progress', 40), false);
});

test('distribution keywords need distribution intent, not a substring match', () => {
  // "cross-producti(on Reddit) contamination" is a data-quality sweep — the
  // first draft's bare /reddit/ filed it under Marketing.
  assert.equal(
    classifyProject(
      'Audience-buzz title-collision sweep (revival/year cross-production Reddit contamination)'
    ),
    'Scoring quality'
  );
  // Real distribution work still lands there.
  assert.equal(classifyProject('Post Schmigadoon! opening on Reddit'), 'Marketing/distribution');
  assert.equal(
    classifyProject('r/offbroadway: dedicated Off-Broadway launch post'),
    'Marketing/distribution'
  );
});

test('user-facing site work gets its own stream, not the Infrastructure catch-all', () => {
  assert.equal(
    classifyProject('Show hero (redesign): tier label wraps mid-word at 360-414px'),
    'Site & product'
  );
  assert.equal(
    classifyProject('Breadcrumb href routes concerts/operas to a genre browse page'),
    'Site & product'
  );
  // CLEAR_BREADCRUMBS is a scoring-flag audit constant, not site navigation.
  assert.notEqual(
    classifyProject('CI gate: catch missing CLEAR_BREADCRUMBS entries for force:true clears'),
    'Site & product'
  );
});

test('push-with-retry cards are production bugs, not fleet self-reference', () => {
  // The migration retires the dispatcher, not git. Both of these are real
  // data-loss bugs where a push reported success and nothing reached origin.
  assert.equal(classifyNoise('push-with-retry exit-0 false success recurred 2026-08-03'), null);
  assert.equal(
    classifyNoise('P0: merge-worktree-to-main.sh printed "→ pushed" but nothing reached origin'),
    null
  );
  // Genuine fleet cards still match.
  assert.equal(
    classifyNoise('Session-system v2 subtraction V1: queue-first migration'),
    'fleet_selfref'
  );
});
