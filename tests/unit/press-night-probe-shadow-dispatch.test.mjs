// BRO-6074: press-night-probe.yml starts the opening-night lane shadow for Broadway press nights.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { planShadowDispatch, shadowRunTitle } = require('../../scripts/lib/lane-shadow-dispatch.js');

const EMBARGO = '2026-10-30T02:00:00Z';
const emb = Date.parse(EMBARGO);
// BRO-7231: the plan needs LANE_ONLY_MARKETS (read; unset here = no live lane) and the show's shows.json record.
const AFGM = { id: 'a-few-good-men-2026', market: 'broadway', category: 'broadway', openingDate: '2026-10-29' };
const UNSET = { ok: true, value: '' };
const base = { show: 'a-few-good-men-2026', night: '2026-10-29', market: 'broadway', embargoAt: EMBARGO, onlyMarkets: UNSET, shows: [AFGM] };

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
  assert.equal(planShadowDispatch({ ...base, market: 'off-west-end', nowMs: emb }).dispatch, false);
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

const CLI = new URL('../../scripts/lib/lane-shadow-dispatch.js', import.meta.url).pathname;
function cliRun(extraArgs, env, showsFile) {
  if (!showsFile) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-shadow-'));
    showsFile = path.join(dir, 'shows.json');
    fs.writeFileSync(showsFile, JSON.stringify({ _meta: {}, shows: [AFGM] }));
  }
  const args = ['--show=' + base.show, '--night=' + base.night, '--market=broadway',
    '--embargo-at=' + new Date(Date.now() + 3600000).toISOString(), '--shows-file=' + showsFile];
  return JSON.parse(execFileSync('node', [CLI, ...args, ...extraArgs], { env: { PATH: process.env.PATH, ...env } }).toString());
}

test('CLI: multi-line --active with the matching title blocks dispatch', () => {
  const env = { LANE_ONLY_MARKETS_READ: 'ok', LANE_ONLY_MARKETS: '' };
  assert.equal(cliRun(['--active=other\n' + shadowRunTitle(base.show, base.night)], env).dispatch, false);
  assert.equal(cliRun(['--active=other'], env).dispatch, true);
});

test('BRO-7231 CLI: LANE_ONLY_MARKETS unread (no env, no token) or covering the show = no shadow', () => {
  const unread = cliRun(['--active=other'], {});
  assert.equal(unread.dispatch, false);
  assert.match(unread.reason, /unread/);
  const covered = cliRun(['--active=other'], { LANE_ONLY_MARKETS_READ: 'ok', LANE_ONLY_MARKETS: 'broadway' });
  assert.equal(covered.dispatch, false);
  assert.match(covered.reason, /live lane covers/);
});

test('BRO-7231 CLI: a missing shows file fails safe to no shadow', () => {
  const out = cliRun([], { LANE_ONLY_MARKETS_READ: 'ok', LANE_ONLY_MARKETS: '' }, '/nonexistent/shows.json');
  assert.equal(out.dispatch, false);
  assert.match(out.reason, /fail-safe/);
});

test('BRO-6074: probe step has a kill switch and also dedupes against a finished successful shadow', () => {
  const y = fs.readFileSync('.github/workflows/press-night-probe.yml', 'utf8');
  const step = y.slice(y.indexOf('- name: Start lane shadow'), y.indexOf('- name: Probe to embargo +2h'));
  assert.match(step, /vars\.LANE_SHADOW_AUTO != 'false'/);
  assert.match(step, /--status success/);
});

test('BRO-6802: off-Broadway press nights are shadow nights', () => {
  const p = planShadowDispatch({ ...base, market: 'off-broadway', nowMs: emb - 30 * 60000 });
  assert.equal(p.dispatch, true);
  assert.match(p.reason, /off-broadway/);
});

// BRO-7231: Blueberries (Broadway) and The Visitors (Off-Broadway, market broadway) share the night of 2026-11-09,
// embargo 2026-11-10T03:00Z. Records in the real shows.json shape.
const BLUEBERRIES = { id: 'here-there-are-blueberries-2026', market: 'broadway', category: 'broadway', openingDate: '2026-11-09' };
const VISITORS = { id: 'the-visitors-off-broadway-2026', market: 'broadway', category: 'off-broadway', openingDate: '2026-11-09' };
const NOV = { night: '2026-11-09', embargoAt: '2026-11-10T03:00:00Z', shows: [BLUEBERRIES, VISITORS, AFGM] };
const novStart = Date.parse('2026-11-10T02:30:00Z'); // the probe starts the shadow at embargo -30 min
const BROADWAY = { ok: true, value: 'broadway' };

test('BRO-7231: LANE_ONLY_MARKETS=broadway -> no shadow for Blueberries (the night lane runs it)', () => {
  const p = planShadowDispatch({ ...NOV, show: BLUEBERRIES.id, market: 'broadway', nowMs: novStart, onlyMarkets: BROADWAY });
  assert.equal(p.dispatch, false);
  assert.match(p.reason, /live lane covers here-there-are-blueberries-2026/);
});

test('BRO-7231: LANE_ONLY_MARKETS=broadway -> no shadow for The Visitors the same night (probe passes market=off-broadway)', () => {
  const p = planShadowDispatch({ ...NOV, show: VISITORS.id, market: 'off-broadway', nowMs: novStart, onlyMarkets: BROADWAY });
  assert.equal(p.dispatch, false);
});

test('BRO-7231: an uncovered show whose shadow overlaps a covered show lane window is skipped (runners reserved)', () => {
  const uncovered = { ...VISITORS, market: 'off-broadway' }; // not matched by the broadway token
  const p = planShadowDispatch({ ...NOV, shows: [BLUEBERRIES, uncovered], show: uncovered.id, market: 'off-broadway', nowMs: novStart, onlyMarkets: BROADWAY });
  assert.equal(p.dispatch, false);
  assert.match(p.reason, /runners reserved for here-there-are-blueberries-2026/);
  // A covered show on another week does not block it.
  const far = { ...BLUEBERRIES, openingDate: '2026-11-20' };
  const q = planShadowDispatch({ ...NOV, shows: [far, uncovered], show: uncovered.id, market: 'off-broadway', nowMs: novStart, onlyMarkets: BROADWAY });
  assert.equal(q.dispatch, true);
});

test('BRO-7231 fail-safe: LANE_ONLY_MARKETS unread or missing, or show not in shows.json -> no shadow', () => {
  const args = { ...NOV, show: BLUEBERRIES.id, market: 'broadway', nowMs: novStart };
  assert.equal(planShadowDispatch({ ...args, onlyMarkets: { ok: false, value: '' } }).dispatch, false);
  assert.equal(planShadowDispatch({ ...args, onlyMarkets: undefined }).dispatch, false);
  assert.equal(planShadowDispatch({ ...args, onlyMarkets: UNSET, shows: [] }).dispatch, false);
  // Read and unset: no live lane anywhere, the shadow runs as before.
  assert.equal(planShadowDispatch({ ...args, onlyMarkets: UNSET }).dispatch, true);
});

test('BRO-7231: Start lane shadow step passes REVIEW_TEXTS_TOKEN so LANE_ONLY_MARKETS can be read', () => {
  const step = probe.slice(probe.indexOf('- name: Start lane shadow'), probe.indexOf('- name: Probe to embargo +2h'));
  assert.match(step, /REVIEW_TEXTS_TOKEN: \$\{\{ secrets\.REVIEW_TEXTS_TOKEN \}\}/);
});
