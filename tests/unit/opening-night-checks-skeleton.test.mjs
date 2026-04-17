import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

// Path to the checks directory
const CHECKS_DIR = path.resolve(__dirname, '../../scripts/lib/opening-night-checks');

// Stub check files written to a temp dir during the test, then symlinked in
const STUB_A_PATH = path.join(CHECKS_DIR, '_stub-passes.check.js');
const STUB_B_PATH = path.join(CHECKS_DIR, '_stub-throws.check.js');

const STUB_A_CONTENT = `
'use strict';
module.exports = {
  name: 'stub-passes',
  description: 'Always returns ok',
  run(show, context) {
    return { ok: true, severity: 'ok', message: 'all good' };
  },
};
`;

const STUB_B_CONTENT = `
'use strict';
module.exports = {
  name: 'stub-throws',
  description: 'Always throws',
  run(show, context) {
    throw new Error('intentional failure');
  },
};
`;

describe('opening-night-checks skeleton', () => {
  before(() => {
    fs.writeFileSync(STUB_A_PATH, STUB_A_CONTENT);
    fs.writeFileSync(STUB_B_PATH, STUB_B_CONTENT);
  });

  after(() => {
    fs.rmSync(STUB_A_PATH, { force: true });
    fs.rmSync(STUB_B_PATH, { force: true });
    // Clear require cache so stubs don't bleed into other tests
    Object.keys(require.cache).forEach(k => {
      if (k.includes('opening-night-checks')) delete require.cache[k];
    });
  });

  it('runChecks returns results for both stub checks', () => {
    // Re-require after writing stubs to pick them up
    delete require.cache[require.resolve('../../scripts/lib/opening-night-checks/index.js')];
    const { runChecks } = require('../../scripts/lib/opening-night-checks/index.js');

    const show = { id: 'test-show-2026', title: 'Test Show', openingDate: '2026-04-16' };
    const context = { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };

    const { results, summary } = runChecks(show, context);

    assert.equal(results.length, 2, 'should have exactly 2 results (one per stub)');
  });

  it('passing stub has ok=true and severity=ok', () => {
    delete require.cache[require.resolve('../../scripts/lib/opening-night-checks/index.js')];
    const { runChecks } = require('../../scripts/lib/opening-night-checks/index.js');

    const show = { id: 'test-show-2026', title: 'Test Show' };
    const context = { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };

    const { results } = runChecks(show, context);
    const passing = results.find(r => r.name === 'stub-passes');

    assert.ok(passing, 'stub-passes result should exist');
    assert.equal(passing.ok, true);
    assert.equal(passing.severity, 'ok');
  });

  it('throwing stub is converted to error result without crashing runChecks', () => {
    delete require.cache[require.resolve('../../scripts/lib/opening-night-checks/index.js')];
    const { runChecks } = require('../../scripts/lib/opening-night-checks/index.js');

    const show = { id: 'test-show-2026', title: 'Test Show' };
    const context = { reviewsDoc: {}, reviewTextsRoot: '/tmp', driftState: {}, criticConsensusDoc: {}, now: new Date() };

    const { results, summary } = runChecks(show, context);
    const throwing = results.find(r => r.name === 'stub-throws');

    assert.ok(throwing, 'stub-throws result should exist');
    assert.equal(throwing.ok, false);
    assert.equal(throwing.severity, 'error');
    assert.match(throwing.message, /check threw/);
    assert.equal(summary.errors, 1);
    assert.equal(summary.ok, 1);
  });
});
