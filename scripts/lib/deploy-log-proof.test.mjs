import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { prodAliasFromLog, listingLooksStale, DEPLOY_JOB, DEPLOY_ECHO, WAIT_CALL, READY, STALE_LISTING_MS } = require('./deploy-log-proof.js');

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

// Lines from deploy run 37409019319's deploy job (2026-10-06): `--prod --no-wait`
// plus vercel-wait-deployment.js, so the Vercel CLI prints no `Aliased:` (BRO-4778).
const HOST = 'broadwayscore-cfmkj99js-thomaspryors-projects.vercel.app';
const NOWAIT_PROGRESS = `2026-10-06T03:31:51.6271844Z Production: https://${HOST} [36s]`;
const NOWAIT_NOTE = '2026-10-06T03:31:51.6279350Z Note: Deployment is still processing...';
const NOWAIT_READY = `2026-10-06T03:32:56.7848862Z deployment ${HOST}: ready (state=READY, polls=7, exit=0)`;
const NOWAIT_DEPLOYED = `2026-10-06T03:32:56.7872723Z Deployed to production: https://${HOST}`;

test('a --no-wait deploy log is proven by the wait script\'s READY line', () => {
  assert.deepEqual(prodAliasFromLog([SOURCE_ECHO, NOWAIT_PROGRESS, NOWAIT_NOTE, NOWAIT_READY, NOWAIT_DEPLOYED].join('\n')), {
    url: HOST,
    aliasedAtMs: Date.parse('2026-10-06T03:32:56.7848862Z'),
  });
});

test('READY must be for the deployment that was echoed, and both lines are required', () => {
  const otherReady = '2026-10-06T03:30:00.0000000Z deployment broadwayscore-old-thomaspryors-projects.vercel.app: ready (state=READY, polls=3, exit=0)';
  assert.equal(prodAliasFromLog([otherReady, NOWAIT_DEPLOYED].join('\n')), null, 'a different attempt\'s READY');
  assert.equal(prodAliasFromLog([NOWAIT_PROGRESS, NOWAIT_READY].join('\n')), null, 'no exit-0 echo');
  assert.equal(prodAliasFromLog([NOWAIT_PROGRESS, NOWAIT_DEPLOYED].join('\n')), null, 'never seen READY');
  const canceled = `2026-10-06T03:32:00.0000000Z deployment ${HOST}: canceled (state=CANCELED, polls=4, exit=5)`;
  assert.equal(prodAliasFromLog([canceled, NOWAIT_DEPLOYED].join('\n')), null, 'superseded deploys are not live');
});

test('empty or missing log is not proof', () => {
  assert.equal(prodAliasFromLog(''), null);
  assert.equal(prodAliasFromLog(undefined), null);
});

test('listingLooksStale: a page whose newest run is over an hour old is stale', () => {
  const now = Date.parse('2026-10-05T05:00:00Z');
  assert.equal(listingLooksStale([{ created_at: '2026-10-05T04:44:38Z' }, { created_at: '2026-09-07T10:00:00Z' }], now), false);
  assert.equal(listingLooksStale([{ created_at: '2026-09-07T10:00:00Z' }], now), true, 'the 2026-10-05 stale page');
  assert.equal(listingLooksStale([{ created_at: new Date(now - STALE_LISTING_MS - 1).toISOString() }], now), true);
  assert.equal(listingLooksStale([], now), true);
  assert.equal(listingLooksStale(undefined, now), true);
});

test('vercel-deploy.yml still has the job and echo the parser relies on', () => {
  const y = readFileSync(new URL('../../.github/workflows/vercel-deploy.yml', import.meta.url), 'utf8');
  assert.ok(y.includes(DEPLOY_ECHO), `the deploy step must still run: ${DEPLOY_ECHO}`);
  const block = y.split(new RegExp(`\\n  ${DEPLOY_JOB}:\\n`))[1];
  assert.ok(block, `jobs.${DEPLOY_JOB} must exist`);
  const job = block.split(/\n  [A-Za-z_-]+:\n/)[0];
  assert.doesNotMatch(job, /^    name:/m, 'a name: override changes the job name the jobs API reports');
  assert.ok(job.includes(DEPLOY_ECHO), 'the echo must sit inside that job');
  assert.ok(job.includes(WAIT_CALL), `the deploy job must still wait with: ${WAIT_CALL}`);
});

test('vercel-wait-deployment.js still prints the READY line the parser reads', () => {
  const src = readFileSync(new URL('../vercel-wait-deployment.js', import.meta.url), 'utf8');
  const printed = 'console.log(`deployment ${id}: ${r.outcome} (state=${r.state}, polls=${r.polls}, exit=${code})`);';
  assert.ok(src.includes(printed), 'the wait script\'s result line changed: update READY in deploy-log-proof.js');
  assert.match(src, /const id = urlLine\.replace\(\/\^https\?:\\\/\\\/\/, ''\);/, 'id must stay the bare host the echoed URL carries');
  assert.match('deployment x.vercel.app: ready (state=READY, polls=1, exit=0)', READY);
});
