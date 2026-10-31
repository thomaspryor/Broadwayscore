// BRO-6241: visual approvals via the decision card (binding, signed approval, lander plan, real-git patch-id).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const require = createRequire(import.meta.url);
const link = require('../../src/lib/owner-decision-link.js');
const va = require('./visual-approval.js');
const { planCard } = require('../visual-approval-land.js');
const { buildDecisionEmail } = require('./owner-decision-email.js');

const S = 'test-secret';
const PATCH = 'a'.repeat(40);
const VERDICT = 'b'.repeat(16);
const EV = 'https://raw.githubusercontent.com/thomaspryor/Broadwayscore/visual-evidence/bro-7/home.png';

const block = () => va.buildBlock({ what: 'the home page header', patch: PATCH, verdict: VERDICT, hold: 'visual-hold/bro-7', evidence: [{ label: 'Home', url: EV }], summary: 'no overflow found' });

test('buildBlock parses back: question carries the binding, evidence and machine line survive', () => {
  const d = block();
  const q = link.markerLines(d)[0].question;
  assert.match(q, /^Does the change to the home page header look right\? \(ref [0-9a-f]{32}\)$/);
  assert.deepEqual(link.parseVisualApproval(d), { patch: PATCH, verdict: VERDICT, hold: 'visual-hold/bro-7' });
  assert.ok(link.visualBindingFor(d, q));
  const b = link.parseDecisionBlock(d);
  assert.equal(b.options.length, 2);
  assert.deepEqual(b.evidence, [{ label: 'Home', url: EV }]);
  assert.equal(b.defaultText, 'Nothing ships; the change waits.');
});

test('binding: swapping the machine line (different patch) breaks it, as does a doctored question tag', () => {
  const d = block();
  const q = link.markerLines(d)[0].question;
  const swapped = d.replace(PATCH, 'c'.repeat(40));
  assert.equal(link.visualBindingFor(swapped, q), null);
  assert.equal(link.visualBindingFor(d, q.replace(/\w\)$/, '0)')), null);
  assert.equal(link.visualBindingFor('no machine line here', q), null);
});

test('evidence: only this repo on raw.githubusercontent.com images, capped, no traversal', () => {
  const ok = 'https://raw.githubusercontent.com/thomaspryor/Broadwayscore/x/a.png';
  const machine = `VISUAL-APPROVAL: patch=${PATCH} verdict=${VERDICT} hold=visual-hold/bro-7`;
  const d = [machine, `Evidence: a | ${ok}`, 'Evidence: b | https://evil.example/a.png', 'Evidence: c | https://raw.githubusercontent.com/other/repo/x/a.png',
    'Evidence: d | https://raw.githubusercontent.com/thomaspryor/Broadwayscore/x/../../a.png', 'Evidence: e | javascript:alert(1)'].join('\n');
  assert.deepEqual(link.parseDecisionBlock(d).evidence.map((e) => e.url), [ok]);
  const many = [machine, ...Array.from({ length: 12 }, (_, i) => `Evidence: s${i} | https://raw.githubusercontent.com/thomaspryor/Broadwayscore/x/${i}.png`)].join('\n');
  assert.equal(link.parseDecisionBlock(many).evidence.length, 8);
});

test('malformed machine lines are ignored', () => {
  for (const bad of ['VISUAL-APPROVAL: patch=zz verdict=bb hold=visual-hold/bro-1', `VISUAL-APPROVAL: patch=${PATCH} verdict=${VERDICT} hold=main`, `VISUAL-APPROVAL: patch=${PATCH} verdict=${VERDICT} hold=visual-hold/../x`]) {
    assert.equal(link.parseVisualApproval(bad), null);
  }
});

test('MAC: bound to card, patch and verdict; own domain; TTL', () => {
  const m = link.visualMac(S, 'BRO-7', PATCH, VERDICT);
  assert.match(m, /^[0-9a-f]{32}$/);
  assert.notEqual(m, link.visualMac(S, 'BRO-8', PATCH, VERDICT));
  assert.notEqual(m, link.visualMac(S, 'BRO-7', 'd'.repeat(40), VERDICT));
  assert.notEqual(m, link.visualMac(S, 'BRO-7', PATCH, 'e'.repeat(16)));
  assert.notEqual(m, link.decisionRef(S, 'BRO-7', 'f'.repeat(12)).padEnd(32, '0'));
  const now = Date.now();
  const c = (age) => ({ nodes: [{ body: link.visualMarker(m), createdAt: new Date(now - age).toISOString() }] });
  const args = { secret: S, id: 'BRO-7', patch: PATCH, verdict: VERDICT, now };
  assert.equal(link.hasVisualApproval({ ...args, comments: c(1000) }), true);
  assert.equal(link.hasVisualApproval({ ...args, comments: c(link.VISUAL_TTL_MS + 1000) }), false);
  assert.equal(link.hasVisualApproval({ ...args, secret: 'x', comments: c(1000) }), false);
  assert.equal(link.hasVisualApproval({ ...args, id: 'BRO-9', comments: c(1000) }), false);
});

