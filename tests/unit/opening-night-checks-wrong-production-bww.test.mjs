import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const check = require('../../scripts/lib/opening-night-checks/wrong-production-bww.check.js');
const fixture = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../fixtures/opening-night/bww-wrong-production.json'),
  'utf8'
));

function makeContext(reviews) {
  return {
    reviewsDoc: { [fixture.show.id]: reviews },
    reviewTextsRoot: '/tmp',
    driftState: {},
    criticConsensusDoc: {},
    now: new Date(),
  };
}

describe('wrong-production-bww check', () => {
  it('matching date URL — ok', () => {
    const c = fixture.cases.find(c => c.label.startsWith('matching date'));
    const result = check.run(fixture.show, makeContext([c.review]));
    assert.equal(result.ok, true, result.message);
    assert.equal(result.severity, 'ok');
  });

  it('45d off, not flagged — error', () => {
    const c = fixture.cases.find(c => c.label.startsWith('45d off, not flagged'));
    const result = check.run(fixture.show, makeContext([c.review]));
    assert.equal(result.ok, false, 'should have flagged this as wrong production');
    assert.equal(result.severity, 'error');
    assert.match(result.message, /BWW review URL dated/);
  });

  it('45d off, already flagged wrongProduction — ok', () => {
    const c = fixture.cases.find(c => c.label.startsWith('45d off, already flagged'));
    const result = check.run(fixture.show, makeContext([c.review]));
    assert.equal(result.ok, true, result.message);
  });

  it('no date in URL — ok (cannot determine)', () => {
    const c = fixture.cases.find(c => c.label.startsWith('no date in URL'));
    const result = check.run(fixture.show, makeContext([c.review]));
    assert.equal(result.ok, true, result.message);
  });
});
