// BRO-219 — Structural #2: opening night is not truly automated.
//
// These 4 checks (plus the 6 covered in opening-night-checks-juan-a-ramirez-
// bypass.test.mjs and opening-night-checks-metadata-completeness.test.mjs)
// used to detect a real problem and then stop: no details.remediation, so
// nothing but a checklist exit code told the owner. That is the exact pattern
// the issue describes ("CI runs + human-in-the-loop when it breaks") — the
// owner was the dispatcher. Each now self-declares a remediation per the
// task #389 contract (opening-night-remediation.js collectRemediations()):
// kind:'workflow' when a safe, idempotent fix already exists (aggregator-
// count-drift → re-run gather-reviews.yml, exactly what its own message
// already recommended); kind:'alert' everywhere a heuristic auto-fix would
// risk making the corpus worse (schema drift, syndication orphans, and
// anticipatory-post dating all need a human to pick the right fix).

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const aggregatorCountDrift = require('../../scripts/lib/opening-night-checks/aggregator-count-drift.check.js');
const assignedScoreSchema = require('../../scripts/lib/opening-night-checks/assigned-score-schema.check.js');
const orphanScoreSource = require('../../scripts/lib/opening-night-checks/orphan-scoresource.check.js');
const publishDatePreOpening = require('../../scripts/lib/opening-night-checks/publish-date-pre-opening.check.js');

function makeContext(overrides = {}) {
  return {
    reviewsDoc: {},
    reviewTextsRoot: '/tmp/does-not-exist',
    driftState: {},
    criticConsensusDoc: {},
    now: new Date(),
    shows: [],
    ...overrides,
  };
}

describe('assigned-score-schema check', () => {
  it('non-numeric assignedScore → error, self-declares alert remediation', () => {
    const show = { id: 'test-2026' };
    const context = makeContext({
      reviewsDoc: {
        [show.id]: [{ outletId: 'ny-post', criticName: 'Test Critic', assignedScore: '2/4', url: 'https://example.com/r' }],
      },
    });
    const result = assignedScoreSchema.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'error');
    const remediation = result.details.remediation;
    assert.equal(remediation.kind, 'alert');
    assert.equal(remediation.key, `assigned-score-schema:${show.id}`);
    assert.equal(remediation.conditionKey, `opening-night-assigned-score-schema-${show.id}`);
    assert.equal(remediation.description, result.message);
    assert.equal(remediation.severity, 'error');
  });

  it('numeric assignedScore → ok, no remediation', () => {
    const show = { id: 'test-2026' };
    const context = makeContext({
      reviewsDoc: { [show.id]: [{ outletId: 'ny-post', criticName: 'Test Critic', assignedScore: 80, url: 'https://example.com/r' }] },
    });
    const result = assignedScoreSchema.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.details, undefined);
  });
});

describe('orphan-scoresource check', () => {
  it('scorable review with scoreSource=null → warning, self-declares alert remediation', () => {
    const show = { id: 'test-2026' };
    const context = makeContext({
      reviewsDoc: {
        [show.id]: [{ outletId: 'ny-daily-news', criticName: 'Chris Jones', assignedScore: 80, scoreSource: null, url: 'https://example.com/r' }],
      },
    });
    const result = orphanScoreSource.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    const remediation = result.details.remediation;
    assert.equal(remediation.kind, 'alert');
    assert.equal(remediation.key, `orphan-scoresource:${show.id}`);
    assert.equal(remediation.conditionKey, `opening-night-orphan-scoresource-${show.id}`);
    assert.equal(remediation.description, result.message);
  });

  it('review with a real scoreSource → ok, no remediation', () => {
    const show = { id: 'test-2026' };
    const context = makeContext({
      reviewsDoc: { [show.id]: [{ outletId: 'ny-daily-news', criticName: 'Chris Jones', assignedScore: 80, scoreSource: 'llm_ensemble' }] },
    });
    const result = orphanScoreSource.run(show, context);
    assert.equal(result.ok, true);
  });
});

