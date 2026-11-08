// BRO-7162 F01: an unknown-critic file must not veto a distinct URL from the same outlet before its byline is fetched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { decideBeforePrefetch, decideAfterPrefetch } = require('../../scripts/lib/discovery-slot-dedupe.js');
const norm = require('../../scripts/lib/review-normalization.js');

function showDirWith(files) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-'));
  for (const [f, data] of Object.entries(files)) fs.writeFileSync(path.join(d, f), JSON.stringify(data));
  return d;
}
const base = { canonicalOutletId: 'everything-theatre', criticName: null };

test('same URL already on disk is a duplicate (any filename)', () => {
  const d = showDirWith({ 'everything-theatre--jane-doe.json': { url: 'https://et.com/a/' } });
  assert.equal(decideBeforePrefetch(d, { ...base, url: 'https://ET.com/a' }, norm).reason, 'url-dupe');
});

test('unknown slot occupied by a DIFFERENT url does not veto: prefetch the byline', () => {
  const d = showDirWith({ 'everything-theatre--unknown.json': { url: 'https://et.com/a' } });
  const r = decideBeforePrefetch(d, { ...base, url: 'https://et.com/b' }, norm);
  assert.equal(r.action, 'prefetch-byline');
});

test('byline resolved to a free named slot proceeds', () => {
  const d = showDirWith({ 'everything-theatre--unknown.json': { url: 'https://et.com/a' } });
  assert.equal(decideAfterPrefetch(d, { ...base, url: 'https://et.com/b' }, 'Jane Doe', norm).action, 'proceed');
});

test('byline resolved to an occupied named slot is a duplicate', () => {
  const d = showDirWith({ 'everything-theatre--jane-doe.json': { url: 'https://et.com/a' } });
  assert.equal(decideAfterPrefetch(d, { ...base, url: 'https://et.com/b' }, 'Jane Doe', norm).reason, 'slot-dupe');
});

test('still unresolved with an occupied unknown slot is surfaced, not dropped silently', () => {
  const d = showDirWith({ 'everything-theatre--unknown.json': { url: 'https://et.com/a' } });
  assert.equal(decideAfterPrefetch(d, { ...base, url: 'https://et.com/b' }, null, norm).action, 'unresolved-collision');
});

test('named critic in a taken slot skips without a fetch', () => {
  const d = showDirWith({ 'everything-theatre--jane-doe.json': { url: 'https://et.com/a' } });
  assert.equal(decideBeforePrefetch(d, { ...base, criticName: 'Jane Doe', url: 'https://et.com/b' }, norm).reason, 'slot-dupe');
});

test('class guard: discovery script never vetoes on a bare filename existsSync before the prefetch', () => {
  const src = fs.readFileSync(new URL('../../scripts/discover-opening-night-reviews.js', import.meta.url), 'utf8');
  assert.ok(!/if \(fs\.existsSync\(filepath\)\)/.test(src), 'filename-exists veto returned');
  assert.equal((src.match(/await prefetchWithSlotGate\(/g) || []).length, 3, 'all three discovery branches use the gate');
});
