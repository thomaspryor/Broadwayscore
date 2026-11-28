#!/usr/bin/env node
/**
 * visual-approval-land.js (BRO-6241) — CI side of the owner's "does this look
 * right?" answer. Runs every 20 minutes in visual-approval-land.yml (it holds
 * APPROVAL_HMAC_SECRET and a push token; no Claude session or worker queue is
 * involved).
 *
 *   node scripts/visual-approval-land.js [--dry-run]
 *
 * For each open card whose description carries VISUAL-APPROVAL: patch= verdict=
 * hold=, with no landing recorded yet:
 *   - Approved (a "Visual approval ref VQA<mac>" comment that MACs the card's own
 *     patch+verdict, written within 14 days): when visual-hold/bro-n still has
 *     that exact patch-id against origin/main, push it to land/bro-n-visual,
 *     which land.yml gates, rebases and ships. Comments once; moves on.
 *   - Already shipped under a VISUAL-OK-1440: commit naming the card: void the ask
 *     (recordAnswer choice void), then the next pass removes the held refs.
 *   - Unanswered for 14 days: comment, move the card to Todo, delete the hold and
 *     evidence refs (the card returns to the queue to be redone).
 * Exit: 0 ran, 3 could not read Linear / git.
 */
'use strict';

const { hasHelpFlag } = require('./lib/cli-help.js');
const va = require('./lib/visual-approval.js');
const { TERMINAL_STATE_TYPES } = require('./lib/linear-state-types.js');
const link = require('../src/lib/owner-decision-link.js');
const vci = require('./lib/visual-ci.js');

const USAGE = 'Usage: node scripts/visual-approval-land.js [--dry-run]';
const { MARK, STALE_APPROVAL_MS } = va;
const EXPIRE_AFTER_MS = link.VISUAL_TTL_MS;

const landedMarker = (mac) => `${MARK.landed}${mac.slice(0, 16)}`;
const expiredMarker = (mac) => `${MARK.expired}${mac.slice(0, 16)}`;
// A held branch that stopped matching is not final: re-pushing the approved change must be able to land, so this marker is per observed patch.
const cleanedMarker = (mac) => `${MARK.cleaned}${mac.slice(0, 16)}`;
const voidMarker = (mac, patch) => `${MARK.void}${mac.slice(0, 12)}${String(patch).slice(0, 12)}`;
const unverifiedMarker = (mac, sha) => `${MARK.unverified}${mac.slice(0, 12)}${String(sha || 'none').slice(0, 12)}`;
// Once per approval: the owner-visible nudge when a tapped change is still not shipping after STALE_APPROVAL_MS.
const staleMarker = (mac) => `${MARK.stale}${mac.slice(0, 12)}`;
const autoMarker = (mac) => `${MARK.auto}${mac.slice(0, 16)}`;

/** When the owner's Approve was written (ms), from the signed comment itself. */
function approvalTime(comments, marker) {
  const t = ((comments && comments.nodes) || []).filter((c) => link.bodyHasMarker(c.body, marker)).map((c) => new Date(c.createdAt).getTime()).filter(Number.isFinite);
  return t.length ? Math.min(...t) : null;
}

/** An approval that is still not shipping after STALE_APPROVAL_MS. */
const isStale = (approvedAt, now = Date.now()) => approvedAt != null && now - approvedAt > STALE_APPROVAL_MS;

/**
 * BRO-6411: the newest main commit that shipped this card's change under VISUAL-OK
 * (subject starts VISUAL-OK-1440: and names the card). `log` is `sha<TAB>subject` lines.
 */
function shippedVisualCommit(log, id) {
  const named = new RegExp(`\\b${String(id).replace(/[^A-Za-z0-9-]/g, '')}(?![0-9])`, 'i');
  for (const line of String(log || '').split('\n')) {
    const [sha, ...rest] = line.split('\t');
    const subject = rest.join('\t');
    if (/^[0-9a-f]{40}$/.test(sha) && /^VISUAL-OK-1440:/.test(subject) && named.test(subject)) return sha;
  }
  return null;
}

