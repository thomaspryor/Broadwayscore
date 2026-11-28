// BRO-8462: the owner said Yes to BRO-8451's held visual change and was asked again, three ways:
//   1. record-owner-answer.js saved the chat "Yes" as Void ("shipped another way") though nothing had shipped;
//   2. the lander then read that Void as a rejection and deleted the held branch ("The owner did not approve");
//   3. a rebase (a conflict fixed next to the change) gave a new patch id, so the approval no longer matched.
// Each block below fails with its fix reverted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const link = require('../../src/lib/owner-decision-link.js');
const va = require('../../scripts/lib/visual-approval.js');
const land = require('../../scripts/visual-approval-land.js');
const roa = require('../../scripts/record-owner-answer.js');

const S = 'test-secret';
const ID = 'BRO-8451';
const PATCH = 'a'.repeat(40);
const VERDICT = 'b'.repeat(16);
const EV = `https://raw.githubusercontent.com/thomaspryor/Broadwayscore/${'c'.repeat(40)}/home.png`;
const block = () => va.buildBlock({ what: 'the AU gold badge', patch: PATCH, verdict: VERDICT, hold: 'visual-hold/bro-8451', evidence: [{ label: 'Home', url: EV }], summary: 'ok' });
const ANSWERED = (d) => `${d}\n${'ANSWERED by the owner (see the "Owner decision" comment on this card).'}`;
const ASK_AT = Date.parse('2026-11-28T19:19:42Z');
const at = (ms) => new Date(ms).toISOString();
const ask = { id: 'ask', body: 'Asked the owner to look at 3 screenshot(s). Held change: visual-hold/bro-8451 (patch 84b034e701de). It ships by itself after Approve.', createdAt: at(ASK_AT) };
// The real BRO-8451 comment shape written by recordAnswer through record-owner-answer.yml.
const decision = (chose, quote, ms = ASK_AT + 40 * 60e3, how = 'closed without an owner tap') => ({
  id: `d-${chose}`, createdAt: at(ms),
  body: `**Owner decision** (${how} through a chat with Claude (recorded by https://github.com/thomaspryor/Broadwayscore/actions/runs/1), 2026-11-28 UTC)\n\nChose: ${chose}\n\n> ${quote}\n\nDecision ref ODAfc627497e35e3bfa`,
});
const VOID = 'Void: the change shipped another way, nothing to approve';
const card = (comments, description = ANSWERED(block())) => ({ identifier: ID, description, comments: { nodes: comments } });

// ── 1. record-owner-answer: a Void while the hold still has unshipped code is refused ──────────────────────
const visualIssue = { identifier: ID, title: 't', description: block(), labels: { nodes: [] } };

test('fix 1: Void is refused while the held change is not on main; a yes is told to land it, not void it', () => {
  const yes = roa.resolveDecision(visualIssue, 'void', { holdSettled: false, affirmative: true });
  assert.ok(yes.error, 'an unshipped hold must not be voided');
  assert.match(yes.error, /read as a yes/);
  assert.match(yes.error, /land\/bro-8451-visual/);
  assert.ok(roa.resolveDecision(visualIssue, 'void', { holdSettled: false, affirmative: false }).error);
  // Shipped (or hold gone): Void is the right record. Unknown (the CI --execute run) keeps the old path.
  assert.equal(roa.resolveDecision(visualIssue, 'void', { holdSettled: true }).error, undefined);
  assert.equal(roa.resolveDecision(visualIssue, 'void', {}).error, undefined);
});

