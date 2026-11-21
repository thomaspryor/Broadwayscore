// subject-writer.mjs (BRO-7168): code checks, fallback and ranking, with the
// network calls stubbed. Requires the real module, no copied logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardDetailRepeats, buildPool, checkCandidate, writeSubject, aiSubjectDisabledReason, numbersIn, reusable, writerPrompt, firstSentence } from './subject-writer.mjs';

const facts = {
  edition: 'west-end',
  lines: [
    'The email covers Monday, Nov 2 to Sunday, Nov 8 and is sent on Sunday, Nov 8.',
    'Opening: The Bridge, Off West End, play at Bush Theatre, opened this week, on Tuesday, Nov 3. Critic Score 76/100 from 25 critics. Final performance Wednesday, Nov 11.',
    'Closing soon: The Revlon Girl, Off West End at Park Theatre, opened Wednesday, Oct 28. Final performance Saturday, Nov 14. Critic Score 83/100 from 17 critics.',
    'Opening: Iphigenie en Tauride - English National Opera, opera (secondary section). Critic Score 66/100 from 5 critics.',
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
  subject: 'The Revlon Girl, 83/100, closes Saturday',
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
  const second = { ...good, angle: 'the one to book', subject: 'The Bridge hits 76/100 and ends Wednesday', preheader: 'Critics scored it 76. The Revlon Girl (83) ends Saturday too.' };
  const bad = { ...good, angle: 'template', subject: 'The Bridge opens to strong reviews' };
  const r = await writeSubject(facts, { deps: {
    writer: async () => ({ candidates: [good, bad, second] }),
    checker: async () => ({ supported: true, problems: [] }),
    judge: async () => ({ ranking: [1, 0], why: 'urgent and specific' }),
  } });
  assert.equal(r.subject, 'The Bridge hits 76/100 and ends Wednesday');
  assert.deepEqual(r.alternates.map(a => a.subject), [good.subject]);
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
  const second = { ...good, subject: 'The Bridge hits 76/100 and ends Wednesday', preheader: 'Critics scored it 76. The Revlon Girl (83) ends Saturday too.' };
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

test('short form of a long title counts as that show, not as other shows inside it (live run, 2026-11-09)', () => {
  const f = {
    edition: 'broadway',
    lines: ['Closing soon: School Girls; Or, The African Mean Girls Play, Broadway. Final performance Sunday, Nov 15. Critic Score 84/100 from 34 critics.'],
    titles: [{ id: 's', slug: 's', title: 'School Girls; Or, The African Mean Girls Play' }],
    knownTitles: ['School Girls; Or, The African Mean Girls Play', 'Girls', 'Mean Girls', 'Hamilton'],
  };
  const p = buildPool(f);
  const c = { angle: 'last chance', subject: 'School Girls, 84/100, closes Sunday, Nov 15', preheader: 'Critics gave it 84/100 from 34 critics.', lede: 'School Girls (84) ends its Broadway run Sunday, Nov 15, and critics loved it all the way.' };
  assert.deepEqual(checkCandidate(c, p), []);
  assert.match(checkCandidate({ ...c, lede: c.lede + ' Hamilton plays on.' }, p).join(), /Hamilton/);
});

test('openings lead: with this week\'s openings in the facts, a closings-only subject or first sentence is rejected (owner, 2026-11-09)', () => {
  const f = { ...facts, leadTitles: ['The Bridge'] };
  const p = buildPool(f);
  const closingLead = { angle: 'last chance', subject: 'The Revlon Girl, 83/100, closes Saturday', preheader: 'Critics gave it an 83. Plus The Bridge, at the Bush.', lede: 'The Revlon Girl (83) closes Saturday, so this is the last call. The Bridge (76) is the other one to catch.' };
  const probs = checkCandidate(closingLead, p).join();
  assert.match(probs, /subject must be about this week's openings/);
  assert.match(probs, /first sentence must name one of this week's openings/);
  const openingLead = { angle: 'best opening', subject: 'The Bridge scores 76/100, the week\'s standout', preheader: 'Critics scored it 76. The Revlon Girl (83) closes Saturday.', lede: 'The Bridge (76) is the week\'s new opening, and critics liked it. The Revlon Girl (83) closes Saturday.' };
  assert.deepEqual(checkCandidate(openingLead, p), []);
  // A group angle on the openings is fine without a title.
  assert.ok(!checkCandidate({ ...openingLead, subject: 'How the week\'s London openings landed' }, p).some(x => /subject must/.test(x)));
  // No openings this week: closings may lead.
  assert.deepEqual(checkCandidate(closingLead, buildPool(facts)), []);
});

// Owner, 2026-11-15 (West End weekly): "Cloud 9 (77) opened ... and is Recommended
// from 33 reviews", "Critics recommend Cloud 9 at the Lyttelton", "Dogstar gets a
// Mixed 64". The Critic Score is the product; the tier label is not the news.
const weFacts = {
  edition: 'west-end',
  lines: [
    'Opening: Cloud 9, West End, play at Lyttelton Theatre, opened this week, on Tuesday, Nov 10. Critic Score 77/100 from 33 critics.',
    'Opening: Dogstar, Off West End, play at Hampstead Theatre, opened this week, on Monday, Nov 9. Critic Score 64/100 from 26 critics.',
  ],
  leadTitles: ['Cloud 9', 'Dogstar'],
  knownTitles: ['Cloud 9', 'Dogstar'],
  titles: [{ id: 'c', slug: 'c', title: 'Cloud 9' }, { id: 'd', slug: 'd', title: 'Dogstar' }],
};
const wePool = buildPool(weFacts);
const goodWe = {
  angle: 'best reviewed',
  subject: 'Cloud 9 lands at a solid 77/100 from 33 critics',
  preheader: 'Dogstar, at Hampstead, scores 64/100 from 26 critics.',
  lede: 'Cloud 9 lands at a solid 77/100, the best of a quiet week. Off West End, Dogstar trails at 64/100.',
};

test('the owner\'s score-first subject passes', () => {
  assert.deepEqual(checkCandidate(goodWe, wePool), []);
});

test('tier labels and "recommended" are rejected in subject, preheader and lede', () => {
  for (const bad of [
    { subject: 'Critics recommend Cloud 9 at the Lyttelton' },
    { subject: 'Dogstar gets a Mixed 64 at Hampstead Theatre' },
    { lede: 'Cloud 9 (77) opened at the Lyttelton Theatre on Tuesday, and is Recommended from 33 reviews. Dogstar opened on Monday.' },
    { preheader: 'Cloud 9 is Worth Seeing and Dogstar is Mixed at 64' },
    { lede: 'Cloud 9 opened on Tuesday with a Critical Gold score of 77. Dogstar (64) opened Monday.' },
  ]) {
    assert.ok(checkCandidate({ ...goodWe, ...bad }, wePool).some(p => /tier label|recommend/.test(p)), JSON.stringify(bad));
  }
});

test('a show named in the subject must carry its Critic Score; a title with a label word in it is fine', () => {
  assert.match(checkCandidate({ ...goodWe, subject: 'Cloud 9 lands at the Lyttelton on Tuesday' }, wePool).join(), /must state that show's Critic Score/);
  // group subjects that name no show are exempt
  assert.ok(!checkCandidate({ ...goodWe, subject: 'Two London openings, one standout score' }, wePool).some(p => /Critic Score number/.test(p)));
  const mixed = buildPool({ ...weFacts, lines: ['Opening: Mixed Feelings, West End. Critic Score 70/100 from 12 critics.'], titles: [{ id: 'm', slug: 'm', title: 'Mixed Feelings' }], leadTitles: [], knownTitles: [] });
  assert.deepEqual(checkCandidate({ angle: 'x', subject: 'Mixed Feelings scores 70/100 from 12 critics', preheader: 'Critics were warm on the opening night at the theatre.', lede: 'Mixed Feelings scores 70/100, and the notices were warm across the board for a small show.' }, mixed), []);
});

test('the opening paragraph\'s first sentence gives the lead show\'s score', () => {
  const noScore = { ...goodWe, lede: 'Cloud 9 got warm notices from critics across the board this week. Dogstar (64) trails it by a little.' };
  assert.match(checkCandidate(noScore, wePool).join(), /first sentence names a show, so it must give that show's Critic Score/);
});

test('the fact sheet gives scores as N/100 and the writer is told the score is the star', () => {
  assert.ok(wePool.scoreNumbers.has('77') && wePool.scoreNumbers.has('64'));
  const prompt = writerPrompt(wePool);
  assert.match(prompt, /THE CRITIC SCORE IS THE STAR/);
  assert.match(prompt, /77\/100 from 33 critics/);
  assert.match(prompt, /Never use our tier labels/);
});

test('an abbreviation in the first sentence does not cut it before the Critic Score (ship-check, 2026-11-15)', () => {
  const lede = "The Bridge opened at St. Ann's Warehouse on Tuesday and scores 76/100. The Revlon Girl (83) closes Saturday.";
  assert.equal(firstSentence(lede), "The Bridge opened at St. Ann's Warehouse on Tuesday and scores 76/100.");
  assert.equal(firstSentence('Ms. Blakk for President opens at 70/100. More.'), 'Ms. Blakk for President opens at 70/100.');
  assert.equal(firstSentence('Cloud 9 opened Tuesday. It scores 77/100.'), 'Cloud 9 opened Tuesday.');
  assert.deepEqual(checkCandidate({ ...good, lede: "The Bridge scores 76/100 at St. Ann's, and The Revlon Girl (83) closes Saturday." }, pool), []);
});

test('tier-label and "recommend" bans cover the inflected and lowercase forms', () => {
  for (const bad of ['Critics are recommending The Bridge at 76/100', 'A strong recommendation: The Bridge, 76/100', 'The Bridge scores a mixed 76/100', 'The Bridge lands at Mixed (76)', 'The Bridge gets a mixed 76']) {
    const p = checkCandidate({ ...good, subject: bad }, pool).join('|');
    assert.ok(/tier label|recommend/.test(p), `${bad} should be rejected, got: ${p}`);
  }
});

test('the writer prompt never asks for a recommendation angle while the checker bans the word', () => {
  assert.doesNotMatch(writerPrompt(pool), /\ba recommendation\b/);
});

test('plain English about mixed reviews or worth seeing is not a banned tier label', () => {
  for (const ok of ['Reviews were mixed (5 critics) but The Bridge hits 76/100', 'A critical miss for the Old Vic, and The Bridge at 76/100']) {
    const p = checkCandidate({ ...good, subject: ok }, pool).filter(x => /tier label/.test(x));
    assert.deepEqual(p, [], ok);
  }
});

test('the lede does not repeat what the cards show: venue, opening date, critic quote (owner, 2026-11-15)', () => {
  const bad = 'Here There Are Blueberries opened at the Ethel Barrymore Theatre on Monday and scores 82/100 from 24 critics. Frank Scheck of New York Stage Review gave it 98 out of 100.';
  assert.equal(cardDetailRepeats(bad).length, 4);
  assert.match(cardDetailRepeats(bad).join(), /review or critic count/);
  assert.match(cardDetailRepeats('Nero scores 13/100, which a critic gave 13 out of 100.').join(), /critics do not give one/);
  assert.match(cardDetailRepeats('Cloud 9 lands at 77/100 from 36 critics.').join(), /review or critic count/);
  assert.deepEqual(cardDetailRepeats('Cloud 9 lands at a solid 77/100, the best of a quiet week. Dogstar trails at 64.'), []);
  // closings and previews may still name a weekday; only an opening's venue/date is banned
  assert.deepEqual(cardDetailRepeats('The Revlon Girl (83) closes Saturday.'), []);
  const withDetail = { ...goodWe, lede: 'Cloud 9 opened at the Lyttelton Theatre on Tuesday and scores 77/100. Off West End, Dogstar trails at 64/100.' };
  assert.match(checkCandidate(withDetail, wePool).join(), /lede says where or when a show opened/);
  assert.match(writerPrompt(wePool), /NEVER repeat venues, opening dates/);
});

test('cardDetailRepeats: score and upcoming phrasing are not card detail; facts-named venues and critics are (ship-check review, 2026-11-15)', () => {
  const f = { edition: 'broadway', titles: [{ id: 'd', slug: 'd', title: 'Dogstar' }], knownTitles: [], lines: [
    'Opening: Dogstar, Off West End, play at Hampstead Theatre, opened this week, on Monday, Nov 9. Critic Score 64/100 from 26 critics.',
    'Opening: Cats, Broadway, musical at Winter Garden, opened this week, on Tuesday, Nov 10. Critic Score 80/100 from 20 critics.',
    "Rave of the week: our score for Mike Wells (The Reviews Hub)'s review of Dogstar is 99 out of 100."] };
  const p = buildPool(f);
  assert.deepEqual(p.venueNames, ['Hampstead Theatre', 'Winter Garden']);
  assert.deepEqual(p.criticNames, ['Mike Wells', 'The Reviews Hub']);
  const n = (l) => cardDetailRepeats(l, { venues: p.venueNames, critics: p.criticNames }).length;
  for (const ok of ['Cats opens at 70/100.', 'The Fantasticks opens on Monday.', 'Cloud 9 lands at 77/100.', 'Cats closes Saturday.']) assert.equal(n(ok), 0, ok);
  for (const bad of ['Dogstar opened at Hampstead Theatre.', 'Cats opened to praise at the Winter Garden.', 'Dogstar opened Nov 9 at Hampstead.', 'Mike Wells gave Dogstar 99 out of 100.', 'Dogstar opened Tues.', 'Dogstar was praised by The Reviews Hub.']) assert.ok(n(bad) > 0, bad);
});

test('the lede and subject lead with a West End opening, never an off-market one (owner, 2026-11-15)', () => {
  const pool = { ...wePool, topLeadTitles: ['Cloud 9'] };
  const offFirst = { ...goodWe, subject: 'Dogstar scores 64/100, the week\'s low', lede: 'Dogstar scores 64/100, the lowest of the week. Cloud 9 did better at 77/100.' };
  const r = checkCandidate(offFirst, pool).join();
  assert.match(r, /must lead with a West End opening/);
  assert.match(r, /subject that names an opening must name a West End one/);
  assert.deepEqual(checkCandidate(goodWe, pool), []);
  // no main-market opening this week: an off-market lead is fine
  assert.deepEqual(checkCandidate(offFirst, { ...wePool, topLeadTitles: [] }).filter(x => /West End opening/.test(x)), []);
});

test('the "gave a score" guard does not reject our own wording or critic praise (ship-check, BRO-7570)', () => {
  const n = (l) => cardDetailRepeats(l).filter(x => /critics do not give one/.test(x)).length;
  for (const ok of ['Cloud 9 rates a solid 77/100.', 'The top-rated Cloud 9 lands at 77/100.', 'Critics gave Cloud 9 a warm welcome.', 'Critics rated the cast highly.']) assert.equal(n(ok), 0, ok);
  for (const bad of ['Nero, which a critic gave 13 out of 100.', 'Critics rated it 64.', 'One reviewer awarded it 98/100.']) assert.equal(n(bad), 1, bad);
  // a missing critic name must not turn "a critic" into a banned phrase
  const p = buildPool({ ...weFacts, lines: [...weFacts.lines, "Rave of the week: our score for a critic (The Stage)'s review of Dogstar is 99 out of 100."] });
  assert.ok(!p.criticNames.includes('a critic'));
});
