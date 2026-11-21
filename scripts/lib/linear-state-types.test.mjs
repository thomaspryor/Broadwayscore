// BRO-2857: the LINEAR_REPORTED marker is keyed on state TYPE, never on a state name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { reportedMarker, isTerminalStateType } = require('./linear-state-types.js');

test('reportedMarker: every terminal type reports, including duplicate', () => {
  for (const type of ['completed', 'canceled', 'duplicate']) {
    assert.equal(reportedMarker('BRO-1', type), '__LINEAR_REPORTED__=BRO-1');
  }
});

test('reportedMarker: non-terminal or missing types never report', () => {
  for (const type of ['started', 'unstarted', 'backlog', undefined, null, '']) {
    assert.equal(reportedMarker('BRO-1', type), '');
  }
  assert.equal(reportedMarker('', 'completed'), '');
});

test('reportedMarker: agrees with isTerminalStateType for the whole type list', () => {
  for (const type of ['completed', 'canceled', 'duplicate', 'started', 'unstarted', 'backlog']) {
    assert.equal(reportedMarker('BRO-2', type) !== '', isTerminalStateType(type));
  }
});

test('linear-brain.js update prints the marker from the resolved state type, not a name list', () => {
  const src = fs.readFileSync(new URL('../linear-brain.js', import.meta.url), 'utf8');
  assert.match(src, /reportedMarker\(issue\.identifier, target\.type\)/);
  assert.doesNotMatch(src, /state=\(Done\|Paused/);
});

test('no repo script documents the phantom "Paused" Linear state as a --state value', () => {
  const dirs = ['../', './'];
  const bad = [];
  for (const d of dirs) {
    for (const f of fs.readdirSync(new URL(d, import.meta.url))) {
      if (!/\.(js|mjs)$/.test(f) || /\.test\./.test(f)) continue;
      const t = fs.readFileSync(new URL(d + f, import.meta.url), 'utf8');
      if (/update [^\n]*--state Done\|Paused/.test(t)) bad.push(f);
    }
  }
  assert.deepEqual(bad, []);
});
