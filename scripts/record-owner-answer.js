#!/usr/bin/env node
/**
 * record-owner-answer.js (BRO-6266): save an answer the owner gave in a Claude
 * chat onto the card, through the same record path as the decision email's
 * answer page (recordAnswer in src/lib/owner-decision-link.js: the "Owner
 * decision" comment, the ANSWERED line, the label and the state). Without it
 * the emailer cannot see a chat answer and asks the owner again.
 *
 *   node scripts/record-owner-answer.js BRO-N --choice A|B|approve|reject|own|void --text "..." [--via "a chat with Claude"] [--check]
 *
 * Cloud sessions do not hold APPROVAL_HMAC_SECRET, so by default this checks
 * the card (prints the open question and its choices) and dispatches
 * record-owner-answer.yml, which runs this script with --execute in CI.
 * --check stops after the card check. Cards carrying a VISUAL-APPROVAL line are
 * refused unless --choice void (the change shipped another way, e.g. a VISUAL-OK
 * commit): approving a visual change ships it, so that stays with the owner's own tap. Exit 0 recorded (or already answered), 1 refused or
 * failed, 2 bad usage.
 */
'use strict';

const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
const link = require('../src/lib/owner-decision-link.js');

const USAGE = 'Usage: node scripts/record-owner-answer.js BRO-N --choice A|B|approve|reject|own|void --text "..." [--via "a chat with Claude"] [--check]';
const WORKFLOW = 'record-owner-answer.yml';
const MAX_VIA = 80;

const ISSUE_QUERY = `query($id: String!) { issue(id: $id) {
  identifier title description url createdAt labels { nodes { name } } } }`;

// In CI the answer text comes from the dispatch payload, not argv or env, so it
// never appears in the public run log.
function eventInputs(file = process.env.GITHUB_EVENT_PATH) {
  if (!file) throw new Error('--inputs-from-event needs GITHUB_EVENT_PATH');
  return (JSON.parse(require('fs').readFileSync(file, 'utf8')).inputs) || {};
}

function parseArgs(argv, { readEvent = eventInputs } = {}) {
  const opts = { id: null, choice: null, text: '', via: 'a chat with Claude', execute: false, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--choice') opts.choice = argv[++i];
    else if (a === '--text') opts.text = argv[++i] || '';
    else if (a === '--via') opts.via = argv[++i] || '';
    else if (a === '--execute') opts.execute = true;
    else if (a === '--check') opts.check = true;
    else if (a === '--inputs-from-event') { const ev = readEvent(); opts.text = String(ev.text || ''); opts.via = String(ev.via || ''); }
    else if (!a.startsWith('-') && !opts.id) opts.id = a.toUpperCase();
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!opts.id || !link.ID_RE.test(opts.id)) throw new Error('First argument must be a card id like BRO-123');
  if (!opts.choice || !/^[A-Za-z]{1,10}$/.test(opts.choice)) throw new Error('--choice is required (a letter like A, approve, reject or own)');
  opts.choice = opts.choice.toLowerCase();
  opts.via = link.sanitizeAnswer(opts.via).replace(/\s+/g, ' ').slice(0, MAX_VIA) || 'a chat with Claude';
  if (opts.choice === 'own' && !link.sanitizeAnswer(opts.text)) throw new Error('--choice own needs --text with the owner\'s words');
  return opts;
}

/**
 * The card's open decision and the choice key to record, or {error}.
 * Pure: takes the fetched issue.
 */
function resolveDecision(issue, choice) {
  if (!issue) return { error: 'card not found' };
  const visual = link.parseVisualApproval(issue.description);
  // BRO-6411: void closes a visual ask whose change shipped another way. It never approves.
  if (choice === 'void' && !visual) return { error: 'void is only for a card with a visual ask (VISUAL-APPROVAL line)' };
  if (visual && choice !== 'void') {
    return { error: 'this card holds a visual change on visual-hold/<card>. If the owner said yes/Approved in THIS chat, that is the approval: ship the held change yourself (git fetch origin visual-hold/<card> && git push origin FETCH_HEAD:refs/heads/land/<card>, follow the Land run), then re-run with --choice void. Never tell the owner to tap anything. No owner in the chat: wait for their tap on the email.' };
  }
  const decision = link.listOpenDecisions([issue])[0];
  if (!decision) return { error: 'the card has no open DECISION NEEDED question (already answered, or never asked)' };
  // The record and the choices always belong to the card's first question, so
  // a letter meant for a later question would be saved against the wrong one.
  const questions = link.markerLines(issue.description).filter((m) => !link.isPlaceholderQuestion(m.question));
  if (questions.length > 1) return { error: `the card has ${questions.length} DECISION NEEDED questions; answer it from the email so the answer is recorded against the right one`, decision };
  const keys = decision.choices.map((c) => c.key);
  if (choice !== 'own' && choice !== 'void' && !keys.includes(choice)) {
    return { error: `"${choice}" is not one of this card's choices: ${[...keys, 'own'].join(', ')}`, decision };
  }
  return { decision, choiceKey: choice };
}

async function fetchIssue(id) {
  const linear = require('./lib/linear-client');
  const data = await linear.graphql(ISSUE_QUERY, { id });
  return data && data.issue;
}

function describe(decision) {
  return `${decision.identifier}: "${decision.question}"\n  choices: ${decision.choices.map((c) => `${c.key} (${c.label})`).join(', ')}, own`;
}

async function execute(opts) {
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) { console.error('[record-owner-answer] APPROVAL_HMAC_SECRET is not set (this mode runs in CI)'); return 1; }
  const linear = require('./lib/linear-client');
  const r = resolveDecision(await fetchIssue(opts.id), opts.choice);
  if (r.error) { console.error(`[record-owner-answer] refused: ${r.error}`); return 1; }
  // Public log: card id and choice key only, never the question or the owner's words.
  console.log(`[record-owner-answer] ${opts.id}: recording choice ${r.choiceKey}`);
  // The run that wrote it, so a chat answer can always be traced to its dispatch.
  const run = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
  const via = run ? `${opts.via} (recorded by ${run}${process.env.GITHUB_ACTOR ? `, dispatched by ${process.env.GITHUB_ACTOR}` : ''})` : opts.via;
  const out = await link.recordAnswer({ graphql: linear.graphql, id: opts.id, hash: r.decision.hash, secret, choiceKey: r.choiceKey, allowVoid: true, text: opts.text, via });
  console.log(`[record-owner-answer] ${opts.id}: ${out.status}`);
  return out.status === 'recorded' || out.status === 'answered' ? 0 : 1;
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`${e.message}\n${USAGE}`); return 2; }
  if (opts.execute) return execute(opts);

  // Check the card first, so a wrong card or a letter from a different question fails here.
  let r;
  try { r = resolveDecision(await fetchIssue(opts.id), opts.choice); } catch (e) { console.error(`[record-owner-answer] could not read the card: ${e.message}`); return 1; }
  if (r.decision) console.log(describe(r.decision));
  if (r.error) { console.error(`[record-owner-answer] refused: ${r.error}`); return 1; }
  if (opts.check) return 0;
  const dispatch = require('./cloud-dispatch.js');
  return dispatch.main([WORKFLOW, '-f', `issue=${opts.id}`, '-f', `choice=${opts.choice}`, '-f', `text=${opts.text}`, '-f', `via=${opts.via}`, '--wait', '--timeout=15']);
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(`[${path.basename(__filename)}] ${err.stack || err.message}`); process.exitCode = 1; });
}

module.exports = { main, parseArgs, resolveDecision, WORKFLOW };