test('fix 1: voidFacts reads the hold from git; a gone hold is settled, a git error refuses', async () => {
  const yes = 'Yes';
  const nope = () => { throw new Error('not reached'); };
  // Hold gone, the owner said something other than yes: nothing left to ship, Void is fine.
  assert.deepEqual(await roa.voidFacts(visualIssue, 'never mind', { git: () => '', changeOnMain: nope }), { holdSettled: true, affirmative: false });
  // BRO-8451 exactly: hold deleted by the wrong cleanup, owner said Yes, nothing for the card on main.
  const lost = await roa.voidFacts(visualIssue, yes, { git: (a) => (a[0] === 'log' ? 'BRO-8450: other work\n' : ''), changeOnMain: nope });
  assert.deepEqual(lost, { holdSettled: false, holdGone: true, affirmative: true });
  assert.match(roa.resolveDecision(visualIssue, 'void', lost).error, /is gone and nothing for BRO-8451 is on main/);
  const shippedElsewhere = await roa.voidFacts(visualIssue, yes, { git: (a) => (a[0] === 'log' ? 'BRO-8451: AU gold threshold\n' : ''), changeOnMain: nope });
  assert.equal(shippedElsewhere.holdSettled, true);
  assert.equal((await roa.voidFacts(visualIssue, yes, { git: (a) => (a[0] === 'log' ? 'BRO-84512: other\n' : ''), changeOnMain: nope })).holdSettled, false, 'BRO-84512 is not BRO-8451');
  const held = await roa.voidFacts(visualIssue, yes, { git: (a) => (a[0] === 'ls-remote' ? 'abc\trefs/heads/visual-hold/bro-8451' : ''), changeOnMain: () => false });
  assert.deepEqual(held, { holdSettled: false, affirmative: true });
  const landed = await roa.voidFacts(visualIssue, 'not now', { git: (a) => (a[0] === 'ls-remote' ? 'abc\trefs/heads/visual-hold/bro-8451' : ''), changeOnMain: () => true });
  assert.deepEqual(landed, { holdSettled: true, affirmative: false });
  const broken = await roa.voidFacts(visualIssue, yes, { git: () => { throw new Error('network down'); }, changeOnMain: () => true });
  assert.match(broken.error, /network down/);
});

// ── 2. the lander: only an explicit Reject deletes a held change ─────────────────────────────────────────────
test('fix 2: BRO-8451 replay, a recorded Void is never cleaned up as a rejection while the hold is unshipped', () => {
  const plan = land.planCard(card([ask, decision(VOID, 'Yes')]), S, ASK_AT + 76 * 60e3, null, null, false, { holdSettled: false });
  assert.equal(plan.action, 'skip');
  assert.match(plan.why, /without a Reject/);
  // Same for the owner's own words and for an answer comment the lander cannot find.
  assert.equal(land.planCard(card([ask, decision('Own words', 'make it gold', undefined, 'answered by the owner')]), S, ASK_AT + 3600e3).action, 'skip');
  assert.equal(land.planCard(card([ask]), S, ASK_AT + 3600e3).action, 'skip');
});

test('fix 2: Reject cleans up with the rejection note; a shipped Void cleans up neutrally; nothing else ever does', () => {
  const rej = land.planCard(card([ask, decision('Option B: reject', 'no', undefined, 'answered by the owner')]), S, ASK_AT + 3600e3);
  assert.equal(rej.action, 'cleanup');
  assert.equal(rej.reason, 'rejected');
  const shipped = land.planCard(card([ask, decision(VOID, 'Yes')]), S, ASK_AT + 3600e3, null, null, false, { holdSettled: true });
  assert.deepEqual([shipped.action, shipped.reason], ['cleanup', 'shipped']);
  // An unshipped Void never ages into a deletion (the owner's chat yes would be lost on day 14).
  const old = land.planCard(card([ask, decision(VOID, 'Yes')]), S, ASK_AT + 400 * 24 * 3600e3, null, null, false, { holdSettled: false });
  assert.equal(old.action, 'skip');
  // A Void recorded for an OLDER ask is not this ask's answer.
  const older = land.planCard(card([decision('Option B: reject', 'no', ASK_AT - 1000, 'answered by the owner'), ask]), S, ASK_AT + 3600e3);
  assert.equal(older.action, 'skip');
});

