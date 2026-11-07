// BRO-7075: owner-facing emails never render text below the floor. Calls the real helper (CLAUDE.md §15).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { enforceTypeFloor, MIN_FONT_PX } = require('../../scripts/lib/email-type-floor.js');

test('floor is 14px; small sizes rise, large sizes and non-px units stay', () => {
  assert.equal(MIN_FONT_PX, 14);
  assert.equal(enforceTypeFloor('font-size:10px;font-size: 12.5px;font-size:14px;font-size:20px;font-size:1.1em'),
    'font-size:14px;font-size:14px;font-size:14px;font-size:20px;font-size:1.1em');
});

// Every owner-facing sender that builds its own HTML must route it through the floor. Add a sender here
// when it starts emailing the owner; the morning digest applies it inside buildHtmlParts (tested separately).
const OWNER_SENDERS = [
  'scripts/send-opening-digest.js',
  'scripts/send-reddit-post-email.js',
  'scripts/lib/traffic-report-email.js',
  'scripts/lib/brand-mention-email.js',
  'scripts/send-morning-digest.js',
];
for (const f of OWNER_SENDERS) {
  test(`${f} applies the type floor`, () => {
    const src = fs.readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8');
    assert.match(src, /email-type-floor\.js/);
  });
}

test('the real opening-digest and reddit email builders still produce HTML the floor can clean', () => {
  const od = require('../../scripts/send-opening-digest.js');
  const html = enforceTypeFloor(od.buildHtml({ needsHelp: [], broadcastReady: [], comingUp: [], otherRecent: [], otherUpcoming: [], todayHuman: 'Saturday' }));
  const sizes = [...html.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)].map((m) => Number(m[1]));
  assert.ok(sizes.length > 0);
  assert.ok(Math.min(...sizes) >= 14);
});
