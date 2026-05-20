/**
 * Canary: Tony nominees compact row height guards.
 *
 * globals.css applies `a { min-height: 44px }` on mobile for touch targets.
 * PerformerRow and CraftRow have stacked block Links (person name + show title),
 * so each link inflates to 44px, making rows 100px+ instead of ~52-64px.
 *
 * The fix: CSS exception `.performer-row a, .craft-row a { min-height: auto }`
 * + class names on the row containers. This test ensures neither gets removed.
 *
 * History: this regression was introduced and fixed 5+ times. Do NOT remove
 * these assertions without understanding the min-height root cause.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');
const globalsCss = fs.readFileSync(path.join(ROOT, 'src/app/globals.css'), 'utf8');
const pageTsx = fs.readFileSync(path.join(ROOT, 'src/app/tony-awards/nominees/page.tsx'), 'utf8');

test('globals.css has min-height:44px touch-target rule on mobile anchors', () => {
  assert.ok(
    globalsCss.includes('min-height: 44px'),
    'Touch target rule missing — if removed, re-add and update the exceptions below'
  );
});

test('globals.css has min-height:auto exception for .performer-row a', () => {
  assert.ok(
    globalsCss.includes('.performer-row a'),
    'CSS exception for .performer-row a is missing from globals.css — PerformerRow links will be 44px tall on mobile, causing 100px+ rows'
  );
});

test('globals.css has min-height:auto exception for .craft-row a', () => {
  assert.ok(
    globalsCss.includes('.craft-row a'),
    'CSS exception for .craft-row a is missing from globals.css — CraftRow links will be 44px tall on mobile, causing 80px+ rows'
  );
});

test('nominees page.tsx PerformerRow has performer-row class', () => {
  // Find the PerformerRow function and check it uses the class
  const performerSection = pageTsx.slice(pageTsx.indexOf('function PerformerRow'));
  const firstDiv = performerSection.match(/<div className="([^"]+)"/)?.[1] ?? '';
  assert.ok(
    firstDiv.includes('performer-row'),
    `PerformerRow outer div must include "performer-row" class — found: "${firstDiv}". Without this, the min-height CSS exception won't apply and rows will be 100px+ on mobile.`
  );
});

test('nominees page.tsx CraftRow has craft-row class', () => {
  const craftSection = pageTsx.slice(pageTsx.indexOf('function CraftRow'));
  const firstDiv = craftSection.match(/<div className="([^"]+)"/)?.[1] ?? '';
  assert.ok(
    firstDiv.includes('craft-row'),
    `CraftRow outer div must include "craft-row" class — found: "${firstDiv}". Without this, the min-height CSS exception won't apply and rows will be 80px+ on mobile.`
  );
});
