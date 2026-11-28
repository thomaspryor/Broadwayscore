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
 * commit): approving a visual change ships it. BRO-8462: a Void is refused while the
 * held branch still has a diff against origin/main (nothing shipped yet). The owner's tap on the email approves it; so does their plain yes in the chat, in which case the session lands the held change itself and then voids the ask. Exit 0 recorded (or already answered), 1 refused or
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
  identifier title description url createdAt labels { nodes { name } } comments(last: 100) { nodes { body createdAt } } } }`;

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
function resolveDecision(issue, choice, facts = {}) {
  if (!issue) return { error: 'card not found' };
  const visual = link.parseVisualApproval(issue.description);
  // BRO-6411: void closes a visual ask whose change shipped another way. It never approves.
  if (choice === 'void' && !visual) return { error: 'void is only for a card with a visual ask (VISUAL-APPROVAL line)' };
  // BRO-8462: a Void while the held change still has code main lacks is false ("shipped another way" when nothing
  // shipped). BRO-8451: the owner's chat "Yes" was saved as Void, the hold was then deleted and the owner asked again.
  // facts.holdSettled comes from git in main(): false = the hold still differs from main. Unknown (CI) is not refused.
  if (choice === 'void' && visual && facts.holdSettled === false) {
    const hold = visual.hold || 'visual-hold/<card>';
    if (facts.holdGone) return { error: `the owner's words read as a yes, but the held change on ${hold} is gone and nothing for ${issue.identifier} is on main since the ask, so Void ("shipped another way") would be false. Their yes in THIS chat is the approval: rebuild the change on a branch and land it yourself (land/${issue.identifier.toLowerCase()}-<slug>, follow the Land run to prod), then re-run with --choice void. Do not ask the owner again.` };
    return { error: facts.affirmative
      ? `the owner's words read as a yes, but the held change on ${hold} is not on main yet, so Void ("shipped another way") would be false. Their yes in THIS chat is the approval: ship it yourself (git fetch origin ${hold} && git push origin FETCH_HEAD:refs/heads/land/${issue.identifier.toLowerCase()}-visual, follow the Land run to prod), then re-run with --choice void. Never record a yes as Void before it lands.`
      : `the held change on ${hold} is not on main, so Void ("shipped another way") would be false. Land it first, or if it truly shipped as a different commit, delete the obsolete hold (git push origin :refs/heads/${hold}) and re-run.` };
  }
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

/** BRO-8462: git facts for a Void: is the held change already on main (or gone)? Does the owner's quote read as a yes? */
async function voidFacts(issue, text, { git = require('./lib/visual-approval.js').git, changeOnMain = require('./lib/visual-approval.js').changeOnMain } = {}) {
  const visual = link.parseVisualApproval(issue.description);
  const hold = visual.hold;
  if (!/^visual-hold\/[a-z0-9][a-z0-9-]{0,60}$/.test(String(hold || ''))) return { error: `the card names no valid hold branch (${hold})` };
  let affirmative = false;
  try { affirmative = (await import('./lib/owner-reply-classifier.mjs')).classifyOwnerReply(String(text || '')) === 'approve'; } catch { /* wording only */ }
  const first = (e) => String(e && e.message || e).split('\n')[0];
  const since = Math.floor(askedSince(issue) / 1000);
  // A depth-1 CI checkout has no history to search or merge-base with: deepen to 6 hours before the ask (request
  // rebases onto current main just before it asks; main takes ~1,400 commits a day, so two days took 5 minutes
  // and the job's limit is 5). Never make a full clone shallow. A hold forked earlier has no merge-base here, the
  // diff below throws, and the Void is refused with that reason (fails closed).
  let deepen = [];
  try { if (git(['rev-parse', '--is-shallow-repository']) === 'true') deepen = ['--no-tags', `--shallow-since=${since - 6 * 3600}`]; } catch { /* not a repo: the fetch below fails closed */ }
  try {
    // Gone from origin = nothing left to ship (the lander's holdSettled reads it the same way). But after an owner
    // yes (BRO-8451: the hold was deleted by a wrong cleanup) a Void would hide that the yes went nowhere: then
    // something naming the card must be on main since the ask.
    if (!git(['ls-remote', '--heads', 'origin', hold])) {
      if (!affirmative) return { holdSettled: true, affirmative };
      git(['fetch', '--quiet', ...deepen, 'origin', 'main']);
      const named = new RegExp(`\\b${issue.identifier}(?![0-9])`, 'i');
      const onMain = named.test(git(['log', 'origin/main', `--since=@${since}`, '--format=%s%n%b']));
      return { holdSettled: onMain, holdGone: !onMain, affirmative };
    }
    git(['fetch', '--quiet', ...deepen, 'origin', 'main', `+refs/heads/${hold}:refs/remotes/origin/${hold}`]);
  } catch (e) { return { error: first(e) }; }
  // Landed already (land.yml rebases, so the hold keeps its own commits): the change itself must be in main.
  try { return { holdSettled: changeOnMain(`origin/${hold}`), affirmative }; } catch (e) { return { error: first(e) }; }
}

/**
 * BRO-8462: resolveDecision plus, for a visual Void, the git facts it needs. Both the session check and the CI
 * --execute run go through here, so neither can record a Void the other would refuse. `deps` is for tests.
 */
async function decide(issue, choice, text, deps) {
  const facts = choice === 'void' && issue && link.parseVisualApproval(issue.description) ? await voidFacts(issue, text, deps) : {};
  if (facts.error) return { error: `could not check the held change against main (${facts.error}); a Void is only recorded once that check passes.` };
  return resolveDecision(issue, choice, facts);
}

/** When the latest ask was made (ms): the newest "Asked the owner" comment, else the card's creation. */
function askedSince(issue) {
  const asks = ((issue.comments && issue.comments.nodes) || []).filter((c) => /^Asked the owner to look at/.test(link.unescapeMarkdown(c.body || '').trim()))
    .map((c) => new Date(c.createdAt).getTime()).filter(Number.isFinite);
  return asks.length ? Math.max(...asks) : (new Date(issue.createdAt).getTime() || 0);
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
  // BRO-8462: the same Void check as the session runs, here too, so a direct dispatch (or a hold that moved after
  // the session's check) cannot close an unshipped visual ask.
  const r = await decide(await fetchIssue(opts.id), opts.choice, opts.text);
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
  try {
    r = await decide(await fetchIssue(opts.id), opts.choice, opts.text);
  } catch (e) { console.error(`[record-owner-answer] could not read the card: ${e.message}`); return 1; }
  if (r.decision) console.log(describe(r.decision));
  if (r.error) { console.error(`[record-owner-answer] refused: ${r.error}`); return 1; }
  if (opts.check) return 0;
  const dispatch = require('./cloud-dispatch.js');
  return dispatch.main([WORKFLOW, '-f', `issue=${opts.id}`, '-f', `choice=${opts.choice}`, '-f', `text=${opts.text}`, '-f', `via=${opts.via}`, '--wait', '--timeout=15']);
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (err) => { console.error(`[${path.basename(__filename)}] ${err.stack || err.message}`); process.exitCode = 1; });
}

module.exports = { main, execute, decide, parseArgs, resolveDecision, voidFacts, WORKFLOW };
