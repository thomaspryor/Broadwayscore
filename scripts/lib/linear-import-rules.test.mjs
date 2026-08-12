import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractNotionId,
  extractPriorityTag,
  mapPriorityToLinear,
  mapStatusToLinearState,
  classifyNoise,
  classifyProject,
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

test('mapPriorityToLinear: P0->Urgent(1), P1->High(2), P2->Medium(3), else->Low(4)', () => {
  assert.equal(mapPriorityToLinear('P0 Now'), 1);
  assert.equal(mapPriorityToLinear('P1 Next'), 2);
  assert.equal(mapPriorityToLinear('P2 Later'), 3);
  assert.equal(mapPriorityToLinear(null), 4);
  assert.equal(mapPriorityToLinear('garbage'), 4);
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
