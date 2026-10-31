// BRO-5151: ratchet on scripts/audit-workflow-secret-gaps.js. Every gap is a
// workflow step running a script that reads a secret the step never gets, so
// the read silently no-ops (BRO-67 class). The budget only goes down: when a
// batch wires more steps (scripts/wire-workflow-secret-gaps.js), lower it to
// the new count. Card target: under 100. The remaining gaps sit mostly in
// opening-night/press-night/lane workflows (frozen when this landed) and in
// land.yml / test.yml / vercel-deploy.yml.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { findGaps } = require(path.join(ROOT, 'scripts', 'audit-workflow-secret-gaps.js'));

const GAP_BUDGET = 162;

test(`workflow secret gaps stay within budget (${GAP_BUDGET})`, () => {
  const gaps = findGaps(path.join(ROOT, '.github', 'workflows'));
  const list = gaps.map((g) => `${g.workflow} :: ${g.step} reads ${g.secret}`).join('\n');
  assert.ok(
    gaps.length <= GAP_BUDGET,
    `${gaps.length} gaps > budget ${GAP_BUDGET}. Wire the new ones (node scripts/wire-workflow-secret-gaps.js --secrets=NAME), ` +
      `or mark a degradable lib read with // secret-optional: NAME <reason>.\n${list}`,
  );
});
