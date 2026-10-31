#!/usr/bin/env node
'use strict';
/**
 * check-claude.js — SHADOW-MODE Codex cross-check of a change a Claude worker
 * has already landed (BRO-4818). Run by the board-workers routine
 * (docs/cloud-routines/board-workers.md, step 6) before the card is closed.
 *
 *   node scripts/codex/check-claude.js --card BRO-123 --commit <landed sha> [--dry-run]
 *
 * Codex (`codex exec --sandbox read-only -c model_reasoning_effort=high`) reviews
 * the card body plus the landed diff with scripts/codex/check-prompt.md.
 * REJECT or SHIP-WITH-FIXES -> one comment on the card. Shadow mode: it never
 * moves the card, and it ALWAYS exits 0, so a failure here can never stop the
 * worker closing the card. It is skipped while the Codex weekly allowance is at
 * or above --max-weekly-pct (default 70) or unknown, so the daily Codex runner
 * keeps its headroom.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const R = require(path.join(ROOT, 'scripts/lib/codex-runner.js'));

const MAX_DIFF_CHARS = 60000;
const CODEX_TIMEOUT_MS = 12 * 60_000;
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const HEADER = '## Codex cross-check (shadow)';

/** argv -> { card, commit, maxWeeklyPct, dryRun } (card/commit null when missing or malformed). */
function parseArgs(argv) {
  const val = (name) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const card = val('card');
  const commit = val('commit');
  const pct = Number(val('max-weekly-pct'));
  return {
    card: card && /^[A-Z]+-\d+$/.test(card) ? card : null,
    commit: commit && /^[0-9a-f]{7,40}$/i.test(commit) ? commit : null,
    maxWeeklyPct: Number.isFinite(pct) && pct > 0 ? pct : 70,
    dryRun: argv.includes('--dry-run'),
  };
}

/** Why the check must not run on this allowance reading, or null to run it. Unknown counts as too high. */
function quotaSkipReason(weeklyPct, maxWeeklyPct = 70) {
  if (weeklyPct == null || !Number.isFinite(Number(weeklyPct))) return 'Codex weekly allowance unknown';
  if (Number(weeklyPct) >= maxWeeklyPct) return `Codex weekly allowance at ${weeklyPct}% (cap ${maxWeeklyPct}%)`;
  return null;
}

/** check-prompt.md filled for a landed Claude change; the preamble overrides the runner-specific framing. */
function buildPrompt(template, { id, title, body, commit, diff, root }) {
  const clipped = diff.length > MAX_DIFF_CHARS ? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff truncated; read the rest with git show ${commit}]` : diff;
  const preamble = [
    `CONTEXT FOR THIS REVIEW (overrides the runner wording below): a Claude worker, not Codex, made this change and it has ALREADY landed on main as commit ${commit}.`,
    `Inspect it with \`git -C ${root} show --stat ${commit}\` and \`git -C ${root} show ${commit} -- <path>\` (not origin/main...HEAD). Your verdict is a shadow cross-check posted to the card; it does not gate anything.`,
    'You run in a read-only sandbox: read files and run read-only commands only.',
    '',
  ].join('\n');
  const extra = `The landed diff (\`git show --stat --patch ${commit}\`):\n\n\`\`\`diff\n${clipped.replace(/```/g, "'''")}\n\`\`\``;
  const data = '- Real data may be missing in this checkout; say so and judge on the code and tests.';
  return preamble + R.fillPrompt(template, { id, title, body, extra, data, worktree: root });
}

/** Card comment for a verdict, or null when nothing is posted (SHIP, or no parsable verdict). */
function commentFor(verdict, { commit, report }) {
  if (verdict !== 'REJECT' && verdict !== 'SHIP-WITH-FIXES') return null;
  const text = String(report || '').trim();
  return [
    `${HEADER}: ${verdict}`,
    '',
    `Codex reviewed landed commit ${commit} after the Claude worker. Shadow mode: this comment does not change the card's state; weigh the findings and follow up if they hold.`,
    '',
    text.length > 6000 ? `${text.slice(-6000)}` : text,
  ].join('\n');
}

