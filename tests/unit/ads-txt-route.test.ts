/**
 * /ads.txt route (BRO-5893, sprint-plan-adsense.md A-T1). Calls the real
 * route handler (CLAUDE.md §15).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { GET, dynamic } from '../../src/app/ads.txt/route';

test('ads.txt serves exactly the one Google line as static text/plain', async () => {
  const res = await GET();
  assert.equal(res.headers.get('content-type'), 'text/plain; charset=utf-8');
  assert.equal(await res.text(), 'google.com, pub-5443308376628971, DIRECT, f08c47fec0942fa0\n');
  assert.equal(dynamic, 'force-static');
});
