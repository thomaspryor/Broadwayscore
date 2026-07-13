/**
 * Lifecycle integration test for monitor-gate-ab.js — drives the REAL runner
 * through 6 weeks of fixtures via the GATE_AB_FIXTURE_DIR / GATE_AB_STATE_FILE
 * seams. Email env is stripped, so delivery FAILS — which also exercises the
 * stamp-revert/retry path for real. Run from the worktree root.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FIX = '/tmp/gab-fx';
const ST = '/tmp/gab-st.json';
// Run from repo root: node scripts/dev/gate-ab-monitor-lifecycle-test.js
const RUNNER = path.resolve(__dirname, '..', 'monitor-gate-ab.js');
let failures = 0;

function fixture(file, c, e, bounce, fallbackOnly = false) {
  const arms = fallbackOnly
    ? { fallback: { shown: 12, dismissed: 12, captured: 0 } }
    : {
        control: { shown: c, dismissed: Math.round(c * 0.6), captured: 3 },
        'end-of-content': { shown: e, dismissed: Math.round(e * 0.4), captured: 4 },
        fallback: { shown: 9, dismissed: 9, captured: 0 },
      };
  fs.writeFileSync(path.join(FIX, file), JSON.stringify({ tagged: true, arms, mobileVisitors: 2000, mobileBouncePct: bounce }));
}

function run() {
  const out = execFileSync('node', [RUNNER], {
    encoding: 'utf8',
    env: { ...process.env, GATE_AB_FIXTURE_DIR: FIX, GATE_AB_STATE_FILE: ST, DISCORD_WEBHOOK_ALERTS: '', RESEND_API_KEY: '', OWNER_EMAIL: '' },
  });
  return out;
}
const state = () => JSON.parse(fs.readFileSync(ST, 'utf8'));
const decided = (out) => (/Decisions: (.*)/.exec(out) || [])[1] || '';
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ✔' : '  ✘ FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!cond) failures++;
}

fs.rmSync(FIX, { recursive: true, force: true }); fs.rmSync(ST, { force: true });
fs.mkdirSync(FIX, { recursive: true });

console.log('W0: pre-flag, fallback-only');
fixture('cumulative.json', 0, 0, 64.1, true); fixture('recent.json', 0, 0, 64.1, true);
let out = run();
check('no decisions pre-flag', decided(out) === 'none', decided(out));
check('baseline captured 64.1', state().baselineBouncePct === 64.1);
check('not started', !state().startedAt);

console.log('W1: goes live — email env stripped → delivery fails → stamp reverts');
fixture('cumulative.json', 40, 38, 64.3); fixture('recent.json', 40, 38, 64.3);
out = run();
check('experiment-live decided', decided(out).includes('experiment-live'));
check('delivery failure detected + stamp reverted', /delivery FAILED for experiment-live — stamp liveAlertedAt reverted/.test(out));
check('startedAt persists (factual)', !!state().startedAt);
check('liveAlertedAt reverted for retry', !state().liveAlertedAt);
check('baseline NOT overwritten in-experiment', state().baselineBouncePct === 64.1);

console.log('W2: retry — live fires again (retry semantics), weekly summary is log-only');
fixture('cumulative.json', 200, 190, 64.5); fixture('recent.json', 160, 152, 64.5);
out = run();
check('experiment-live retried', decided(out).includes('experiment-live'));
check('weekly summary log-only', /\[log-only\] weekly-summary/.test(out));

console.log('W6: cumulative 1010/985 past floor, weekly window 170 → power-reached (unit-mismatch regression)');
fixture('cumulative.json', 1010, 985, 64.4); fixture('recent.json', 170, 165, 64.4);
out = run();
check('power-reached decided from CUMULATIVE counts', decided(out).includes('power-reached'));
check('power stamp reverted on failed delivery (will retry)', !state().powerAlertedAt);

console.log('W7: recent bounce 68.3 vs 64.1 baseline (+4.2) → bounce-breach');
fixture('cumulative.json', 1200, 1170, 64.4); fixture('recent.json', 170, 165, 68.3);
out = run();
check('bounce-breach decided', decided(out).includes('bounce-breach'));

console.log('W8: experiment dies (fallback-only, started) → stalled alert, baseline protected');
fixture('cumulative.json', 0, 0, 70.0, true); fixture('recent.json', 0, 0, 70.0, true);
out = run();
check('experiment-stalled decided', decided(out).includes('experiment-stalled'));
check('baseline still 64.1 after dead week at 70.0', state().baselineBouncePct === 64.1, String(state().baselineBouncePct));

console.log(`\n${failures === 0 ? 'ALL LIFECYCLE CHECKS PASS' : failures + ' FAILURE(S)'}`);
process.exit(failures === 0 ? 0 : 1);
