// subject-writer.mjs (BRO-7168): code checks, fallback and ranking, with the
// network calls stubbed. Requires the real module, no copied logic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPool, checkCandidate, writeSubject, aiSubjectDisabledReason, numbersIn, reusable } from './subject-writer.mjs';

const facts = {
  edition: 'west-end',
  lines: [
    'The email covers Monday, Nov 2 to Sunday, Nov 8 and is sent on Sunday, Nov 8.',
    'Opening: The Bridge, Off West End, play at Bush Theatre, opened this week, on Tuesday, Nov 3. Critic Score 76 (Recommended) from 25 reviews. Final performance Wednesday, Nov 11.',
    'Closing soon: The Revlon Girl, Off West End at Park Theatre, opened Wednesday, Oct 28. Final performance Saturday, Nov 14. Critic Score 83 (Recommended) from 17 reviews.',
    'Opening: Iphigenie en Tauride - English National Opera, opera (secondary section). Critic Score 66 (Worth Seeing) from 5 reviews.',
  ],
  knownTitles: ['The Bridge', 'The Revlon Girl', 'Hamilton', 'Tru'],
  titles: [
    { id: 'b', slug: 'b', title: 'The Bridge' },
    { id: 'r', slug: 'r', title: 'The Revlon Girl' },
    { id: 'i', slug: 'i', title: 'Iphigenie en Tauride - English National Opera' },
  ],
};
const pool = buildPool(facts);
const good = {
  angle: 'last chance',
  subject: 'The Revlon Girl closes Saturday',
  preheader: 'Critics gave it an 83. The Bridge, at the Bush, ends Wednesday too.',
  lede: 'The best-reviewed show in London right now is leaving. The Revlon Girl (83) closes Saturday, and The Bridge (76) closes Wednesday.',
};

test('a clean candidate passes the code checks', () => {
  assert.deepEqual(checkCandidate(good, pool), []);
});

test('the old template phrasing is rejected (owner, 2026-11-08)', () => {
  for (const subject of ['The Bridge opens to strong reviews', 'A big week for London theatre', '8 shows open in London, with critics', 'Four shows opened, two scoring 75 or higher']) {
    assert.ok(checkCandidate({ ...good, subject }, pool).length, subject);
  }
});

test('numbers and weekdays must come from the facts', () => {
  assert.match(checkCandidate({ ...good, subject: 'The Revlon Girl scores a 91' }, pool).join(), /not in the facts: 91/);
  assert.match(checkCandidate({ ...good, subject: 'The Revlon Girl closes Friday' }, pool).join(), /Friday/);
  assert.deepEqual(numbersIn('two shows, 83 and 76 on Nov 14, up 2.35%'), ['83', '76', '2.35', '2']);
});

test('a dash inside a show title is not flagged as our punctuation', () => {
  const c = { ...good, lede: `${good.lede} Iphigenie en Tauride - English National Opera opened Friday at 66.` };
  assert.ok(!checkCandidate({ ...c, lede: c.lede.replace(' Friday', '') }, pool).some(p => /dash/.test(p)));
});

test('a subject too close to a recent one is rejected; preheader may not repeat the subject', () => {
  assert.match(checkCandidate(good, pool, ['The Revlon Girl closes this weekend']).join(), /recent/);
  assert.match(checkCandidate({ ...good, preheader: 'The Revlon Girl closes Saturday at the Park Theatre' }, pool).join(), /repeats the subject/);
});

test('writeSubject returns the judge\'s pick plus alternates, after GPT approval', async () => {
  const second = { ...good, angle: 'the one to book', subject: 'See The Bridge before Wednesday', preheader: 'Critics scored it 76. The Revlon Girl (83) ends Saturday too.' };
  const bad = { ...good, angle: 'template', subject: 'The Bridge opens to strong reviews' };
  const r = await writeSubject(facts, { deps: {
    writer: async () => ({ candidates: [good, bad, second] }),
    checker: async () => ({ supported: true, problems: [] }),
    judge: async () => ({ ranking: [1, 0], why: 'urgent and specific' }),
  } });
  assert.equal(r.subject, 'See The Bridge before Wednesday');
  assert.deepEqual(r.alternates.map(a => a.subject), ['The Revlon Girl closes Saturday']);
  assert.equal(r.rejected, 1);
  assert.deepEqual(r.showRefs.map(s => s.id).sort(), ['b', 'r']);
});

