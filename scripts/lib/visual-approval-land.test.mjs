// BRO-6244: lander hardening (verdict recheck, once-per-approval stale nudge, status classifier, shared markers).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const link = require('../../src/lib/owner-decision-link.js');
const va = require('./visual-approval.js');
const land = require('../visual-approval-land.js');

const S = 'test-secret';
const PATCH = 'a'.repeat(40);
const VERDICT = 'b'.repeat(16);
const SHA = 'c'.repeat(40);
const EV = `https://raw.githubusercontent.com/thomaspryor/Broadwayscore/${SHA}/home.png`;
const desc = () => va.buildBlock({ what: 'the home page', patch: PATCH, verdict: VERDICT, hold: 'visual-hold/bro-7', evidence: [{ label: 'Home', url: EV }], summary: 'ok' });
const mac = link.visualMac(S, 'BRO-7', PATCH, VERDICT);
const at = (ms) => new Date(ms).toISOString();
const NOW = Date.parse('2026-10-26T02:00:00Z');
const approveComment = (ms) => ({ id: 'c1', body: link.visualMarker(mac), createdAt: at(ms) });
const card = (comments, description = desc()) => ({ identifier: 'BRO-7', description, comments: { nodes: comments } });

test('checkVerdict: only a passing verdict with the approved contentHash ships', () => {
  assert.equal(va.checkVerdict(JSON.stringify({ overallPass: true, contentHash: VERDICT }), VERDICT).ok, true);
  assert.equal(va.checkVerdict(JSON.stringify({ overallPass: false, contentHash: VERDICT }), VERDICT).ok, false);
  assert.equal(va.checkVerdict(JSON.stringify({ contentHash: VERDICT }), VERDICT).ok, false, 'missing overallPass is not a pass');
  assert.equal(va.checkVerdict(JSON.stringify({ overallPass: true, contentHash: 'd'.repeat(16) }), VERDICT).ok, false);
  assert.equal(va.checkVerdict('', VERDICT).ok, false);
  assert.equal(va.checkVerdict('{not json', VERDICT).ok, false);
});

test('evidenceSha reads the commit the owner saw, not a branch name', () => {
  assert.equal(va.evidenceSha(desc()), SHA);
  assert.equal(va.evidenceSha('Evidence: x | https://raw.githubusercontent.com/thomaspryor/Broadwayscore/visual-evidence/bro-7/home.png'), null);
});

test('planCard reports when the owner approved; isStale flips after 45 minutes', () => {
  const approvedMs = NOW - 50 * 60 * 1000;
  const plan = land.planCard(card([approveComment(approvedMs)]), S, NOW);
  assert.equal(plan.action, 'land');
  assert.equal(plan.approvedAt, approvedMs);
  assert.equal(land.isStale(plan.approvedAt, NOW), true);
  assert.equal(land.isStale(NOW - 10 * 60 * 1000, NOW), false);
  assert.equal(land.isStale(null, NOW), false);
  const wrongPatch = land.planCard(card([approveComment(approvedMs)]), S, NOW, 'e'.repeat(40));
  assert.equal(wrongPatch.action, 'void');
  assert.equal(wrongPatch.approvedAt, approvedMs);
});

test('the stale nudge is once per approval: its marker is stable and distinct from the others', () => {
  const m = land.staleMarker(mac);
  assert.equal(m, land.staleMarker(mac));
  assert.ok(m.startsWith(va.MARK.stale));
  const others = [land.landedMarker(mac), land.expiredMarker(mac), land.voidMarker(mac, PATCH), land.unverifiedMarker(mac, SHA)];
  for (const o of others) assert.notEqual(o.slice(0, 26), m.slice(0, 26));
});

test('classifyStatus: waiting, approved, landed, void, unverified, rejected, expired, none (no secret needed)', () => {
  const d = desc();
  const c = (body) => ({ body, createdAt: at(NOW) });
  assert.equal(va.classifyStatus(d, []), 'waiting');
  assert.equal(va.classifyStatus('no machine line', []), 'none');
  const answered = `${d}\nANSWERED by the owner (see the "Owner decision" comment on this card).`;
  assert.equal(va.classifyStatus(answered, []), 'rejected');
  const approved = [c(link.visualMarker(mac))];
  assert.equal(va.classifyStatus(answered, approved), 'approved');
  // BRO-6546: void closes an ask the owner approved in chat (no tap was ever recorded), so it must not read as rejected.
  assert.equal(va.classifyStatus(answered, [c(land.voidMarker(mac, PATCH))]), 'void');
  assert.equal(va.classifyStatus(answered, [...approved, c(land.voidMarker(mac, PATCH))]), 'void');
  assert.equal(va.classifyStatus(answered, [...approved, c(land.unverifiedMarker(mac, SHA))]), 'unverified');
  assert.equal(va.classifyStatus(answered, [...approved, c(land.voidMarker(mac, PATCH)), c(land.landedMarker(mac))]), 'landed');
  assert.equal(va.classifyStatus(d, [c(land.expiredMarker(mac))]), 'expired');
  // markdown-escaped bodies (Linear escapes underscores etc.) still match
  assert.equal(va.classifyStatus(answered, [c(link.visualMarker(mac).replace(/ /g, ' '))]), 'approved');
});

