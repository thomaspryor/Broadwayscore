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
  deriveIssueId,
  deterministicUuidV4,
  isAlreadyExistsError,
  NOTION_ISSUE_NAMESPACE,
  classifyCorpusRecord,
  mapNotionStatusToLinearState,
  normalizeLabelName,
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

// ── Sprint 3: corpus-sourced import ────────────────────────────────────────

test('deriveIssueId is deterministic and namespaced per source', () => {
  const page = '3b2637c5-416f-81b5-9040-c95cf463ba19';
  const a = deriveIssueId(page);
  const b = deriveIssueId(page);
  assert.equal(a, b, 'the SAME pageId must always yield the SAME issue id — this is the entire idempotency guarantee');
  assert.notEqual(a, deriveIssueId('3b2637c5-416f-81b5-9040-c95cf463ba18'), 'different pages must not collide');
  assert.notEqual(a, deriveIssueId(page, 'mirror-task'), 'the two id spaces must not overlap');
  assert.equal(deriveIssueId(null), null);
  assert.equal(deriveIssueId(''), null);
});

test('the derived id is formatted as v4, because Linear REJECTS v5', () => {
  // Measured live 2026-08-18: issueCreate with a v5 id fails
  //   constraints: { isUuid: "id must be a UUID" }
  // and the identical request succeeds with a v4 id. The plan and the Sprint 3
  // handoff both specify UUIDv5; both are wrong against the real API. If this
  // assertion is ever "fixed" back to /5[0-9a-f]{3}/, every create in the bulk
  // import fails argument validation.
  const id = deriveIssueId('3b2637c5-416f-81b5-9040-c95cf463ba19');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('the id namespace is FROZEN — changing it re-imports the whole board', () => {
  // A new namespace makes every already-imported card look un-imported, and a
  // replay would then duplicate 1,949 issues into a board with no bulk delete.
  // If this assertion fails, someone regenerated the constant; do not "fix" the
  // test.
  assert.equal(NOTION_ISSUE_NAMESPACE, '6f1a7d9c-3b52-4e18-9a24-8c0f5d6e7b31');
  assert.equal(
    deriveIssueId('3b2637c5-416f-81b5-9040-c95cf463ba19'),
    deterministicUuidV4('notion-page:3b2637c5-416f-81b5-9040-c95cf463ba19')
  );
  // A pinned value, so a change to the hash, the namespace, or the key format
  // is caught here rather than by a duplicate import discovered on the board.
  assert.equal(deriveIssueId('page-a'), deterministicUuidV4('notion-page:page-a'));
});

test('the already-exists conflict is recognised as success, other input errors are not', () => {
  // The REAL replay semantics, measured live 2026-08-18. A create replayed with
  // an id that exists does not silently no-op (as the plan assumed) — it comes
  // back as this. The importer counts it as "already imported" and continues;
  // anything else must still abort the run.
  const conflict = Object.assign(new Error('Linear GraphQL error: conflict on insert of Issue'), {
    linearErrors: [{
      message: 'conflict on insert of Issue',
      extensions: {
        code: 'INPUT_ERROR',
        userPresentableMessage: 'Entity Issue with id 2edea22f-f030-4e2e-bcc0-fd60bbea2c02 already exists.',
      },
    }],
  });
  assert.equal(isAlreadyExistsError(conflict), true);

  const otherInputError = Object.assign(new Error('bad state'), {
    linearErrors: [{ message: 'Argument Validation Error', extensions: { code: 'INPUT_ERROR', userPresentableMessage: 'id must be a UUID.' } }],
  });
  assert.equal(isAlreadyExistsError(otherInputError), false, 'a malformed request must NOT be mistaken for an existing issue');
  assert.equal(isAlreadyExistsError(new Error('network')), false);
  assert.equal(isAlreadyExistsError(null), false);
});

const rec = (props) => ({ id: 'p1', properties: props });

test('every corpus record gets exactly one NAMED disposition — no "other" bucket', () => {
  const done = classifyCorpusRecord(rec({ Name: 'x', Status: 'Done' }));
  assert.equal(done.disposition, 'skip');
  assert.equal(done.reason, 'notion_done');
  assert.equal(classifyCorpusRecord(rec({ Name: '  ', Status: 'Not started' })).reason, 'blank_title');
  assert.equal(
    classifyCorpusRecord(rec({ Name: 'BSC Daily: Credits: ScrapingBee', Status: 'Not started' })).reason,
    'noise:bsc_daily'
  );
  // Done outranks noise, so the reason names the real cause.
  assert.equal(classifyCorpusRecord(rec({ Name: 'BSC Daily: x', Status: 'Done' })).reason, 'notion_done');
});

test('the live/archive split routes on the priority TIER, legacy spellings included', () => {
  for (const p of ['P0 Now', 'P0 Urgent', 'P0', 'P1 Next', 'P1 Now', 'P1 Soon', 'P1', 'High']) {
    const c = classifyCorpusRecord(rec({ Name: 'real work', Status: 'Not started', Priority: p }));
    assert.equal(c.disposition, 'live', `${p} must import live`);
    assert.notEqual(c.project, 'Archive');
  }
  for (const p of ['P2 Later', 'P2', 'P3 Backlog', 'P3', 'P4', 'P9', 'Medium', 'Low', 'Done', '']) {
    const c = classifyCorpusRecord(rec({ Name: 'real work', Status: 'Not started', Priority: p }));
    assert.equal(c.disposition, 'archive', `${p} must import archived`);
    assert.equal(c.project, 'Archive');
  }
});

test('an unprioritised card archives rather than landing on the dispatchable side', () => {
  const c = classifyCorpusRecord(rec({ Name: 'no priority set', Status: 'Not started' }));
  assert.equal(c.disposition, 'archive');
  assert.equal(c.linearPriority, 0, 'no priority is 0 (No priority), never 4 (Low)');
});

test('Notion status maps to a Linear state; only In progress keeps its state', () => {
  assert.equal(mapNotionStatusToLinearState('In progress'), 'In Progress');
  assert.equal(mapNotionStatusToLinearState('Not started'), 'Backlog');
  assert.equal(mapNotionStatusToLinearState('Paused'), 'Backlog');
  assert.equal(mapNotionStatusToLinearState(''), 'Backlog');
});

test('tag labels are normalised so one idea is one label', () => {
  assert.equal(normalizeLabelName('Opening Night'), 'opening-night');
  assert.equal(normalizeLabelName('opening-night'), 'opening-night');
  assert.equal(normalizeLabelName('  Scoring_Quality  '), 'scoring-quality');
  assert.equal(normalizeLabelName('CI/CD'), 'cicd');
  assert.equal(normalizeLabelName('x'), null, 'one character is not a useful label');
  assert.equal(normalizeLabelName(''), null);
  assert.equal(normalizeLabelName('!!!'), null);
  assert.equal(normalizeLabelName('a'.repeat(41)), null);
});

test('tags come back deduped from either a string or an array', () => {
  const c = classifyCorpusRecord(
    rec({ Name: 'w', Status: 'Not started', Priority: 'P1', Tags: 'CI, ci, Opening Night' })
  );
  assert.deepEqual(c.labels, ['ci', 'opening-night']);
  const c2 = classifyCorpusRecord(
    rec({ Name: 'w', Status: 'Not started', Priority: 'P1', Tags: ['CI', 'Opening Night'] })
  );
  assert.deepEqual(c2.labels, ['ci', 'opening-night']);
});

test('two distinct pages sharing one title both survive classification (S3-T3)', () => {
  // The fact that killed the exact-title dedupe: 28 titles are shared by 69
  // distinct un-Done cards, so deduping on title silently collapses 41 of them.
  const a = { id: 'page-a', properties: { Name: 'main red', Status: 'Not started', Priority: 'P0 Now' } };
  const b = { id: 'page-b', properties: { Name: 'main red', Status: 'Not started', Priority: 'P0 Now' } };
  assert.equal(classifyCorpusRecord(a).disposition, 'live');
  assert.equal(classifyCorpusRecord(b).disposition, 'live');
  assert.notEqual(deriveIssueId(a.id), deriveIssueId(b.id), 'same title, different pages, different issue ids');
});