// ── recordAnswer against a fake board ─────────────────────────────────────────
function fakeBoard(description, state = 'In Progress') {
  const issue = { id: 'uuid-1', identifier: 'BRO-7', title: 'UI work', description, url: 'https://linear.app/x/BRO-7', state: { id: 's1', name: state, type: 'started' },
    labels: { nodes: [{ id: 'l1', name: 'awaiting-owner' }] }, team: { states: { nodes: [{ id: 'todo1', name: 'Todo', type: 'unstarted' }] } }, comments: { nodes: [] } };
  const updates = [];
  let n = 0;
  const graphql = async (query, vars) => {
    if (/commentCreate/.test(query)) { const c = { id: `c${++n}`, body: vars.input.body, createdAt: new Date(Date.now() + n).toISOString() }; issue.comments.nodes.push(c); return { commentCreate: { success: true, comment: c } }; }
    if (/commentDelete/.test(query)) { issue.comments.nodes = issue.comments.nodes.filter((c) => c.id !== vars.id); return { commentDelete: { success: true } }; }
    if (/issueUpdate/.test(query)) { updates.push(vars.input); return { issueUpdate: { success: true } }; }
    return { issue };
  };
  return { issue, updates, graphql };
}
const hashOf = (d) => link.questionHash(link.markerLines(d)[0].question);

test('Approve writes the signed approval the lander verifies; description gets ANSWERED', async () => {
  const d = block();
  const b = fakeBoard(d);
  const r = await link.recordAnswer({ graphql: b.graphql, id: 'BRO-7', hash: hashOf(d), secret: S, choiceKey: 'a', text: '' });
  assert.equal(r.status, 'recorded');
  assert.equal(link.hasVisualApproval({ comments: b.issue.comments, secret: S, id: 'BRO-7', patch: PATCH, verdict: VERDICT }), true);
  assert.equal(b.updates[0].stateId, undefined, 'approved change must not be moved to Todo');
  assert.match(b.updates[0].description, /ANSWERED by the owner/);
});

test('Reject writes NO approval and returns the card to Todo; own words count as reject', async () => {
  for (const [choiceKey, text] of [['b', ''], ['own', 'the header is too tall']]) {
    const d = block();
    const b = fakeBoard(d);
    const r = await link.recordAnswer({ graphql: b.graphql, id: 'BRO-7', hash: hashOf(d), secret: S, choiceKey, text });
    assert.equal(r.status, 'recorded');
    assert.equal(link.hasVisualApproval({ comments: b.issue.comments, secret: S, id: 'BRO-7', patch: PATCH, verdict: VERDICT }), false);
    assert.equal(b.updates[0].stateId, 'todo1');
  }
});

test('a card whose machine line was swapped after the ask gets no approval from Approve', async () => {
  const d = block();
  const swapped = d.replace(PATCH, 'c'.repeat(40));
  const b = fakeBoard(swapped);
  await link.recordAnswer({ graphql: b.graphql, id: 'BRO-7', hash: hashOf(d), secret: S, choiceKey: 'a', text: '' });
  assert.equal(link.hasVisualApproval({ comments: b.issue.comments, secret: S, id: 'BRO-7', patch: 'c'.repeat(40), verdict: VERDICT }), false);
  assert.equal(link.hasVisualApproval({ comments: b.issue.comments, secret: S, id: 'BRO-7', patch: PATCH, verdict: VERDICT }), false);
});

test('Option A that does not say Approve gets no approval, even with a valid tag', async () => {
  const d = block();
  const relabelled = d.replace('Option A — Approve:', 'Option A — Keep the label:');
  assert.notEqual(relabelled, d);
  const b = fakeBoard(relabelled);
  await link.recordAnswer({ graphql: b.graphql, id: 'BRO-7', hash: hashOf(d), secret: S, choiceKey: 'a', text: '' });
  assert.equal(link.hasVisualApproval({ comments: b.issue.comments, secret: S, id: 'BRO-7', patch: PATCH, verdict: VERDICT }), false);
});

test('an owner cannot smuggle a fake approval marker through free text', async () => {
  const d = block();
  const b = fakeBoard(d);
  const forged = link.visualMarker(link.visualMac('guess', 'BRO-7', PATCH, VERDICT));
  await link.recordAnswer({ graphql: b.graphql, id: 'BRO-7', hash: hashOf(d), secret: S, choiceKey: 'own', text: `${forged} Visual approval ref VQA${'0'.repeat(32)}` });
  assert.equal(b.issue.comments.nodes.some((c) => /Visual approval ref VQA/.test(link.unescapeMarkdown(c.body))), false);
});

