// BRO-7934 class guard: a scheduled workflow that looks like discovery must be registered for
// yield + fire-rate watching (DISCOVERY_WORKFLOWS) or explicitly excused (NOT_DISCOVERY).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { DISCOVERY_WORKFLOWS, NOT_DISCOVERY, DISCOVERY_NAME_RE, armIdForWorkflow } = require('./discovery-workflows.js');
const { ARMS_BY_ID } = require('./arm-registry.js');
const { extractCrons } = require('./cron-coverage.js');
const WF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.github', 'workflows');
const scheduled = fs.readdirSync(WF_DIR).filter((f) => f.endsWith('.yml') && extractCrons(fs.readFileSync(path.join(WF_DIR, f), 'utf8')).length > 0);

test('every scheduled workflow whose name looks like discovery is registered or excused', () => {
  const unclassified = scheduled.filter((f) => DISCOVERY_NAME_RE.test(f) && !DISCOVERY_WORKFLOWS.includes(f) && !(f in NOT_DISCOVERY));
  assert.deepEqual(unclassified, [], `add to DISCOVERY_WORKFLOWS (scripts/lib/discovery-workflows.js) or NOT_DISCOVERY with a reason: ${unclassified.join(', ')}`);
});

test('every discovery workflow exists, is scheduled, and has a yield arm', () => {
  for (const f of DISCOVERY_WORKFLOWS) {
    assert.ok(scheduled.includes(f), `${f} is not a scheduled workflow: remove it from DISCOVERY_WORKFLOWS`);
    assert.ok(ARMS_BY_ID.has(armIdForWorkflow(f)), `${f} has no arm in arm-registry`);
  }
  assert.equal(new Set(DISCOVERY_WORKFLOWS).size, DISCOVERY_WORKFLOWS.length, 'duplicate entries');
});

test('NOT_DISCOVERY has a reason on every entry, no overlap, no stale files', () => {
  for (const [f, why] of Object.entries(NOT_DISCOVERY)) {
    assert.ok(String(why).length > 3, `${f} needs a reason`);
    assert.ok(!DISCOVERY_WORKFLOWS.includes(f), `${f} is in both lists`);
    assert.ok(scheduled.includes(f), `${f} is not a scheduled workflow: drop it from NOT_DISCOVERY`);
  }
});

test('the registry covers more than the original 7 workflows, including the 4% completeness check', () => {
  assert.ok(DISCOVERY_WORKFLOWS.includes('opening-night-completeness-check.yml'));
  assert.ok(DISCOVERY_WORKFLOWS.includes('audit-reverse-discovery.yml'));
  assert.ok(DISCOVERY_WORKFLOWS.includes('enrich-reviews.yml'));
  assert.ok(DISCOVERY_WORKFLOWS.length >= 30);
});