test('regression: BRO-5109 case, tap at 23:56Z then lander landing at 01:25Z reads landed, never waiting', () => {
  const d = `${desc()}\nANSWERED by the owner (see the "Owner decision" comment on this card).`;
  const comments = [
    { body: '**Owner decision** (answered by the owner through the email link)\n\nChose: Option A: Approve', createdAt: '2026-10-25T23:56:15Z' },
    { body: link.visualMarker(mac), createdAt: '2026-10-25T23:56:15Z' },
  ];
  assert.equal(va.classifyStatus(d, comments), 'approved');
  assert.equal(va.classifyStatus(d, [...comments, { body: land.landedMarker(mac), createdAt: '2026-10-26T01:25:54Z' }]), 'landed');
});

test('Evidence lines only render on a card with a VISUAL-APPROVAL line', () => {
  const plain = ['DECISION NEEDED: Ship it? (ref x)', 'Why this is your call: money', 'Option A — Yes: fast / risky', 'Option B — No: safe / slow', `Evidence: Home | ${EV}`].join('\n');
  assert.deepEqual(link.parseDecisionBlock(plain).evidence, []);
  assert.equal(link.parseDecisionBlock(desc()).evidence.length, 1);
});

test('classifyStatus: a second ask on the same card ignores the first ask\'s markers', () => {
  const ask = (ms) => ({ body: 'Asked the owner to look at 2 screenshot(s). Held change: visual-hold/bro-7', createdAt: at(ms) });
  const old = [ask(NOW - 40 * 864e5), { body: `${va.MARK.landed}${'f'.repeat(16)}`, createdAt: at(NOW - 39 * 864e5) }];
  assert.equal(va.classifyStatus(desc(), old), 'landed');
  assert.equal(va.classifyStatus(desc(), [...old, ask(NOW - 1000)]), 'waiting', 'new unanswered ask is waiting, not landed');
});

test('evidenceSha: only Evidence lines count and the last one wins', () => {
  const other = 'd'.repeat(40);
  const free = `see https://raw.githubusercontent.com/thomaspryor/Broadwayscore/${other}/x.png\n`;
  assert.equal(va.evidenceSha(free + desc()), SHA, 'a URL in free text is ignored');
  const later = desc().replace(/^(Evidence:.*)$/m, `$1\nEvidence: B | https://raw.githubusercontent.com/thomaspryor/Broadwayscore/${other}/y.png`);
  assert.equal(va.evidenceSha(later), other);
  assert.equal(va.evidenceSha('no evidence here'), null);
});

// ── BRO-6543: BRO-6517's real shape. The acceptance-criteria enricher deleted the VISUAL-APPROVAL block after the
// ask, so the owner's email tap was recorded as a generic "Approved" (no signed approval) on a card the lander never read.
const ID = 'BRO-6517';
const TITLE = 'City hubs: Chicago hub page';
const P40 = 'a75a2508efee'.padEnd(40, '1');
const V16 = 'e'.repeat(16);
const EVSHA = 'd'.repeat(40);
const ASK_AT = Date.parse('2026-10-29T10:18:25Z');
const ANS_AT = Date.parse('2026-10-29T13:46:18Z');
const askComment = { id: 'a1', createdAt: at(ASK_AT), body: 'Asked the owner to look at 6 screenshot(s). Held change: visual-hold/bro-6517 (patch a75a2508efee). It ships by itself after Approve; Reject returns the card with the owner\'s note.' };
const ownerComment = (chose, ref = link.decisionRef(S, ID, link.questionHash(TITLE))) => ({ id: 'o1', createdAt: at(ANS_AT), body: `**Owner decision** (answered by the owner through the email link, 2026-10-29 UTC)\n\nChose: ${chose}\n\nDecision ref ODA${ref}` });
const lost = (comments) => ({ identifier: ID, title: TITLE, createdAt: at(ASK_AT - 3600e3), description: 'Parent: BRO-6498\n\n## Acceptance criteria\n\n* The hub renders\n\nFiled by: session (kind: city hub)\n', comments: { nodes: comments } });
const facts = { holdTime: ANS_AT - 3600e3, evidenceTime: ANS_AT - 3600e3, patch: P40, evidenceSha: EVSHA, files: ['hub__mobile-360.png', 'hub__desktop-1440.png', 'verdict.json'], verdictRaw: JSON.stringify({ overallPass: true, contentHash: V16 }) };

