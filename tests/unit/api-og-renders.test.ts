/**
 * /api/og must return a real image for every type it serves. Satori throws
 * mid-stream on some layout mistakes (e.g. two text nodes in one <div>), and
 * the route then answers 200 with an EMPTY body — every shared-list preview
 * was blank in production that way until 2026-10-02 (BRO-4481). A status
 * check can't see it; the body size can.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { NextRequest } from 'next/server';

// tsconfig's "jsx": "preserve" leaves tsx on the classic transform, so the
// route's JSX compiles to React.createElement with no React import in scope.
(globalThis as { React?: typeof React }).React = React;
const routeP = import('../../src/app/api/og/route');
const badgeP = import('../../src/app/api/newsletter-badge/route');

const CASES: Record<string, string> = {
  list: 'type=list&title=My%20List&count=5&creator=Tom&ranked=1',
  'list without creator': 'type=list&title=My%20List&count=1&creator=&ranked=0',
  show: 'type=show&title=Wicked&score=80&reviews=40&theater=Gershwin',
  browse: 'type=browse&title=Best%20Musicals&subtitle=Top%20rated',
  home: 'type=home',
  default: 'type=unknown',
};

for (const [name, qs] of Object.entries(CASES)) {
  test(`/api/og ${name} renders a non-empty PNG`, async () => {
    const { GET } = await routeP;
    const res = await GET(new NextRequest(`https://broadwayscorecard.com/api/og?${qs}`));
    assert.equal(res.status, 200);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.ok(body.length > 1000, `${name}: body is ${body.length} bytes`);
    // PNG signature
    assert.deepEqual(Array.from(body.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
  });
}

// The newsletter score/rank badge is the other @vercel/og route with no
// network dependency; same empty-200 failure mode.
for (const [name, qs] of Object.entries({ 'badge score': 'score=82', 'badge rank': 'kind=rank&tier=gold&pos=3' })) {
  test(`/api/newsletter-badge ${name} renders a non-empty PNG`, async () => {
    const { GET } = await badgeP;
    const res = await GET(new NextRequest(`https://broadwayscorecard.com/api/newsletter-badge?${qs}`));
    assert.equal(res.status, 200);
    const body = new Uint8Array(await res.arrayBuffer());
    assert.ok(body.length > 200, `${name}: body is ${body.length} bytes`);
    assert.deepEqual(Array.from(body.slice(0, 4)), [0x89, 0x50, 0x4e, 0x47]);
  });
}
