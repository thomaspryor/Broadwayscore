// BRO-4818: shadow-mode Codex cross-check of a landed Claude change (scripts/codex/check-claude.js).
// Requires the real functions (CLAUDE.md §15), never a copy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const C = require('../../scripts/codex/check-claude.js');
const R = require('../../scripts/lib/codex-runner.js');

test('quota gate: unknown or at/above the cap skips, below runs', () => {
  assert.match(C.quotaSkipReason(null), /unknown/);
  assert.match(C.quotaSkipReason(undefined), /unknown/);
  assert.match(C.quotaSkipReason(70), /70%/);
  assert.match(C.quotaSkipReason(93, 70), /cap 70%/);
  assert.equal(C.quotaSkipReason(69.9), null);
  assert.equal(C.quotaSkipReason(0), null);
  assert.match(C.quotaSkipReason(50, 40), /cap 40%/);
});

test('args: card and commit validated, cap defaults to 70', () => {
  assert.deepEqual(C.parseArgs(['--card', 'BRO-12', '--commit', 'abc1234']), { card: 'BRO-12', commit: 'abc1234', maxWeeklyPct: 70, dryRun: false });
  const bad = C.parseArgs(['--card', 'x; rm', '--commit', 'HEAD~1', '--max-weekly-pct', 'nope', '--dry-run']);
  assert.equal(bad.card, null);
  assert.equal(bad.commit, null);
  assert.equal(bad.maxWeeklyPct, 70);
  assert.equal(bad.dryRun, true);
  assert.equal(C.parseArgs(['--card', '--commit', 'abc1234']).card, null);
  assert.equal(C.parseArgs(['--max-weekly-pct', '55']).maxWeeklyPct, 55);
});

test('prompt: real check-prompt.md filled with card, landed commit and diff; placeholders in the diff stay literal', () => {
  const tpl = readFileSync(join(ROOT, 'scripts/codex/check-prompt.md'), 'utf8');
  const p = C.buildPrompt(tpl, { id: 'BRO-9', title: 'Fix thing', body: 'card body {{ID}}', commit: 'deadbeef', diff: '+x {{BODY}}\n```\n', root: '/repo' });
  assert.match(p, /ALREADY landed on main as commit deadbeef/);
  assert.match(p, /=== CARD BRO-9: Fix thing ===/);
  assert.match(p, /card body \{\{ID\}\}/);
  assert.match(p, /\+x \{\{BODY\}\}/);
  assert.match(p, /VERDICT: SHIP/);
  assert.ok(!p.includes('{{WORKTREE}}') && !p.includes('{{EXTRA}}'));
  assert.equal((p.match(/```/g) || []).length, 2, 'a fence inside the diff must not close the diff block');
  const big = C.buildPrompt(tpl, { id: 'BRO-9', title: 't', body: '', commit: 'deadbeef', diff: 'y'.repeat(100000), root: '/repo' });
  assert.match(big, /diff truncated/);
  assert.ok(big.length < 90000);
});

test('comments: REJECT and SHIP-WITH-FIXES post (shadow wording), SHIP and NONE do not', () => {
  const report = 'blah\nVERDICT: REJECT\n- wrong caller';
  assert.equal(R.parseVerdict(report), 'REJECT');
  const c = C.commentFor('REJECT', { commit: 'abc1234', report });
  assert.match(c, /Codex cross-check \(shadow\): REJECT/);
  assert.match(c, /does not change the card's state/);
  assert.match(c, /wrong caller/);
  assert.match(C.commentFor('SHIP-WITH-FIXES', { commit: 'abc1234', report: 'x' }), /SHIP-WITH-FIXES/);
  assert.equal(C.commentFor('SHIP', { commit: 'abc1234', report: 'VERDICT: SHIP' }), null);
  assert.equal(C.commentFor('NONE', { commit: 'abc1234', report: '' }), null);
});

test('re-run on the same commit posts nothing; another commit or a human comment does not count', () => {
  const posted = C.commentFor('REJECT', { commit: 'abc1234', report: 'VERDICT: REJECT' });
  assert.equal(C.alreadyCommented([{ body: posted }], 'abc1234'), true);
  assert.equal(C.alreadyCommented([{ body: posted }], 'fff9999'), false);
  assert.equal(C.alreadyCommented([{ body: 'see commit abc1234' }], 'abc1234'), false);
  assert.equal(C.alreadyCommented(undefined, 'abc1234'), false);
});

test('weekly allowance: newest rollout with a reading wins, no sessions means unknown', () => {
  const home = mkdtempSync(join(tmpdir(), 'codex-home-'));
  assert.equal(R.weeklyPctFromSessions(home), null);
  const d = join(home, 'sessions', '2026', '10', '14');
  mkdirSync(d, { recursive: true });
  const row = (pct) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', rate_limits: { secondary: { used_percent: pct, window_minutes: 10080 } } } });
  writeFileSync(join(d, 'old.jsonl'), row(42));
  utimesSync(join(d, 'old.jsonl'), new Date(1e12), new Date(1e12));
  writeFileSync(join(d, 'new.jsonl'), row(81));
  writeFileSync(join(d, 'newest-no-reading.jsonl'), '{"type":"session_meta"}');
  assert.equal(R.weeklyPctFromSessions(home), 81);
  assert.match(C.quotaSkipReason(R.weeklyPctFromSessions(home)), /81%/);
});

test('CLI never fails the caller: bad args exit 0 without calling Codex or Linear', () => {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts/codex/check-claude.js'), '--card', 'nope'], { encoding: 'utf8', timeout: 30000 });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /skipped/);
});

test('the script stays shadow-only and read-only: no state moves, read-only sandbox', () => {
  const src = readFileSync(join(ROOT, 'scripts/codex/check-claude.js'), 'utf8');
  assert.match(src, /'--sandbox', 'read-only'/);
  assert.match(src, /model_reasoning_effort=high/);
  assert.match(src, /--lock-status/, 'must stand aside while the daily runner holds the shared login');
  assert.ok(!src.includes("require(path.join(ROOT, 'scripts/codex/daily-runner.js'))"), 'requiring the runner installs its kill handlers, which release the run lock');
  assert.ok(!/--state|updateIssue|stateId/.test(src), 'shadow mode must never move the card');
});

test('board-workers step 6 runs the cross-check before Done and never lets it block', () => {
  const doc = readFileSync(join(ROOT, 'docs/cloud-routines/board-workers.md'), 'utf8');
  const step6 = doc.slice(doc.indexOf('6. After it lands'), doc.indexOf('## 3. Finish'));
  const i = step6.indexOf('scripts/codex/check-claude.js');
  assert.ok(i > 0, 'step 6 must run scripts/codex/check-claude.js');
  assert.ok(i < step6.indexOf('--state Done'), 'the cross-check runs before the card is marked Done');
  assert.match(step6, /never (stops|blocks|prevents)/i);
});
