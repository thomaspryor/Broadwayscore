#!/usr/bin/env node
// BRO-7994: a closing message that hands the owner a manual step on an outside site (Google console, GitHub settings,
// a DNS registrar, the Claude environment settings) must give steps the owner can follow on a phone: a direct link,
// numbered steps with one action each, exact on-screen names, what they will see when it worked, no jargon.
// Incident 2026-11-21: "In the Google console, add both broadwayscorecard.com addresses as authorized JavaScript
// origins on the web client starting 1084460721483-0vvpc..." with no link. The owner had to ask for a usable version.
//
// Judges only the "You need to:" / ACTION NEEDED FROM YOU block, and only when it asks for a manual action on an outside
// site (reply-only asks pass). Rules and recipes live in owner-steps.js; ids and paths stay CLEARCLOSE's job.
// Measured before wiring: 49 real messages (the incident thread plus 16 closings from 4 other sessions), 10 owner asks,
// 4 flagged (all incident instructions the owner could not use), 0 false positives.
//
// Rollout (CLAUDE.md section 19): one nudge per distinct owner block until OWNER_STEPS_BLOCKING_FROM, then two.
// Decisions that would block are logged to .cache/owner-steps-stop.log. Fails open on any error.
// Bypass: NO-OWNER-STEPS: <15+ chars>. Kill switch OWNER_STEPS_STOP_DISABLE=1. Wired in .claude/hooks/verify-edits.sh
// as [VE:OWNERSTEPS]; pinned by owner-steps-stop.test.mjs.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { isMainModule } from './is-main-module.mjs';

const require = createRequire(import.meta.url);
const { lintOwnerSteps, ownerBlock, RECIPES } = require('./owner-steps.js');

export const OWNER_STEPS_BLOCKING_FROM = '2026-11-28';
const BYPASS_RE = /^[ \t>*_-]*NO-OWNER-STEPS(?:\*\*)?[ \t]*:[ \t]*(\S.{14,})$/im;

export const blockBudget = (now = new Date()) => (now.toISOString().slice(0, 10) >= OWNER_STEPS_BLOCKING_FROM ? 2 : 1);

export function blockMessage(problems) {
  return [
    'BLOCKED (BRO-7994): the closing asks the owner to do something by hand on an outside site, and they cannot follow it as written (they are not technical and are often on a phone).',
    ...problems.map((p) => `- ${p.detail}`),
    'Rewrite the "You need to:" part as: a direct link, then numbered steps with one action each, the exact button and box names in quotes, and a final "You\'ll see: ..." line. No technical words or ids.',
    `Ready-made steps: node scripts/lib/owner-steps.js <${Object.keys(RECIPES).join('|')}> prints them.`,
    'If no link can exist and the wording is already plain, write NO-OWNER-STEPS: <15+ chars on why>.',
  ].join('\n');
}

/** PURE Stop-hook decision. -> { decision, reason, message?, key? } */
export function stopHookDecision({ lastMessage = '', env = process.env }) {
  if (env.CLAUDE_CODE_REMOTE !== 'true') return { decision: 'allow', reason: 'not a cloud session' };
  if (env.OWNER_STEPS_STOP_DISABLE === '1') return { decision: 'allow', reason: 'OWNER_STEPS_STOP_DISABLE=1' };
  if (BYPASS_RE.test(lastMessage)) return { decision: 'allow', reason: 'NO-OWNER-STEPS bypass' };
  const problems = lintOwnerSteps(lastMessage);
  if (!problems.length) return { decision: 'allow', reason: 'no unusable owner steps' };
  return {
    decision: 'block',
    key: createHash('sha1').update(ownerBlock(lastMessage)).digest('hex').slice(0, 12),
    reason: problems.map((p) => p.code).join(','),
    message: blockMessage(problems),
  };
}

function logHit(entry) {
  try {
    const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.cache');
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'owner-steps-stop.log'), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch { /* best effort */ }
}

export const SESSION_BUDGET = 3;

export function main(argv, { env = process.env, now = new Date(), stdin = null } = {}) {
  if (!argv.includes('--stop-hook')) { process.stderr.write('usage: owner-steps-stop.mjs --stop-hook  (reads the Stop hook JSON on stdin)\n'); return 0; }
  let input = {};
  try { input = JSON.parse(stdin ?? (fs.readFileSync(0, 'utf8') || '{}')); } catch { return 0; }
  const d = stopHookDecision({ lastMessage: input.last_assistant_message || '', env });
  if (d.decision !== 'block') return 0;
  const counter = path.join(os.tmpdir(), `owner-steps-stop-${createHash('sha1').update(String(input.transcript_path || input.session_id || '') + '\u0000' + d.key).digest('hex').slice(0, 12)}`);
  let n = 0;
  try { n = parseInt(fs.readFileSync(counter, 'utf8'), 10) || 0; } catch { /* first block */ }
  const budget = blockBudget(now);
  logHit({ session: input.session_id || null, blocked: n < budget, n, budget, reason: d.reason });
  if (n >= budget) return 0;
  // A per-session cap too: the per-block key changes on every rewrite, so a block the linter can never accept (no link
  // exists) would otherwise be refused on every stop (ship-check).
  const sessionCounter = path.join(os.tmpdir(), `owner-steps-stop-s-${createHash('sha1').update(String(input.transcript_path || input.session_id || '')).digest('hex').slice(0, 12)}`);
  let s = 0;
  try { s = parseInt(fs.readFileSync(sessionCounter, 'utf8'), 10) || 0; } catch { /* first block */ }
  if (s >= SESSION_BUDGET) return 0;
  try { fs.writeFileSync(counter, String(n + 1)); fs.writeFileSync(sessionCounter, String(s + 1)); } catch { /* best effort */ }
  process.stderr.write(d.message + '\n');
  return 2;
}

if (isMainModule(import.meta.url)) {
  let code = 0;
  try { code = main(process.argv.slice(2)); } catch (e) { process.stderr.write(`owner-steps-stop: internal error (failing open): ${e && e.message}\n`); code = 0; }
  process.exitCode = code;
}