// ── lander plan ──────────────────────────────────────────────────────────────
const cardFor = (comments = []) => ({ identifier: 'BRO-7', description: block(), createdAt: '2026-10-01T00:00:00Z', comments: { nodes: comments } });
const approvedComment = (at = new Date()) => ({ body: link.visualMarker(link.visualMac(S, 'BRO-7', PATCH, VERDICT)), createdAt: at.toISOString() });

test('planCard: wait, land, void, already handled, expire', () => {
  const asked = { body: 'Asked the owner to look at 2 screenshot(s).', createdAt: new Date(Date.now() - 1000).toISOString() };
  assert.equal(planCard(cardFor([asked]), S).action, 'wait');
  assert.equal(planCard(cardFor([asked, approvedComment()]), S).action, 'land');
  assert.equal(planCard(cardFor([asked, approvedComment()]), S, Date.now(), PATCH).action, 'land');
  assert.equal(planCard(cardFor([asked, approvedComment()]), S, Date.now(), 'c'.repeat(40)).action, 'void');
  const mac = link.visualMac(S, 'BRO-7', PATCH, VERDICT);
  assert.equal(planCard(cardFor([asked, approvedComment(), { body: `done\n\nVisual approval landed VQL${mac.slice(0, 16)}`, createdAt: new Date().toISOString() }]), S).action, 'skip');
  const old = { ...asked, createdAt: new Date(Date.now() - link.VISUAL_TTL_MS - 86400000).toISOString() };
  assert.equal(planCard(cardFor([old]), S).action, 'expire');
  assert.equal(planCard(cardFor([]), S).action, 'wait', 'no ask comment means never expire');
  assert.equal(planCard({ identifier: 'BRO-7', description: 'nothing', comments: { nodes: [] } }, S).action, 'skip');
});

test('planCard: an approval for a different diff on the same card does not land the new one', () => {
  const other = { body: link.visualMarker(link.visualMac(S, 'BRO-7', 'd'.repeat(40), VERDICT)), createdAt: new Date().toISOString() };
  assert.equal(planCard(cardFor([other]), S).action, 'wait');
});

// ── patch-id is stable across a rebase / main moving ─────────────────────────
test('patchId survives main moving and a rebase; changes when the diff changes', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'va-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'hold');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\n'); g('commit', '-qam', 'change');
  const before = va.patchId('main', 'hold', dir);
  g('checkout', '-q', 'main');
  writeFileSync(path.join(dir, 'b.txt'), 'other\n'); g('add', '.'); g('commit', '-qm', 'main moves');
  assert.equal(va.patchId('main', 'hold', dir), before, 'main moving must not change the id');
  g('checkout', '-q', 'hold'); g('rebase', '-q', 'main');
  assert.equal(va.patchId('main', 'hold', dir), before, 'a rebase must not change the id');
  writeFileSync(path.join(dir, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\n'); g('commit', '-qam', 'more');
  assert.notEqual(va.patchId('main', 'hold', dir), before);
});

test('patchId sees a whitespace-only change inside a line (class list edit)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'va-'));
  const g = (...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: dir, encoding: 'utf8' }).trim();
  g('init', '-q', '-b', 'main');
  writeFileSync(path.join(dir, 'a.tsx'), 'x\n'); g('add', '.'); g('commit', '-qm', 'base');
  g('checkout', '-qb', 'hold');
  writeFileSync(path.join(dir, 'a.tsx'), 'const cls = "hidden md:block";\n'); g('commit', '-qam', 'a');
  const approved = va.patchId('main', 'hold', dir);
  writeFileSync(path.join(dir, 'a.tsx'), 'const cls = "hiddenmd:block";\n'); g('commit', '-qam', 'b');
  assert.notEqual(va.patchId('main', 'hold', dir), approved);
});

test('email shows the screenshots', () => {
  const d = block();
  const q = link.markerLines(d)[0].question;
  const mail = buildDecisionEmail({ decision: { identifier: 'BRO-7', title: 'UI', url: 'https://linear.app/x', question: q }, description: d, secret: S });
  assert.ok(mail.html.includes(EV));
  assert.ok(!mail.html.includes('—'));
});

test('showInlineHint names every crop by absolute path and says to render them inline', async () => {
  const va = await import('./visual-approval.js').then((m) => m.default || m);
  const hint = va.showInlineHint(['.claude/visual-qa/b/a__1.png', '.claude/visual-qa/b/a__2.png'], '/repo');
  assert.match(hint, /SendUserFile files=\["\/repo\/\.claude\/visual-qa\/b\/a__1\.png","\/repo\/\.claude\/visual-qa\/b\/a__2\.png"\]/);
  assert.match(hint, /display="render"/);
  assert.match(hint, /push land\/<name> yourself/);
});