/** True when a cross-check comment for this commit is already on the card (a re-run posts nothing). */
function alreadyCommented(comments, commit) {
  return (comments || []).some((c) => String(c.body || '').startsWith(HEADER) && String(c.body).includes(`commit ${commit}`));
}

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: opts.timeoutMs || 120_000, env: opts.env || process.env, input: opts.input || '', maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status == null ? -1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}`, stdout: r.stdout || '' };
}

async function main() {
  const say = (msg) => console.log(`[codex-crosscheck] ${msg}`);
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.card || !opts.commit) { say('usage: --card BRO-N --commit <sha>; skipped'); return; }

  require(path.join(ROOT, 'scripts/lib/load-env')).loadEnv();
  const skip = quotaSkipReason(R.weeklyPctFromSessions(CODEX_HOME), opts.maxWeeklyPct);
  if (skip) { say(`${opts.card}: skipped, ${skip}`); return; }
  // A live daily runner (any container) shares the Codex login, and refresh tokens rotate:
  // the cloud lane's (the GitHub lane runs only when the login outlives its run, so never refreshes).
  // a second Codex process refreshing alongside it could log it out. Its work comes first.
  const lock = sh('node', ['scripts/codex/daily-runner.js', '--lock-status', '--lane', 'cloud'], { timeoutMs: 180_000 });
  if (lock.code !== 0) { say(`${opts.card}: skipped, the daily Codex runner is live or its lock is unreadable (exit ${lock.code})`); return; }
  if (sh('codex', ['--version']).code !== 0) { say(`${opts.card}: skipped, Codex CLI not installed`); return; }
  if (sh('git', ['cat-file', '-e', `${opts.commit}^{commit}`]).code !== 0) { say(`${opts.card}: skipped, commit ${opts.commit} not found (git fetch first)`); return; }
  opts.commit = sh('git', ['rev-parse', `${opts.commit}^{commit}`]).stdout.trim(); // full sha, so the re-run check matches

  const linear = require(path.join(ROOT, 'scripts/lib/linear-client.js'));
  const card = await linear.getIssue(opts.card);
  if (!card) { say(`${opts.card}: skipped, card not found`); return; }
  const comments = (await linear.listIssueComments([opts.card]).catch(() => new Map())).get(opts.card) || [];
  if (alreadyCommented(comments, opts.commit)) { say(`${opts.card}: skipped, already cross-checked ${opts.commit}`); return; }
  const diff = sh('git', ['show', '--stat', '--patch', opts.commit]).stdout;
  const tpl = fs.readFileSync(path.join(ROOT, 'scripts/codex/check-prompt.md'), 'utf8');
  const prompt = buildPrompt(tpl, { id: opts.card, title: card.title, body: R.cardBody(card.description, comments), commit: opts.commit, diff, root: ROOT });
  if (opts.dryRun) { say(`${opts.card}: dry run, prompt ${prompt.length} chars, no Codex call`); return; }

  const restore = sh('node', ['scripts/codex/auth-store.js', 'restore'], { timeoutMs: 300_000 });
  if (restore.code !== 0) { say(`${opts.card}: skipped, no usable Codex login`); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-crosscheck-'));
  const last = path.join(tmp, 'last.md');
  // Prompt on stdin (`-`): card plus diff can pass the 128 KiB single-argument limit.
  const r = sh('codex', ['exec', '--dangerously-bypass-hook-trust', '--sandbox', 'read-only', '--color', 'never',
    '-c', 'model_reasoning_effort=high', '-o', last, '-C', ROOT, '-'],
  { timeoutMs: CODEX_TIMEOUT_MS, env: R.scrubEnv(process.env), input: prompt });
  sh('node', ['scripts/codex/auth-store.js', 'save'], { timeoutMs: 300_000 }); // refresh tokens rotate
  let report = '';
  try { report = fs.readFileSync(last, 'utf8'); } catch { report = ''; }
  fs.rmSync(tmp, { recursive: true, force: true });
  const verdict = r.code === 0 ? R.parseVerdict(report) : 'NONE';
  const body = commentFor(verdict, { commit: opts.commit, report });
  if (body) await linear.createComment(card.id, R.redactSecrets(body, process.env));
  say(`${opts.card}: verdict ${verdict}${r.code !== 0 ? ` (codex exit ${r.code})` : ''}${body ? ', comment posted' : ''}`);
}

module.exports = { parseArgs, quotaSkipReason, buildPrompt, commentFor, alreadyCommented };

if (require.main === module) {
  // Shadow mode: never fail the caller.
  main().catch((e) => console.log(`[codex-crosscheck] failed, ignored: ${e && e.message ? e.message.split('\n')[0] : e}`))
    .finally(() => process.exit(0));
}
