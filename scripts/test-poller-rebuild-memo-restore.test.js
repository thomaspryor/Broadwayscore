// BRO-8010 guard: every rebuild-all-reviews.js step in opening-night-poller.yml
// must be preceded by a fingerprint-memo restore step and have a >=15 min cap.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const raw = fs.readFileSync(path.join(__dirname, '..', '.github/workflows/opening-night-poller.yml'), 'utf8');
const lines = raw.split('\n');
const starts = [];
lines.forEach((l, i) => { const m = l.match(/^ {6}- name:\s*(.+?)\s*$/); if (m) starts.push({ name: m[1], i }); });
const steps = starts.map((s, k) => ({ ...s, body: lines.slice(s.i, k + 1 < starts.length ? starts[k + 1].i : lines.length).join('\n') }));
const rebuildSteps = steps.filter((s) => /\bnode scripts\/rebuild-all-reviews\.js/.test(s.body.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n')));
test('poller has rebuild steps', () => assert.ok(rebuildSteps.length >= 2));
for (const s of rebuildSteps) {
  test(`rebuild step "${s.name}" has memo restore before it and 15m cap`, () => {
    const idx = steps.indexOf(s);
    const before = steps.slice(Math.max(0, idx - 3), idx).some((p) => /Restore fingerprint memo/.test(p.name));
    assert.ok(before, 'no "Restore fingerprint memo" step within 3 steps before');
    const t = s.body.match(/^ {8}timeout-minutes:\s*(\d+)/m);
    assert.ok(t && +t[1] >= 15, 'timeout-minutes must be >= 15');
  });
}
