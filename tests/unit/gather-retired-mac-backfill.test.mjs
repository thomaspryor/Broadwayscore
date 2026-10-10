// BRO-4146: a Mac stuck on an old checkout keeps dispatching the retired
// backfill (no_sb_serp=true, no spend_purpose). gather-reviews.yml must skip
// those runs end to end, and still run the CI backfill (spend_purpose set).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml');
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const wf = yaml.load(readFileSync(join(root, '.github/workflows/gather-reviews.yml'), 'utf8'));
const MATCH = "github.event_name == 'workflow_dispatch' && inputs.no_sb_serp && inputs.spend_purpose == ''";

test('retired-mac-backfill job runs only for the retired signature', () => {
  assert.equal(wf.jobs['retired-mac-backfill'].if, `\${{ ${MATCH} }}`);
});

test('prepare is skipped for the retired signature, so every job after it skips', () => {
  assert.equal(wf.jobs.prepare.if, `\${{ !(${MATCH}) }}`);
  for (const [name, job] of Object.entries(wf.jobs)) {
    if (name === 'prepare' || name === 'retired-mac-backfill') continue;
    const needs = [].concat(job.needs || []);
    assert.ok(needs.length > 0, `${name} must depend on the pipeline`);
    const cond = String(job.if || '');
    // A job with always()/!cancelled() runs even when its needs skipped,
    // unless it also checks the needed job's result.
    if (/always\(\)|!cancelled\(\)/.test(cond)) {
      assert.match(cond, /needs\.(prepare\.result == 'success'|gather-reviews\.result != 'skipped')/, `${name} would run on a skipped Mac dispatch`);
    }
  }
});

test('the CI backfill tags its dispatch, so the guard never matches it', () => {
  const hb = readFileSync(join(root, '.github/workflows/historical-backfill.yml'), 'utf8');
  assert.match(hb, /-f spend_purpose=historical-backfill/);
});