test('GPT rejection, API failure and no survivors all fall back (null), never throw', async () => {
  const no = await writeSubject(facts, { deps: { writer: async () => ({ candidates: [good] }), checker: async () => ({ supported: false, problems: ['x'] }) } });
  assert.equal(no, null);
  const boom = await writeSubject(facts, { deps: { writer: async () => { throw new Error('HTTP 529'); } } });
  assert.equal(boom, null);
});

test('rejections are fed back for one rewrite', async () => {
  const prompts = [];
  const r = await writeSubject(facts, { deps: {
    writer: async (p) => { prompts.push(p); return { candidates: [prompts.length === 1 ? { ...good, subject: 'A big week for London theatre' } : good] }; },
    checker: async () => ({ supported: true, problems: [] }),
  } });
  assert.equal(r.subject, good.subject);
  assert.match(prompts[1], /rejected for these reasons/);
});

test('overrides and missing keys turn the writer off', () => {
  assert.match(aiSubjectDisabledReason({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', SUBJECT_OVERRIDE: 'x' }), /OVERRIDE/);
  assert.match(aiSubjectDisabledReason({ OPENAI_API_KEY: 'k' }), /ANTHROPIC/);
  assert.match(aiSubjectDisabledReason({ ANTHROPIC_API_KEY: 'k' }), /OPENAI/);
  assert.match(aiSubjectDisabledReason({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', NEWSLETTER_AI_SUBJECT_DISABLED: 'true' }), /DISABLED/);
  assert.equal(aiSubjectDisabledReason({ ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k' }), null);
});

test('review findings (2026-11-08): relative dates, wrong decimals, stray dates, other shows, title-substring words', () => {
  assert.match(checkCandidate({ ...good, subject: 'The Revlon Girl closes tomorrow' }, pool).join(), /relative date/);
  assert.match(checkCandidate({ ...good, preheader: 'Catch The Bridge tonight before it is gone for good.' }, pool).join(), /relative date/);
  assert.match(checkCandidate({ ...good, subject: 'The Revlon Girl closes Nov 15' }, pool).join(), /date the facts do not/);
  assert.match(checkCandidate({ ...good, subject: 'Hamilton and The Revlon Girl' }, pool).join(), /not in this email: Hamilton/);
  // "Tru" is a known title; stripping must not eat the start of "Truly".
  assert.match(checkCandidate({ ...good, subject: 'Truly the best: The Revlon Girl' }, pool).join(), /AI-sounding/);
  // The coverage line alone never vouches for a weekday.
  const p2 = buildPool({ ...facts, lines: ['The email covers the week of Monday, Nov 2 to Sunday, Nov 8.', facts.lines[1]] });
  assert.match(checkCandidate({ ...good, subject: 'The Bridge closes Sunday', lede: good.lede.replace(/The Revlon Girl \(83\) closes Saturday, and /, '') }, p2).join(), /Sunday/);
});

test('a candidate whose checker call fails is skipped, others survive', async () => {
  const second = { ...good, subject: 'See The Bridge before Wednesday', preheader: 'Critics scored it 76. The Revlon Girl (83) ends Saturday too.' };
  let n = 0;
  const r = await writeSubject(facts, { deps: {
    writer: async () => ({ candidates: [good, second] }),
    checker: async () => { if (n++ === 0) throw new Error('timeout'); return { supported: true, problems: [] }; },
  } });
  assert.ok(r && r.rejected === 1);
});

test('a run past its deadline falls back', async () => {
  const r = await writeSubject(facts, { deps: { deadlineMs: -1, writer: async () => ({ candidates: [good] }), checker: async () => ({ supported: true, problems: [] }) } });
  assert.equal(r, null);
});

test('an earlier subject for the same issue is reused only while it still checks out', () => {
  const prev = { ...good, alternates: [] };
  assert.equal(reusable(prev, facts).subject, good.subject);
  const moved = { ...facts, lines: facts.lines.map(l => l.replace('Critic Score 83', 'Critic Score 82')) };
  assert.equal(reusable(prev, moved), null);
});
