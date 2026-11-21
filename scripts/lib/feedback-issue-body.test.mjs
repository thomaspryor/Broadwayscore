import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { buildPublicDiagnosisPayload, buildBugDiagnosisBody } = require('./feedback-issue-body.js');
const { loadIssueDiagnosis, emptyStore } = require('./feedback-submitter-store.js');

// auto-fix-feedback-bug.js gates on diagnosis.ambiguousShow/resolvedShowIds
// AFTER a full GitHub-issue round trip (write body -> read body back), not on
// the in-memory diagnoseBug() object. If buildPublicDiagnosisPayload or the
// redact/scrub helpers it calls ever drop these fields, that gate silently
// stops firing (BRO-4659 P1 fix) with no test failure elsewhere to catch it.
test('ambiguousShow and resolvedShowIds survive the issue-body round trip', () => {
  const diagnosis = {
    summary: 'Score looks wrong',
    whatsHappening: 'The reader may mean a different production of this title.',
    findings: ['Matched 3 productions of the same title'],
    proposedFix: 'No fix needed — ambiguous show, needs human review',
    fixType: 'data',
    confidence: 'high',
    relevantFiles: [],
    resolvedShowIds: ['book-of-mormon-2011', 'book-of-mormon-we-2024', 'book-of-mormon-tour-2022'],
    ambiguousShow: true,
  };
  const submission = { show: 'Book of mormon', email: 'reader@example.com', name: 'A Reader' };
  const showIds = diagnosis.resolvedShowIds;
  const payload = buildPublicDiagnosisPayload({ diagnosis, submission, resolvedShow: null, showIds });

  assert.equal(payload.ambiguousShow, true);
  assert.deepEqual(payload.resolvedShowIds, showIds);

  const body = buildBugDiagnosisBody({
    item: { summary: diagnosis.summary, priority: 'High' },
    submission,
    diagnosis,
    payload,
    showIds,
    reader: { name: submission.name, email: submission.email, show: submission.show },
  });

  const parsed = loadIssueDiagnosis(body, { store: emptyStore() });
  assert.equal(parsed.ambiguousShow, true, 'ambiguousShow must survive the issue-body round trip');
  assert.deepEqual(new Set(parsed.resolvedShowIds), new Set(showIds));
});

test('ambiguousShow is absent (not falsy-but-present) for a normal single-show diagnosis', () => {
  const diagnosis = {
    summary: 'Normal bug',
    whatsHappening: 'x',
    findings: [],
    proposedFix: 'y',
    fixType: 'data',
    confidence: 'high',
    relevantFiles: [],
    resolvedShowIds: ['hamilton-2015'],
    ambiguousShow: false,
  };
  const submission = { show: 'Hamilton' };
  const showIds = diagnosis.resolvedShowIds;
  const payload = buildPublicDiagnosisPayload({ diagnosis, submission, resolvedShow: { id: 'hamilton-2015', slug: 'hamilton' }, showIds });
  const body = buildBugDiagnosisBody({
    item: { summary: diagnosis.summary, priority: 'Medium' },
    submission,
    diagnosis,
    payload,
    showIds,
    reader: { show: submission.show },
  });
  const parsed = loadIssueDiagnosis(body, { store: emptyStore() });
  assert.equal(parsed.ambiguousShow, false);
});

// BRO-7919: a request for a show already in the catalog is closed, not parked.
import { createRequire as __cr } from 'module';
import { test as __t } from 'node:test';
import __assert from 'node:assert/strict';
const __req = __cr(import.meta.url);
const __body = __req('./feedback-issue-body.js');
const __route = __req('./content-request-routing.js');

__t('already-in-catalog ask (real router output) is closed; missing show is not', () => {
  const shows = [{ id: 'hamilton-2015', title: 'Hamilton', venue: 'Richard Rodgers Theatre', openingDate: '2015-08-06', status: 'open', market: 'broadway' }];
  const live = __route.planContentRequestActions({ message: 'Love this site, thoughts on Hamilton?', show: 'Hamilton', shows });
  __assert.equal(__body.isAlreadyInCatalog(live), true, JSON.stringify(live));
  __assert.match(__body.buildAlreadyInCatalogComment(live), /show\/hamilton-2015/);
  const missing = __route.planContentRequestActions({ message: 'Please add "Some New Play"', show: 'Some New Play', shows });
  __assert.equal(__body.isAlreadyInCatalog(missing), false);
  for (const m of ['The cast list for Hamilton is out of date', 'Please add the audience score for Hamilton', 'Add the West End production of Hamilton', 'Hamilton closing date is wrong']) {
    __assert.equal(__body.isAlreadyInCatalog(__route.planContentRequestActions({ message: m, show: 'Hamilton', shows })), false, m);
  }
  __assert.equal(__body.isAlreadyInCatalog([]), false);
  __assert.equal(__body.isAlreadyInCatalog([{ kind: 'unroutable', reason: 'ambiguous' }]), false);
});