describe('publish-date-pre-opening check', () => {
  let tmpRoot;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ont-publish-date-'));
  });

  after(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('review published 16 days before opening → error, self-declares alert remediation', () => {
    const show = { id: 'test-2026', openingDate: '2026-04-15' };
    const context = makeContext({
      reviewTextsRoot: tmpRoot,
      reviewsDoc: {
        [show.id]: [{
          outletId: 'frontmezzjunkies', criticName: 'Test Critic',
          url: 'https://example.com/anticipatory', publishDate: '2026-03-30',
        }],
      },
    });
    const result = publishDatePreOpening.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'error');
    const remediation = result.details.remediation;
    assert.equal(remediation.kind, 'alert');
    assert.equal(remediation.key, `publish-date-pre-opening:${show.id}`);
    assert.equal(remediation.conditionKey, `opening-night-publish-date-pre-opening-${show.id}`);
    assert.equal(remediation.description, result.message);
  });

  it('shipped review missing publishDate → warning, self-declares alert remediation', () => {
    const show = { id: 'test-2026-b', openingDate: '2026-04-15' };
    const context = makeContext({
      reviewTextsRoot: tmpRoot,
      reviewsDoc: {
        [show.id]: [{ outletId: 'some-outlet', criticName: 'Test Critic', url: 'https://example.com/no-date' }],
      },
    });
    const result = publishDatePreOpening.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    const remediation = result.details.remediation;
    assert.equal(remediation.kind, 'alert');
    assert.equal(remediation.key, `publish-date-pre-opening-missing:${show.id}`);
    assert.equal(remediation.description, result.message);
  });

  it('review published within grace window → ok, no remediation', () => {
    const show = { id: 'test-2026-c', openingDate: '2026-04-15' };
    const context = makeContext({
      reviewTextsRoot: tmpRoot,
      reviewsDoc: {
        [show.id]: [{ outletId: 'ny-times', criticName: 'Test Critic', url: 'https://example.com/on-time', publishDate: '2026-04-15' }],
      },
    });
    const result = publishDatePreOpening.run(show, context);
    assert.equal(result.ok, true);
  });
});

describe('aggregator-count-drift check', () => {
  // The check reads data/audit/exclusions-YYYY-MM-DD.jsonl at a fixed path
  // relative to its own file (not injectable), so this writes into the real
  // repo audit dir using a far-future date no real run will ever produce,
  // and removes it in `after`.
  const FIXTURE_DATE = new Date('2099-01-01T00:00:00.000Z');
  const auditDir = path.join(__dirname, '..', '..', 'data', 'audit');
  const fixturePath = path.join(auditDir, `exclusions-${FIXTURE_DATE.toISOString().slice(0, 10)}.jsonl`);
  const show = { id: 'bro-219-fixture-show-2099' };

  before(() => {
    fs.mkdirSync(auditDir, { recursive: true });
    const record = {
      showId: show.id,
      reason: 'countDrift',
      ts: FIXTURE_DATE.toISOString(),
      details: { aggregator: 'bww-rr', delta: 6, extracted: 13, anchorUrls: 19 },
    };
    fs.writeFileSync(fixturePath, JSON.stringify(record) + '\n');
  });

  after(() => {
    fs.rmSync(fixturePath, { force: true });
  });

  it('count-drift delta over the error threshold → error, self-declares workflow remediation', () => {
    const context = makeContext({ now: FIXTURE_DATE });
    const result = aggregatorCountDrift.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'error');
    const remediation = result.details.remediation;
    assert.equal(remediation.kind, 'workflow');
    assert.equal(remediation.key, `aggregator-count-drift:${show.id}`);
    assert.equal(remediation.workflow, 'gather-reviews.yml');
    assert.deepEqual(remediation.inputs, { shows: show.id, opening_night: true });

    // Cross-check against the workflow's ACTUAL declared inputs — a typo'd
    // or renamed input name here makes GitHub's API reject the dispatch
    // outright (422 "Unexpected inputs provided"), which is silent from the
    // checklist's point of view (dispatchWorkflow just logs 'failed').
    const yaml = require('yaml');
    const workflowPath = path.join(__dirname, '..', '..', '.github', 'workflows', remediation.workflow);
    const workflowDoc = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));
    const declaredInputs = new Set(Object.keys(workflowDoc.on.workflow_dispatch.inputs || {}));
    for (const key of Object.keys(remediation.inputs)) {
      assert.ok(declaredInputs.has(key), `${remediation.workflow} has no workflow_dispatch input named '${key}' (declared: ${[...declaredInputs].join(', ')})`);
    }
  });

  it('no exclusion records for the show → ok, no remediation', () => {
    const context = makeContext({ now: FIXTURE_DATE });
    const result = aggregatorCountDrift.run({ id: 'no-drift-show-2099' }, context);
    assert.equal(result.ok, true);
  });
});
