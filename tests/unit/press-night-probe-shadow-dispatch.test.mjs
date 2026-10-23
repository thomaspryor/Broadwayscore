// BRO-6074: press-night-probe.yml starts the opening-night lane shadow for Broadway press nights.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planShadowDispatch, shadowRunTitle } = require('../../scripts/lib/lane-shadow-dispatch.js');

const EMBARGO = '2026-10-30T02:00:00Z';
const emb = Date.parse(EMBARGO);
const base = { show: 'a-few-good-men-2026', night: '2026-10-29', market: 'broadway', embargoAt: EMBARGO };

test('broadway show at embargo -30 min: dispatches, window capped at 320', () => {
  const p = planShadowDispatch({ ...base, nowMs: emb - 30 * 60000, activeTitles: [] });
  assert.equal(p.dispatch, true);
  assert.equal(p.windowMin, 320);
});

test('late start: window runs to embargo +5h', () => {
  const p = planShadowDispatch({ ...base, nowMs: emb + 3 * 3600000 });
  assert.equal(p.dispatch, true);
  assert.equal(p.windowMin, 120);
});

test('skips non-broadway, bad inputs, and a night past embargo +5h', () => {
  assert.equal(planShadowDispatch({ ...base, market: 'west-end', nowMs: emb }).dispatch, false);
  assert.equal(planShadowDispatch({ ...base, show: 'Bad Id', nowMs: emb }).dispatch, false);
  assert.equal(planShadowDispatch({ ...base, night: 'tonight', nowMs: emb }).dispatch, false);
  assert.equal(planShadowDispatch({ ...base, embargoAt: 'nope', nowMs: emb }).dispatch, false);
  assert.equal(planShadowDispatch({ ...base, nowMs: emb + 5 * 3600000 }).dispatch, false);
});

test('skips a show-night whose shadow is already queued or running; other nights/shows do not block', () => {
  const nowMs = emb - 30 * 60000;
  const mine = shadowRunTitle(base.show, base.night);
  assert.equal(planShadowDispatch({ ...base, nowMs, activeTitles: [mine] }).dispatch, false);
  const others = [shadowRunTitle(base.show, '2026-10-22'), shadowRunTitle('other-show', base.night), 'Opening-night lane night x 2026-10-29'];
  assert.equal(planShadowDispatch({ ...base, nowMs, activeTitles: others }).dispatch, true);
});

const probe = fs.readFileSync(new URL('../../.github/workflows/press-night-probe.yml', import.meta.url), 'utf8');
const lane = fs.readFileSync(new URL('../../.github/workflows/opening-night-lane-live.yml', import.meta.url), 'utf8');

test('probe early job dispatches lane-live mode=shadow, warn-only, with actions: write', () => {
  const early = probe.slice(probe.indexOf('\n  early:'), probe.indexOf('\n  late:'));
  assert.match(early, /\n    permissions:\n(?:      [^\n]*\n)*?      actions: write\n/);
  const step = early.slice(early.indexOf('- name: Start lane shadow'));
  assert.match(step, /continue-on-error: true/);
  assert.match(step, /if: steps\.guard\.outputs\.finalized == 'false'/);
  assert.match(step, /timeout-minutes: 2/);
  assert.match(step, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(step, /gh workflow run opening-night-lane-live\.yml[^\n]*-f mode=shadow/);
  assert.match(step, /lane-shadow-dispatch\.js/);
  for (const st of ['in_progress', 'queued', 'pending']) assert.match(step, new RegExp(`for ST in[^\\n]*\\b${st}\\b`));
  assert.match(step, /--active="\$ACTIVE"/);
  assert.match(step, /--market="\$MARKET"/);
  assert.match(step, /--embargo-at="\$EMBARGO_AT"/);
  assert.match(step, /-f window_min="\$WINDOW"/);
  assert.match(step, /skipping lane shadow dispatch/, 'fails closed when the run list fails');
  // after the embargo wait, before the probe step
  assert.ok(early.indexOf('- name: Wait for embargo - 30 min') < early.indexOf('- name: Start lane shadow'));
  assert.ok(early.indexOf('- name: Start lane shadow') < early.indexOf('- name: Probe to embargo +2h'));
});

test('late job keeps actions: read for the artifact download', () => {
  assert.match(probe, /^permissions:\n(?:  [^\n]*\n)*?  actions: read\n/m);
  const late = probe.slice(probe.indexOf('\n  late:'));
  assert.doesNotMatch(late, /\n    permissions:/, 'late inherits workflow-level actions: read');
});

test('lane-live run-name matches the title the dedupe looks for', () => {
  const m = /^run-name:\s*'([^']+)'/m.exec(lane);
  assert.ok(m, 'run-name present');
  const rendered = m[1].replace('${{ inputs.mode }}', 'shadow').replace('${{ inputs.show }}', 'a-few-good-men-2026').replace('${{ inputs.night }}', '2026-10-29');
  assert.equal(rendered, shadowRunTitle('a-few-good-men-2026', '2026-10-29'));
});

test('CLI: multi-line --active with the matching title blocks dispatch', async () => {
  const { execFileSync } = await import('node:child_process');
  const cli = new URL('../../scripts/lib/lane-shadow-dispatch.js', import.meta.url).pathname;
  const args = ['--show=' + base.show, '--night=' + base.night, '--market=broadway', '--embargo-at=' + new Date(Date.now() + 3600000).toISOString()];
  const blocked = JSON.parse(execFileSync('node', [cli, ...args, '--active=other\n' + shadowRunTitle(base.show, base.night)]).toString());
  assert.equal(blocked.dispatch, false);
  const open = JSON.parse(execFileSync('node', [cli, ...args, '--active=other']).toString());
  assert.equal(open.dispatch, true);
});

test('BRO-6074: probe step has a kill switch and also dedupes against a finished successful shadow', () => {
  const y = fs.readFileSync('.github/workflows/press-night-probe.yml', 'utf8');
  const step = y.slice(y.indexOf('- name: Start lane shadow'), y.indexOf('- name: Probe to embargo +2h'));
  assert.match(step, /vars\.LANE_SHADOW_AUTO != 'false'/);
  assert.match(step, /--status success/);
});
