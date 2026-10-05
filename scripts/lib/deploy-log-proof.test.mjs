import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { prodAliasFromLog } = require('./deploy-log-proof.js');

// Lines from deploy run 37264715388's deploy job (2026-10-05), ANSI codes kept.
const SOURCE_ECHO = '2026-10-05T04:48:22.1697672Z \x1b[36;1mecho "Deployed to production: $URL"\x1b[0m';
const PROGRESS = '2026-10-05T04:50:00.1324075Z \x1b[2K\x1b[1A\x1b[2K\x1b[GProduction: https://broadwayscore-e4den4ngc-thomaspryors-projects.vercel.app [2m]';
const ALIASED = '2026-10-05T04:50:00.1325664Z Aliased: https://showscorecard.com [2m]';
const DEPLOYED = '2026-10-05T04:50:00.7616236Z Deployed to production: https://broadwayscore-e4den4ngc-thomaspryors-projects.vercel.app';

test('a real deploy log proves the production alias', () => {
  assert.deepEqual(prodAliasFromLog([SOURCE_ECHO, PROGRESS, ALIASED, DEPLOYED].join('\n')), {
    url: 'broadwayscore-e4den4ngc-thomaspryors-projects.vercel.app',
    aliasedAtMs: Date.parse('2026-10-05T04:50:00.1325664Z'),
  });
});

test('the echoed workflow source alone is not proof ($URL, not a URL)', () => {
  assert.equal(prodAliasFromLog([SOURCE_ECHO, PROGRESS].join('\n')), null);
});

test('both lines are required: alias without the exit-0 echo, or the echo without an alias', () => {
  assert.equal(prodAliasFromLog([SOURCE_ECHO, PROGRESS, ALIASED].join('\n')), null, 'deploy command did not finish cleanly');
  assert.equal(prodAliasFromLog([SOURCE_ECHO, PROGRESS, DEPLOYED].join('\n')), null, 'never aliased (e.g. Vercel cancelled it)');
});

test('empty or missing log is not proof', () => {
  assert.equal(prodAliasFromLog(''), null);
  assert.equal(prodAliasFromLog(undefined), null);
});