test('fix 2: status reads a Void as void and own words as answered, never as rejected', () => {
  assert.equal(va.classifyStatus(ANSWERED(block()), [ask, decision(VOID, 'Yes')]), 'void');
  assert.equal(va.classifyStatus(ANSWERED(block()), [ask, decision('make the badge bigger', 'bigger', undefined, 'answered by the owner')]), 'answered');
  assert.equal(va.classifyStatus(ANSWERED(block()), [ask, decision('Option B: reject', 'no', undefined, 'answered by the owner')]), 'rejected');
  // Own words that start "Approved" carry no signature: answered, not rejected. No decision comment: answered.
  assert.equal(va.classifyStatus(ANSWERED(block()), [ask, decision('Approved', 'yes', undefined, 'answered by the owner')]), 'answered');
  assert.equal(va.classifyStatus(ANSWERED(block()), [ask]), 'answered');
  assert.equal(va.answerKind(VOID), 'void');
  assert.equal(va.answerKind('Rejected'), 'reject');
  assert.equal(va.answerKind('Option A: approve'), 'approve');
});

// ── 3. an approval survives a rebase that changed only context ───────────────────────────────────────────────
function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bro8462-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@x', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@x' } }).trim();
  const write = (f, t) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); };
  g('init', '-q', '-b', 'main');
  write('src/page.tsx', ['export default function P() {', '  return (', '    <div>', '      <h1>Title</h1>', '      <p>Body</p>', '    </div>', '  );', '}', ''].join('\n'));
  write('scripts/x.js', 'module.exports = 1;\n');
  g('add', '-A'); g('commit', '-qm', 'base');
  return { dir, g, write };
}