test('lost block + email Approve: the lander restores the machine lines and the next pass lands it', () => {
  const issue = lost([askComment, ownerComment('Approved')]);
  assert.equal(land.planCard(issue, S, NOW).action, 'skip', 'before the fix the card was invisible to the lander');
  const plan = land.planRecovery(issue, S, facts);
  assert.equal(plan.restore.answer, 'approve');
  assert.ok(plan.restore.lines.some((l) => l === `VISUAL-APPROVAL: patch=${P40} verdict=${V16} hold=visual-hold/bro-6517`));
  assert.ok(plan.restore.lines.some((l) => /^Evidence: hub mobile 360 \| https:\/\/raw\.githubusercontent\.com\/.+\/d{40}\/hub__mobile-360\.png$/.test(l)));
  assert.ok(!plan.restore.lines.some((l) => /verdict\.json/.test(l)), 'only images become Evidence lines');
  // What the CLI writes: lines onto the description plus the signed approval comment.
  const restored = { ...issue, description: `${issue.description}\n${plan.restore.lines.join('\n')}\n`, comments: { nodes: [...issue.comments.nodes, { id: 'v', createdAt: at(ANS_AT + 1000), body: link.visualMarker(link.visualMac(S, ID, P40, V16)) }] } };
  assert.equal(land.planCard(restored, S, ANS_AT + 60e3, null).action, 'land');
  assert.equal(land.planCard(restored, S, ANS_AT + 60e3, P40).action, 'land');
  assert.equal(va.evidenceSha(restored.description), EVSHA);
});

test('lost block: nothing is restored without a genuine owner answer, a matching patch and a passing verdict', () => {
  assert.match(land.planRecovery(lost([askComment]), S, facts).skip, /not answered/);
  assert.match(land.planRecovery(lost([askComment, ownerComment('Approved', 'f'.repeat(16))]), S, facts).skip, /not answered/, 'a ref the secret does not reproduce is not an answer');
  assert.match(land.planRecovery(lost([askComment, ownerComment('Approved')]), 'other-secret', facts).skip, /not answered/);
  const answered = lost([askComment, ownerComment('Approved')]);
  assert.match(land.planRecovery(answered, S, { ...facts, patch: 'f'.repeat(40) }).skip, /no longer matches/);
  assert.match(land.planRecovery(answered, S, { ...facts, verdictRaw: JSON.stringify({ overallPass: false, contentHash: V16 }) }).skip, /did not pass/);
  assert.match(land.planRecovery(answered, S, { ...facts, evidenceSha: null }).skip, /no evidence/);
  assert.match(land.planRecovery(lost([ownerComment('Approved')]), S, facts).skip, /no ask/);
  assert.match(land.planRecovery({ ...answered, identifier: 'BRO-9999' }, S, facts).skip, /another card/);
});

test('lost block + Reject: lines come back without an approval, so the next pass cleans up and never lands', () => {
  const issue = lost([askComment, ownerComment('Rejected')]);
  const plan = land.planRecovery(issue, S, facts);
  assert.equal(plan.restore.answer, 'reject');
  const restored = { ...issue, description: `${issue.description}\n${plan.restore.lines.join('\n')}\n` };
  assert.equal(land.planCard(restored, S, ANS_AT + 60e3).action, 'cleanup');
});

test('an answer written before the latest ask is not this ask\'s answer', () => {
  const older = { ...ownerComment('Approved'), createdAt: at(ASK_AT - 1000) };
  assert.match(land.planRecovery(lost([askComment, older]), S, facts).skip, /not answered/);
});

test('a comment that only quotes the ref, not the recorder\'s answer shape, is not an answer', () => {
  const quoted = { id: 'q', createdAt: at(ANS_AT), body: `Chose: Approved\n\nDecision ref ODA${link.decisionRef(S, ID, link.questionHash(TITLE))}` };
  assert.match(land.planRecovery(lost([askComment, quoted]), S, facts).skip, /not answered/);
});

test('a hold or evidence branch pushed after the owner answered cannot ship on that answer', () => {
  const answered = lost([askComment, ownerComment('Approved')]);
  assert.match(land.planRecovery(answered, S, { ...facts, holdTime: ANS_AT + 1000 }).skip, /after the owner answered/);
  assert.match(land.planRecovery(answered, S, { ...facts, evidenceTime: ANS_AT + 1000 }).skip, /after the owner answered/);
});