/** When the worker last asked the owner (ms: the newest ask, so an older round's commit never counts); a card without that comment counts from its creation. */
function askedSince(issue) {
  const t = ((issue.comments && issue.comments.nodes) || []).filter((c) => /^Asked the owner to look at/.test(link.unescapeMarkdown(c.body).trim()))
    .map((c) => new Date(c.createdAt).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  return t || new Date(issue.createdAt).getTime() || 0;
}

/** What to do with one card. Pure: the CLI below does the git and Linear writes. */
/**
 * BRO-8462: may an approval of the signed patch ship a hold that a rebase rewrote? Only when the approved tip
 * (the evidence commit's parent) really is the signed patch, and the hold changes exactly the same lines in
 * every file (UI or not); only diff context and line numbers may differ. Pure: inputs come from git in main.
 */
function carryOverOk({ signedPatch, approvedTipPatch, approvedSig, currentSig }) {
  return Boolean(signedPatch && approvedTipPatch === signedPatch && approvedSig && currentSig && approvedSig === currentSig);
}

// facts (BRO-8462): { holdSettled: the hold has nothing left that main lacks (or is gone), carriedOver: carryOverOk() for currentPatch }
function planCard(issue, secret, now = Date.now(), currentPatch = null, shippedSha = null, autoOk = false, facts = {}) {
  const v = link.parseVisualApproval(issue.description);
  if (!v) return { action: 'skip', why: 'no visual approval line' };
  const mac = link.visualMac(secret, issue.identifier, v.patch, v.verdict);
  const comments = issue.comments || { nodes: [] };
  const has = (m) => (comments.nodes || []).some((c) => link.bodyHasMarker(c.body, m));
  if (has(landedMarker(mac)) || has(expiredMarker(mac))) return { action: 'skip', why: 'already handled', v, mac };
  // The change is already live under VISUAL-OK: the ask has nothing left to approve (BRO-6411).
  // An owner Approve already on the card keeps the landing path below: their tap wins.
  const approvedNow = link.hasVisualApproval({ comments, secret, id: issue.identifier, patch: v.patch, verdict: v.verdict, now });
  if (shippedSha && !approvedNow && !/ANSWERED by the owner/.test(issue.description || '')) return { action: 'shipped', sha: shippedSha, v, mac };
  // BRO-7495: a signed CI result that every before/after picture matched exactly counts as the approval (autoOk is decided by planAuto in main; the owner's own tap still wins).
  if (autoOk && !approvedNow) {
    if (currentPatch === null) return { action: 'land', v, mac, auto: true };
    return currentPatch === v.patch ? { action: 'land', v, mac, auto: true } : { action: 'void', why: 'the held branch no longer matches the checked change', v, mac };
  }
  if (approvedNow) {
    const approvedAt = approvalTime(comments, link.visualMarker(mac));
    if (currentPatch === null) return { action: 'land', v, mac, approvedAt };
    if (currentPatch === v.patch) return { action: 'land', v, mac, approvedAt };
    // BRO-8462: a rebase that changed only the context around the approved lines keeps the owner's yes.
    if (facts.carriedOver === true) return { action: 'land', v, mac, approvedAt, carried: true };
    return { action: 'void', why: 'the held branch no longer matches the approved change', v, mac, approvedAt };
  }
  // Age counts from the worker's own "Asked the owner" comment; a card without one never expires.
  const askedAt = (comments.nodes || []).filter((c) => /^Asked the owner to look at/.test(link.unescapeMarkdown(c.body).trim()))
    .map((c) => new Date(c.createdAt).getTime()).filter(Number.isFinite).sort((a, b) => b - a)[0];
  // Answered without an approval. BRO-8462: only an explicit Reject removes the held change. A Void (closed
  // without a tap, e.g. the owner said yes in chat) was read as a rejection and BRO-8451's approved hold was
  // deleted. A Void whose hold is already on main is tidied up; anything else keeps the hold until it is stale.
  if (/ANSWERED by the owner/.test(issue.description || '')) {
    if (has(cleanedMarker(mac))) return { action: 'skip', why: 'answered, already cleaned', v, mac };
    const answer = va.latestVisualAnswer(comments.nodes, askedAt || 0);
    if (answer && answer.kind === 'reject') return { action: 'cleanup', reason: 'rejected', v, mac };
    if (answer && answer.kind === 'void' && facts.holdSettled === true) return { action: 'cleanup', reason: 'shipped', v, mac };
    if (askedAt && now - askedAt > EXPIRE_AFTER_MS) return { action: 'cleanup', reason: 'stale', v, mac };
    return { action: 'skip', why: `answered (${answer ? answer.kind : 'no answer comment found'}) without a Reject; the held change is kept`, v, mac };
  }
  if (askedAt && now - askedAt > EXPIRE_AFTER_MS && !/ANSWERED by the owner/.test(issue.description || '')) return { action: 'expire', v, mac };
  return { action: 'wait', v, mac };
}

// BRO-6543: a description rewrite (the acceptance-criteria enricher on BRO-6517) can delete the VISUAL-APPROVAL
// block after the ask. The owner's tap is then recorded as a generic "Approved" with no signed approval, and the
// card no longer matches the lander's search, so the held change never ships. The worker's own "Asked the owner"
// comment still names the hold branch and a 12-char patch, and git still holds the rest.
const ASK_RE = /Held change: (visual-hold\/[a-z0-9][a-z0-9-]{0,60}) \(patch ([0-9a-f]{12})\)/;
function askedHold(issue) {
  const asks = ((issue.comments && issue.comments.nodes) || []).map((c) => ({ m: ASK_RE.exec(link.unescapeMarkdown(c.body)), t: new Date(c.createdAt).getTime() }))
    .filter((x) => x.m).sort((a, b) => b.t - a.t);
  return asks.length ? { hold: asks[0].m[1], patch12: asks[0].m[2], at: asks[0].t } : null;
}

/**
 * How the owner answered a card whose visual block was lost: 'approve' | 'reject' | null.
 * Only an answer comment whose ref the secret reproduces for this card's own title-level question counts
 * (workers can copy a ref string but not mint one), written after the ask.
 */
function lostBlockAnswer(issue, secret, ask) { return (lostBlockAnswerAt(issue, secret, ask) || {}).kind || null; }
function lostBlockAnswerAt(issue, secret, ask) {
  const marker = link.answerMarker(link.decisionRef(secret, issue.identifier, link.questionHash(issue.title)));
  // Residual risk: the ODA ref also appears in the "Emailed the owner" comment, so a session that writes the recorder's exact comment shape could forge this. Same-identity Linear comments cannot prove authorship; the shape check only rules out accidents.
  const c = link.markerComments(issue.comments, marker).find((x) => new Date(x.createdAt).getTime() >= ask.at && /^\*\*Owner decision\*\* \(answered by the owner through /.test(link.unescapeMarkdown(x.body).trim()));
  if (!c) return null;
  const at = new Date(c.createdAt).getTime();
  const chose = ((/^\s*Chose:\s*(.+)$/m.exec(link.unescapeMarkdown(c.body)) || [])[1] || '').trim();
  if (/^(Approved|Option A: approve)\b/i.test(chose)) return { kind: 'approve', at };
  if (/^(Rejected|Option B: reject)\b/i.test(chose)) return { kind: 'reject', at };
  return null;
}

/**
 * Pure. `facts` is what git says about the held change: {patch, evidenceSha, files, verdictRaw}.
 * Returns {restore:{lines, answer}} to put the machine lines back, or {skip:why}.
 */
function planRecovery(issue, secret, facts) {
  if (link.parseVisualApproval(issue.description)) return { skip: 'description still has the visual block' };
  const ask = askedHold(issue);
  if (!ask) return { skip: 'no ask comment' };
  if (ask.hold !== va.holdBranch(issue.identifier)) return { skip: 'ask names another card\'s hold branch' };
  if (!facts || !facts.patch || !facts.patch.startsWith(ask.patch12)) return { skip: 'the held branch no longer matches the asked patch' };
  if (!facts.evidenceSha) return { skip: 'no evidence commit' };
  let verdict;
  try { verdict = JSON.parse(facts.verdictRaw); } catch { return { skip: 'evidence has no readable verdict.json' }; }
  if (!verdict || verdict.overallPass !== true || !/^[0-9a-f]{12,64}$/.test(String(verdict.contentHash || ''))) return { skip: 'the evidence verdict did not pass' };
  const found = lostBlockAnswerAt(issue, secret, ask);
  const answer = found && found.kind;
  // Unanswered: leave the card alone so the owner's later generic tap is still seen here (a restored line would hide it).
  if (!answer) return { skip: 'the owner has not answered yet' };
  // What the owner saw is what existed when they tapped: a hold or evidence branch pushed after the tap cannot ship on that tap.
  if (!(facts.holdTime <= found.at) || !(facts.evidenceTime <= found.at)) return { skip: 'the held branch or its screenshots changed after the owner answered' };
  // Thumbnails (thumb_*.jpg) are what the card shows; the full-size shots beside them are only for linking.
  const shots = (facts.files || []).filter((f) => /\.(png|jpe?g)$/i.test(f));
  const evidence = (shots.some((f) => /^thumb_/.test(f)) ? shots.filter((f) => /^thumb_/.test(f)) : shots).slice(0, va.MAX_CROPS)
    .map((f) => `Evidence: ${va.labelFor(f)} | https://raw.githubusercontent.com/${va.REPO}/${facts.evidenceSha}/${f}`);
  const lines = [...evidence, `VISUAL-APPROVAL: patch=${facts.patch} verdict=${verdict.contentHash} hold=${ask.hold}`];
  lines.unshift(link.ANSWERED_LINE);
  return { restore: { lines, answer, patch: facts.patch, verdict: verdict.contentHash, hold: ask.hold } };
}

const QUERY = `query($teamKey: String!, $after: String) {
  issues(first: 50, after: $after, filter: { team: { key: { eq: $teamKey } }, state: { type: { nin: ${JSON.stringify(TERMINAL_STATE_TYPES)} } }, or: [{ description: { contains: "VISUAL-APPROVAL" } }, { comments: { some: { body: { contains: "Held change: visual-hold/" } } } }] }) {
    pageInfo { hasNextPage endCursor }
    nodes { identifier description createdAt comments(first: 100) { nodes { id body createdAt } } }
  }
}`;

async function fetchOpenIssues(linear) {
  const out = [];
  let after = null;
  for (let page = 0; page < 20; page++) {
    const data = await linear.graphql(QUERY, { teamKey: linear.TEAM_KEY, after });
    out.push(...data.issues.nodes);
    if (!data.issues.pageInfo.hasNextPage) return out;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error('too many cards; refusing to act on a partial list');
}

/** Reads the held change from git, then puts the lost machine lines (and, for an owner Approve, the signed approval) back on the card. True when the card can be planned this pass. */
async function restoreLostBlock(issue, secret, linear, dryRun, comment) {
  const ask = askedHold(issue);
  if (!ask || !lostBlockAnswer(issue, secret, ask)) return false; // nothing to recover: skip the git fetches
  const hold = va.holdBranch(issue.identifier);
  const ev = va.evidenceBranch(issue.identifier);
  const facts = { patch: null, evidenceSha: null, files: [], verdictRaw: '', holdTime: Infinity, evidenceTime: Infinity };
  try {
    va.git(['fetch', '--quiet', 'origin', 'main', `+refs/heads/${hold}:refs/remotes/origin/${hold}`]);
    va.git(['fetch', '--quiet', 'origin', `+refs/heads/${ev}:refs/remotes/origin/${ev}`]);
    facts.holdTime = Number(va.git(['log', '-1', '--format=%ct', `origin/${hold}`])) * 1000;
    facts.patch = va.patchId('origin/main', `origin/${hold}`);
    facts.evidenceSha = va.git(['rev-parse', `origin/${ev}`]);
    facts.evidenceTime = Number(va.git(['log', '-1', '--format=%ct', facts.evidenceSha])) * 1000;
    facts.files = va.git(['ls-tree', '-r', '--name-only', facts.evidenceSha]).split('\n').filter(Boolean);
    facts.verdictRaw = va.git(['show', `${facts.evidenceSha}:verdict.json`]);
  } catch (e) { throw new Error(`the owner answered but the held branch or screenshots could not be read: ${String(e.message).split('\n')[0]}`); }
  const plan = planRecovery(issue, secret, facts);
  if (!plan.restore) { console.log(`[visual-land] ${issue.identifier}: lost visual block, not restoring (${plan.skip})`); return false; }
  const r = plan.restore;
  console.log(`[visual-land] ${issue.identifier}: visual block was deleted from the description; ${dryRun ? 'would restore' : 'restoring'} it (owner answer: ${r.answer})`);
  if (dryRun) return false;
  const row = await linear.getIssue(issue.identifier);
  // Signed approval first: a crash between the two writes then repeats the whole restore next pass (the card still lacks the line) instead of leaving a line with no approval.
  if (r.answer === 'approve') {
    const signed = `Visual change approved by the owner. The lander will ship the held change (${r.hold}).\n\n${link.visualMarker(link.visualMac(secret, issue.identifier, r.patch, r.verdict))}`;
    await linear.createComment(row.id, signed);
    issue.comments.nodes.push({ id: 'restored', body: signed, createdAt: new Date().toISOString() });
  }
  const body = `${String(row.description || '').trimEnd()}\n\n${r.lines.join('\n')}\n`;
  await linear.updateIssue(row.id, { description: body });
  issue.description = body;
  return true;
}

/**
 * BRO-7495: may this card ship without asking the owner? Reads git for the facts planAuto needs.
 * Every doubt (flag off, no signed CI result, a read failing) returns {auto:false}.
 */
function autoDecision(issue, secret, env = process.env, now = Date.now()) {
  if (!vci.autoShipOn(env, now)) return { auto: false, why: 'auto-ship is off' };
  const v = link.parseVisualApproval(issue.description);
  if (!v) return { auto: false, why: 'no visual approval line' };
  const nodes = (issue.comments && issue.comments.nodes) || [];
  const ci = vci.findCiResult(nodes, secret, issue.identifier, v.patch, now);
  if (!ci || ci.outcome !== 'identical') return vci.planAuto({ ci, flagOn: true, emailed: false, rejected: false, holdFiles: [], driftFiles: [] });
  const emailed = nodes.some((c) => /Decision email ref\s*ODE/i.test(link.unescapeMarkdown(c.body || '')));
  const rejected = /ANSWERED by the owner/.test(issue.description || '');
  let holdFiles = null; let driftFiles = null;
  try {
    const hb = va.holdBranch(issue.identifier);
    va.git(['fetch', '--quiet', 'origin', 'main', `+refs/heads/${hb}:refs/remotes/origin/${hb}`]);
    holdFiles = va.git(['diff', '--name-only', `origin/main...origin/${hb}`]).split('\n').filter(Boolean);
    driftFiles = va.git(['diff', '--name-only', ci.base, 'origin/main']).split('\n').filter(Boolean);
  } catch { /* planAuto treats unreadable git as not auto */ }
  return vci.planAuto({ ci, flagOn: true, emailed, rejected, holdFiles, driftFiles });
}

/** BRO-8462: git half of carryOverOk. Any git failure (orphan evidence commit from an older ask, fetch error) = no carry-over. */
function approvedTipMatches(issue, v, holdRef) {
  try {
    const sha = va.evidenceSha(issue.description);
    if (!sha) return false;
    try { va.git(['fetch', '--quiet', 'origin', `+refs/heads/${va.evidenceBranch(issue.identifier)}:refs/remotes/origin/${va.evidenceBranch(issue.identifier)}`]); } catch { /* try the sha */ }
    try { va.git(['cat-file', '-e', `${sha}^{commit}`]); } catch { va.git(['fetch', '--quiet', 'origin', sha]); }
    const tip = va.git(['rev-parse', '--verify', '--quiet', `${sha}^1`]);
    if (!/^[0-9a-f]{40}$/.test(tip)) return false;
    const ok = carryOverOk({ signedPatch: v.patch, approvedTipPatch: va.patchId('origin/main', tip), approvedSig: va.changeSignature('origin/main', tip), currentSig: va.changeSignature('origin/main', holdRef) });
    console.log(`[visual-land] ${issue.identifier}: rebased hold ${ok ? 'changes the same lines as' : 'differs from'} the approved tip ${tip.slice(0, 10)}`);
    return ok;
  } catch { return false; }
}

async function main(argv = process.argv.slice(2)) {
  if (hasHelpFlag(argv)) { console.log(USAGE); return 0; }
  const dryRun = argv.includes('--dry-run');
  const secret = process.env.APPROVAL_HMAC_SECRET;
  if (!secret) { console.error('[visual-land] APPROVAL_HMAC_SECRET is not set'); return dryRun ? 0 : 3; }
  const linear = require('./lib/linear-client.js');
  let issues;
  try { issues = (await fetchOpenIssues(linear)).filter((i) => link.parseVisualApproval(i.description) || askedHold(i)); } catch (e) { console.error(`[visual-land] could not read Linear: ${e.message}`); return 3; }
  console.log(`[visual-land] ${issues.length} card(s) with a visual approval line`);
  const comment = async (issue, body) => {
    const row = await linear.getIssue(issue.identifier);
    await linear.createComment(row.id, body);
  };
  let failures = 0;
  for (const issue of issues) {
    if (!link.parseVisualApproval(issue.description)) {
      try { if (!(await restoreLostBlock(issue, secret, linear, dryRun, comment))) continue; } catch (e) { failures++; console.error(`[visual-land] ${issue.identifier}: could not restore the visual block: ${e.message}`); continue; }
    }
    let shippedSha = null;
    // A VISUAL-OK prefix is on every UI commit, so a match alone proves nothing: the held change must also be gone from the hold branch (deleted, or no diff left against main).
    let holdSettled = false;
    try {
      const hb = va.holdBranch(issue.identifier);
      try { va.git(['fetch', '--quiet', 'origin', 'main', `+refs/heads/${hb}:refs/remotes/origin/${hb}`]); holdSettled = va.holdSettled({ fetchOk: true, patchIdValue: va.patchId('origin/main', `origin/${hb}`) }); } catch { holdSettled = va.holdSettled({ fetchOk: false }); }
    } catch { holdSettled = false; }
    try { if (holdSettled) shippedSha = shippedVisualCommit(va.git(['log', 'origin/main', `--since=@${Math.floor(askedSince(issue) / 1000)}`, '--format=%H%x09%s']), issue.identifier); } catch (e) { console.error(`[visual-land] ${issue.identifier}: could not read main history: ${e.message}`); }
    const autoNow = autoDecision(issue, secret);
    if (autoNow.auto) console.log(`[visual-land] ${issue.identifier}: auto-ship allowed (${autoNow.why})`);
    // BRO-8462: an answered Void tidies up only when its change is really on main (a landed hold keeps its own commits).
    let voidSettled = holdSettled;
    if (!voidSettled && /ANSWERED by the owner/.test(issue.description || '')) { try { voidSettled = va.changeOnMain(`origin/${va.holdBranch(issue.identifier)}`); } catch { voidSettled = false; } }
    const first = planCard(issue, secret, Date.now(), null, shippedSha, autoNow.auto, { holdSettled: voidSettled });
    if (first.action === 'skip' || first.action === 'wait') { console.log(`[visual-land] ${issue.identifier}: ${first.action}${first.why ? ` (${first.why})` : ''}`); continue; }
    const { v, mac } = first;
    const hold = va.holdBranch(issue.identifier);
    try {
      if (first.action === 'land') {
        if (v.hold !== hold) throw new Error(`hold branch ${v.hold} does not belong to ${issue.identifier}`);
        va.git(['fetch', '--quiet', 'origin', 'main', `+refs/heads/${hold}:refs/remotes/origin/${hold}`]);
        const current = va.patchId('origin/main', `origin/${hold}`);
        const carriedOver = current !== v.patch && !first.auto && approvedTipMatches(issue, v, `origin/${hold}`);
        const plan = planCard(issue, secret, Date.now(), current, null, first.auto === true, { holdSettled: voidSettled, carriedOver });
        const stuck = async (why, marker) => {
          console.log(`[visual-land] ${issue.identifier}: not shipping (${why})`);
          const told = (issue.comments.nodes || []).some((c) => link.bodyHasMarker(c.body, marker));
          if (!dryRun && !told) await comment(issue, `The owner approved a change, but it was not shipped: ${why}. A worker needs to fix ${hold} or its screenshots, or ask again with node scripts/visual-approval.js request.\n\n${marker}`);
          if (!dryRun && isStale(plan.approvedAt) && !(issue.comments.nodes || []).some((c) => link.bodyHasMarker(c.body, staleMarker(mac)))) {
            await comment(issue, `The owner approved this more than ${STALE_APPROVAL_MS / 60000} minutes ago and it is still not live (${why}). It needs a worker to fix it.\n\n${staleMarker(mac)}`);
          }
        };
        if (plan.action === 'void') {
          await stuck(plan.why, voidMarker(mac, current));
          continue;
        }
        // The approval binds the verdict's hash; re-read the file at the evidence commit the owner's email showed, so a re-pushed branch or a failed check cannot ship.
        const sha = va.evidenceSha(issue.description);
        let rawVerdict = '';
        if (sha) {
          // A failed fetch is transient (counted as a failure, no card comment); a commit without a readable verdict.json is a real "unverified".
          try { va.git(['fetch', '--quiet', 'origin', `+refs/heads/${va.evidenceBranch(issue.identifier)}:refs/remotes/origin/${va.evidenceBranch(issue.identifier)}`]); } catch { /* branch gone: try the sha itself */ }
          try { va.git(['cat-file', '-e', `${sha}^{commit}`]); } catch { try { va.git(['fetch', '--quiet', 'origin', sha]); } catch (e) { throw new Error(`could not fetch evidence commit ${sha}: ${e.message}`); } }
          try { rawVerdict = va.git(['show', `${sha}:verdict.json`]); } catch { rawVerdict = ''; }
        }
        const verdictCheck = sha ? va.checkVerdict(rawVerdict, v.verdict) : { ok: false, why: 'the card names no evidence commit' };
        if (!verdictCheck.ok) { await stuck(verdictCheck.why, unverifiedMarker(mac, sha)); continue; }
        const landRef = `land/${issue.identifier.toLowerCase()}-visual`;
        console.log(`[visual-land] ${issue.identifier}: approved, ${dryRun ? 'would push' : 'pushing'} origin/${hold} -> ${landRef}`);
        if (dryRun) continue;
        va.git(['push', 'origin', `refs/remotes/origin/${hold}:refs/heads/${landRef}`]);
        if (first.auto) {
          // Auto path: the before/after check matched exactly. Record it, ship it, then close the ask so it is never emailed.
          await comment(issue, `Auto-shipped (pixel-identical): every before/after picture matched exactly, so no owner approval was needed. Pushed the held change to ${landRef}; land.yml gates and ships it. Check the Land run and prod before closing this card.\n\n${autoMarker(mac)}\n${landedMarker(mac)}`);
          const ask = link.markerLines(issue.description).find((m) => link.visualBindingFor(issue.description, m.question));
          if (ask) {
            const out = await link.recordAnswer({ graphql: linear.graphql, id: issue.identifier, hash: link.questionHash(ask.question), secret, choiceKey: 'void', allowVoid: true, via: 'the lander: the before/after check matched exactly', text: 'Auto-shipped because every before/after picture matched exactly; nothing left to ask.' });
            console.log(`[visual-land] ${issue.identifier}: ask ${out.status}`);
          }
        } else {
          await comment(issue, `Owner approved. Pushed the held change to ${landRef}; land.yml gates and ships it. Check the Land run and prod before closing this card.\n\n${landedMarker(mac)}`);
        }
      } else if (first.action === 'shipped') {
        console.log(`[visual-land] ${issue.identifier}: shipped as VISUAL-OK ${first.sha.slice(0, 11)}, ${dryRun ? 'would void' : 'voiding'} the ask`);
        if (dryRun) continue;
        const ask = link.markerLines(issue.description).find((m) => link.visualBindingFor(issue.description, m.question));
        if (!ask) { console.log(`[visual-land] ${issue.identifier}: no visual question on the card, nothing to void`); continue; }
        const out = await link.recordAnswer({ graphql: linear.graphql, id: issue.identifier, hash: link.questionHash(ask.question), secret, choiceKey: 'void', allowVoid: true, via: `the lander: the change shipped as VISUAL-OK ${first.sha.slice(0, 11)}`, text: `Shipped on main as ${first.sha}; nothing left to approve.` });
        console.log(`[visual-land] ${issue.identifier}: ${out.status}`);
        if (out.status !== 'recorded' && out.status !== 'answered') throw new Error(`void not recorded (${out.status})`);
      } else if (first.action === 'cleanup') {
        console.log(`[visual-land] ${issue.identifier}: cleanup (${first.reason}), removing ${hold}`);
        if (dryRun) continue;
        for (const ref of [hold, va.evidenceBranch(issue.identifier)]) { try { va.git(['push', 'origin', `:refs/heads/${ref}`]); } catch { /* already gone */ } }
        const why = {
          rejected: 'The owner did not approve this change, so the held branch and screenshots were removed.',
          shipped: 'The held change is already on main, so the held branch and screenshots were removed.',
          stale: 'This ask was answered without an approval more than 14 days ago, so the held branch and screenshots were removed.',
        }[first.reason] || 'The held branch and screenshots were removed.';
        await comment(issue, `${why}\n\n${cleanedMarker(mac)}`);
      } else if (first.action === 'expire') {
        console.log(`[visual-land] ${issue.identifier}: expired`);
        if (dryRun) continue;
        for (const ref of [hold, va.evidenceBranch(issue.identifier)]) { try { va.git(['push', 'origin', `:refs/heads/${ref}`]); } catch { /* already gone */ } }
        const row = (await linear.graphql('query($id: String!) { issue(id: $id) { id team { states { nodes { id name } } } } }', { id: issue.identifier })).issue;
        const todo = ((row.team && row.team.states && row.team.states.nodes) || []).find((s) => /^todo$/i.test(s.name));
        await linear.createComment(row.id, `Nobody answered this visual approval within 14 days, so the held change was removed. The card is back in the queue; redo the work and ask again.\n\n${expiredMarker(mac)}`);
        if (todo) await linear.updateIssue(row.id, { stateId: todo.id });
      }
    } catch (e) { failures++; console.error(`[visual-land] ${issue.identifier}: ${e.message}`); }
  }
  return failures ? 1 : 0;
}

if (require.main === module) {
  main().then((c) => { process.exitCode = c; }, (e) => { console.error(`[visual-land] ${e.stack || e.message}`); process.exitCode = 3; });
}
module.exports = { carryOverOk, approvedTipMatches, autoDecision, autoMarker, planRecovery, askedHold, lostBlockAnswer, planCard, shippedVisualCommit, askedSince, main, landedMarker, expiredMarker, voidMarker, unverifiedMarker, staleMarker, isStale, approvalTime };