test('fix 3: changeSignature ignores moved context, sees any edited line in any file; carryOverOk needs the signed patch', () => {
  const { dir, g, write } = repo();
  g('checkout', '-qb', 'hold');
  write('src/page.tsx', fs.readFileSync(path.join(dir, 'src/page.tsx'), 'utf8').replace('      <p>Body</p>\n', '      <p>Body</p>\n      <span className="gold">AU</span>\n'));
  g('commit', '-qam', 'gold badge');
  const approvedTip = g('rev-parse', 'HEAD');
  const signed = va.patchId('main', approvedTip, dir);
  // main moves: a neighbouring line in the same file changes (the page.tsx conflict on BRO-8451).
  g('checkout', '-q', 'main');
  write('src/page.tsx', fs.readFileSync(path.join(dir, 'src/page.tsx'), 'utf8').replace('<p>Body</p>', '<p>Body text</p>'));
  g('commit', '-qam', 'main moves');
  g('checkout', '-qb', 'rebased');
  write('src/page.tsx', fs.readFileSync(path.join(dir, 'src/page.tsx'), 'utf8').replace('      <p>Body text</p>\n', '      <p>Body text</p>\n      <span className="gold">AU</span>\n'));
  g('commit', '-qam', 'gold badge (rebased)');
  const rebased = g('rev-parse', 'HEAD');
  assert.notEqual(va.patchId('main', rebased, dir), signed, 'the rebase changes the patch id (why the owner was asked again)');
  const approvedSig = va.changeSignature('main', approvedTip, dir);
  assert.equal(va.changeSignature('main', rebased, dir), approvedSig, 'same added line, only context moved');
  assert.equal(land.carryOverOk({ signedPatch: signed, approvedTipPatch: va.patchId('main', approvedTip, dir), approvedSig, currentSig: va.changeSignature('main', rebased, dir) }), true);
  // A rebase that also slips in a non-UI edit does not carry the approval.
  write('scripts/x.js', 'module.exports = 2;\n');
  g('commit', '-qam', 'sneak');
  assert.notEqual(va.changeSignature('main', 'HEAD', dir), approvedSig);
  // An evidence parent that is not the signed patch does not count.
  assert.equal(land.carryOverOk({ signedPatch: 'f'.repeat(40), approvedTipPatch: signed, approvedSig, currentSig: approvedSig }), false);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test('fix 3: a carried-over approval lands; without it the old "no longer matches" stop stands', () => {
  const mac = link.visualMac(S, ID, PATCH, VERDICT);
  const approved = { id: 'a', body: link.visualMarker(mac), createdAt: at(ASK_AT + 60e3) };
  const c = card([ask, approved], block());
  const now = ASK_AT + 120e3;
  const carried = land.planCard(c, S, now, 'e'.repeat(40), null, false, { carriedOver: true });
  assert.equal(carried.action, 'land');
  assert.equal(carried.carried, true);
  assert.equal(land.planCard(c, S, now, 'e'.repeat(40), null, false, { carriedOver: false }).action, 'void');
});

test('fix 3: the evidence commit keeps the approved tip as its parent; changeOnMain sees a landed (rebased) hold', () => {
  const { dir, g, write } = repo();
  g('checkout', '-qb', 'hold');
  write('src/page.tsx', fs.readFileSync(path.join(dir, 'src/page.tsx'), 'utf8').replace('<h1>Title</h1>', '<h1 className="gold">Title</h1>'));
  g('commit', '-qam', 'gold');
  const tip = g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(dir, 'shot.png'), 'png');
  const ev = va.buildEvidenceCommit([{ name: 'shot.png', abs: path.join(dir, 'shot.png') }], dir, 'Visual evidence', tip);
  assert.equal(g('rev-parse', `${ev}^1`), tip);
  assert.equal(va.changeOnMain('hold', dir, 'main'), false, 'not landed yet');
  // land.yml rebases: main gets an equivalent commit after another change, the hold keeps its own commit.
  g('checkout', '-q', 'main');
  write('scripts/x.js', 'module.exports = 3;\n'); g('commit', '-qam', 'other');
  write('src/page.tsx', fs.readFileSync(path.join(dir, 'src/page.tsx'), 'utf8').replace('<h1>Title</h1>', '<h1 className="gold">Title</h1>'));
  g('commit', '-qam', 'gold (landed)');
  assert.notEqual(va.patchId('main', 'hold', dir), null, 'the plain patch check still sees a diff after landing');
  assert.equal(va.changeOnMain('hold', dir, 'main'), true);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

// ── review follow-ups (ship-check) ───────────────────────────────────────────────────────────────────────────
test('fix 2: a failed git call never reads as "already on main" for a Void cleanup; a gone hold does', () => {
  assert.equal(land.voidHoldSettled(ID, { git: () => { throw new Error('network down'); }, changeOnMain: () => true }), false);
  assert.equal(land.voidHoldSettled(ID, { git: (a) => (a[0] === 'ls-remote' ? 'abc\trefs/heads/visual-hold/bro-8451' : (() => { throw new Error('fetch failed'); })()), changeOnMain: () => true }), false);
  assert.equal(land.voidHoldSettled(ID, { git: () => '', changeOnMain: () => { throw new Error('not reached'); } }), true);
  assert.equal(land.voidHoldSettled(ID, { git: (a) => (a[0] === 'ls-remote' ? 'abc\trefs/heads/visual-hold/bro-8451' : ''), changeOnMain: () => false }), false);
});

test('fix 2: removing a held change leases on the commit this run read; a moved hold (a new ask) is kept', () => {
  const calls = [];
  const issue = { identifier: ID, description: block() };
  const moved = land.removeHeld(issue, 'a'.repeat(40), { git: (a) => { calls.push(a.join(' ')); if (a[0] === 'push') throw new Error('stale info'); return 'def\trefs/heads/visual-hold/bro-8451'; } });
  assert.equal(moved, false);
  assert.match(calls[0], /--force-with-lease=refs\/heads\/visual-hold\/bro-8451:a{40}/);
  assert.ok(!calls.some((c) => /visual-evidence/.test(c)), 'evidence kept when the hold moved');
  const ok = []; assert.equal(land.removeHeld(issue, 'a'.repeat(40), { git: (a) => { ok.push(a.join(' ')); return ''; } }), true);
  assert.equal(ok.filter((c) => c.startsWith('push')).length, 2);
});

test('fix 1: the CI --execute run and the session both go through decide(), so a direct dispatch cannot void an unshipped hold', async () => {
  const r = await roa.decide(visualIssue, 'void', 'Yes', { git: (a) => (a[0] === 'ls-remote' ? 'abc\trefs/heads/visual-hold/bro-8451' : ''), changeOnMain: () => false });
  assert.ok(r.error);
  assert.match(roa.execute.toString(), /await decide\(/, 'execute must call decide');
  const broken = await roa.decide(visualIssue, 'void', 'Yes', { git: () => { throw new Error('network down'); } });
  assert.match(broken.error, /could not check/);
});

test('fix 3: a line moved into another function, or a whitespace edit inside a line, is a different change', () => {
  const sig = (body) => va.changeSignatureOfDiff(`diff --git a/src/p.tsx b/src/p.tsx\n--- a/src/p.tsx\n+++ b/src/p.tsx\n${body}`);
  const base = sig('@@ -10,0 +11 @@ function Header() {\n+  <span className="gold">AU</span>\n');
  assert.equal(sig('@@ -40,0 +44 @@ function Header() {\n+  <span className="gold">AU</span>\n'), base, 'line numbers moved only');
  assert.notEqual(sig('@@ -40,0 +44 @@ function Footer() {\n+  <span className="gold">AU</span>\n'), base, 'moved into another function');
  assert.notEqual(sig('@@ -10,0 +11 @@ function Header() {\n+  <span className="gold  big">AU</span>\n'), sig('@@ -10,0 +11 @@ function Header() {\n+  <span className="gold big">AU</span>\n'), 'whitespace in a class string');
});

// ── 4. one ask per card: a new tip with the same lines reuses the ask already on the card ───────────────────
const DAY = 24 * 3600e3;
test('one ask per card: an open ask or an unshipped approval is reused; a Reject, a shipped change or a near-expiry ask asks again', () => {
  const now = ASK_AT + DAY;
  assert.equal(va.reuseExistingAsk({ state: 'waiting', approvedOnCard: false, askedAt: ASK_AT, now }), 'open-ask');
  assert.equal(va.reuseExistingAsk({ state: 'waiting', approvedOnCard: false, askedAt: ASK_AT, now: ASK_AT + 13 * DAY }), null, 'about to expire');
  assert.equal(va.reuseExistingAsk({ state: 'waiting', approvedOnCard: false, askedAt: 0, now }), null, 'no ask comment');
  assert.equal(va.reuseExistingAsk({ state: 'approved', approvedOnCard: true, askedAt: ASK_AT, now }), 'approval');
  assert.equal(va.reuseExistingAsk({ state: 'void', approvedOnCard: true, askedAt: ASK_AT, now }), 'approval');
  for (const state of ['void', 'rejected', 'answered', 'landed', 'expired', 'unverified', 'none']) {
    assert.equal(va.reuseExistingAsk({ state, approvedOnCard: false, askedAt: ASK_AT, now }), null, state);
  }
  // request() decides with the lander's own rule, before it builds a new ask, and leases the hold push.
  const src = fs.readFileSync(new URL('../../scripts/visual-approval.js', import.meta.url), 'utf8');
  assert.match(src, /va\.reuseExistingAsk\(\{ state, approvedOnCard, askedAt \}\)/);
  assert.match(src, /const same = va\.carryOverOk\(/);
  assert.match(src, /--force-with-lease=refs\/heads\/\$\{hold\}/);
  assert.ok(src.indexOf('carryOverApproval({') < src.indexOf('va.buildBlock('), 'reuse check runs before a new ask is built');
  assert.equal(land.carryOverOk, va.carryOverOk, 'one shared rule');
});

test('a signed auto-ship result for an old patch never voids a moved hold under a waiting ask', () => {
  const plan = land.planCard(card([ask], block()), S, ASK_AT + 60e3, 'e'.repeat(40), null, true);
  assert.equal(plan.action, 'skip');
  assert.equal(land.planCard(card([ask], block()), S, ASK_AT + 60e3, PATCH, null, true).action, 'land');
});

test('BRO-8451 replay on real git: ask v1, rebase v2 and v3 while waiting, owner Approve ships v3, one ask total', () => {
  const { dir, g, write } = repo();
  const badge = (body) => (t) => t.replace(`      <p>${body}</p>\n`, `      <p>${body}</p>\n      <span className="gold">AU</span>\n`);
  const edit = (f, fn) => write(f, fn(fs.readFileSync(path.join(dir, f), 'utf8')));
  g('checkout', '-qb', 'v1'); edit('src/page.tsx', badge('Body')); g('commit', '-qam', 'gold');
  const v1 = g('rev-parse', 'HEAD');
  const signed = va.patchId('main', v1, dir); // the ask's block patch; the evidence commit's parent is v1
  let asks = 1;
  const tips = [];
  for (const [i, body] of [['2', 'Body two'], ['3', 'Body three']]) {
    g('checkout', '-q', 'main'); edit('src/page.tsx', (t) => t.replace(/<p>Body[^<]*<\/p>/, `<p>${body}</p>`)); g('commit', '-qam', `main moves ${i}`);
    g('checkout', '-qb', `v${i}`); edit('src/page.tsx', badge(body)); g('commit', '-qam', `gold (rebase v${i})`);
    const tip = g('rev-parse', 'HEAD'); tips.push(tip);
    assert.notEqual(va.patchId('main', tip, dir), signed, `v${i} has a new patch id`);
    const state = va.classifyStatus(block(), [ask]);
    const reuse = va.reuseExistingAsk({ state, approvedOnCard: false, askedAt: ASK_AT, now: ASK_AT + 3600e3 });
    const same = va.carryOverOk({ signedPatch: signed, approvedTipPatch: va.patchId('main', v1, dir), approvedSig: va.changeSignature('main', v1, dir), currentSig: va.changeSignature('main', tip, dir) });
    if (!(reuse && same)) asks += 1;
  }
  assert.equal(asks, 1, 'the owner is asked once');
  // The owner taps Approve on the one ask; the lander ships the latest tip (v3) through the same rule.
  const blk = va.buildBlock({ what: 'the AU gold badge', patch: signed, verdict: VERDICT, hold: 'visual-hold/bro-8451', evidence: [{ label: 'Home', url: EV }], summary: 'ok' });
  const mac = link.visualMac(S, ID, signed, VERDICT);
  const tapped = card([ask, { id: 'a', body: link.visualMarker(mac), createdAt: at(ASK_AT + 2 * 3600e3) }], blk);
  const v3 = tips[1];
  const carriedOver = land.carryOverOk({ signedPatch: signed, approvedTipPatch: va.patchId('main', v1, dir), approvedSig: va.changeSignature('main', v1, dir), currentSig: va.changeSignature('main', v3, dir) });
  const plan = land.planCard(tapped, S, ASK_AT + 3 * 3600e3, va.patchId('main', v3, dir), null, false, { carriedOver });
  assert.equal(plan.action, 'land');
  // A real design change (another line) is not carried: that one asks again.
  edit('src/page.tsx', (t) => t.replace('gold', 'gold big')); g('commit', '-qam', 'design change');
  assert.equal(va.carryOverOk({ signedPatch: signed, approvedTipPatch: va.patchId('main', v1, dir), approvedSig: va.changeSignature('main', v1, dir), currentSig: va.changeSignature('main', 'HEAD', dir) }), false);
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
