// BRO-4607: land.yml's header must not claim test.yml lacks workflow_dispatch
// while test.yml declares one (the claim was false and misled fallback planning).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const wf = f => fs.readFileSync(path.join(import.meta.dirname, '..', '..', '.github', 'workflows', f), 'utf8');
const onBlock = src => src.split(/^jobs:/m)[0];

test('land.yml header agrees with test.yml about workflow_dispatch', () => {
  const testHasDispatch = /^\s{2}workflow_dispatch:/m.test(onBlock(wf('test.yml')));
  const header = wf('land.yml').split(/^on:/m)[0];
  const claimsNone = /test\.yml has no workflow_dispatch/i.test(header);
  assert.equal(claimsNone, !testHasDispatch,
    `land.yml header ${claimsNone ? 'says' : 'does not say'} test.yml has no workflow_dispatch, but test.yml ${testHasDispatch ? 'declares' : 'lacks'} one`);
});
