// BRO-6397: four scheduled workflows must route alerts through routeAlert
// (via scripts/route-workflow-alerts.js), never `gh issue create`.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = ['lighthouse-post-deploy', 'opening-night-stage-alert', 'update-tony-awards', 'rotate-gitlab-token'];

for (const name of WORKFLOWS) {
  test(`${name}.yml routes alerts through routeAlert`, () => {
    const src = fs.readFileSync(path.join(root, '.github/workflows', `${name}.yml`), 'utf8');
    assert.ok(!/gh issue create/.test(src), 'still files gh issues');
    assert.ok(/route-workflow-alerts\.js|routeAlert/.test(src), 'does not call the route script');
    assert.ok(/LINEAR_API_KEY/.test(src), 'missing LINEAR_API_KEY');
    assert.ok(/contents:\s*write/.test(src), 'persist step needs contents: write');
    assert.ok(/alert-ledger\.json/.test(src), 'missing ledger persist');
  });
}
