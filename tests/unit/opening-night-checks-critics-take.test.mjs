import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const check = require('../../scripts/lib/opening-night-checks/critics-take-present.check.js');

function makeContext(criticConsensusDoc = {}) {
  return { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc, now: new Date() };
}

describe('critics-take-present check', () => {
  it('compositeScore exists + criticConsensusDoc has summary → ok', () => {
    const show = { id: 'test-2026', compositeScore: 82 };
    const context = makeContext({ 'test-2026': { summary: 'Critics loved it.' } });
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });

  it('compositeScore exists + show missing from criticConsensusDoc → warning', () => {
    const show = { id: 'test-2026', compositeScore: 82 };
    const context = makeContext({});
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
    assert.match(result.message, /Critics Take is missing/);
    assert.match(result.message, /generate-critic-consensus/);
  });

  it('compositeScore exists + summary is empty string → warning', () => {
    const show = { id: 'test-2026', compositeScore: 82 };
    const context = makeContext({ 'test-2026': { summary: '' } });
    const result = check.run(show, context);
    assert.equal(result.ok, false);
    assert.equal(result.severity, 'warning');
  });

  it('compositeScore is null → ok (not yet scoreable)', () => {
    const show = { id: 'test-2026', compositeScore: null };
    const context = makeContext({});
    const result = check.run(show, context);
    assert.equal(result.ok, true);
    assert.equal(result.severity, 'ok');
  });
});
