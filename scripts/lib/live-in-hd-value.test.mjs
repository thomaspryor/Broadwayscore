// BRO-6769: liveInHd data-edit value rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { liveInHdValueProblem } = createRequire(import.meta.url)('./feedback-pipeline-fields.js');
const ok = { date: '2026-10-03', sourceUrl: 'https://www.metopera.org/season/in-cinemas/cosi-fan-tutte/' };
test('accepts null and a metopera.org dated value', () => {
  assert.equal(liveInHdValueProblem(null), null);
  assert.equal(liveInHdValueProblem(ok), null);
  assert.equal(liveInHdValueProblem({ ...ok, encoreDate: '2026-10-14' }), null);
});
test('rejects guessed or unsourced values', () => {
  assert.match(liveInHdValueProblem({ ...ok, sourceUrl: 'https://operawire.com/x' }), /metopera\.org/);
  assert.match(liveInHdValueProblem({ ...ok, sourceUrl: 'https://evil.com/?metopera.org' }), /metopera\.org/);
  assert.match(liveInHdValueProblem({ date: '2026-13-40', sourceUrl: ok.sourceUrl }), /date/);
  assert.match(liveInHdValueProblem({ ...ok, encoreDate: '2026-10-01' }), /after/);
  assert.match(liveInHdValueProblem({ ...ok, extra: 1 }), /unknown/);
  assert.match(liveInHdValueProblem('2026-10-03'), /null or/);
});
