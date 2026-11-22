// subject-writer.mjs (BRO-7168): code checks, fallback and ranking, with the
// network calls stubbed. Requires the real module, no copied logic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cardDetailRepeats, receptionOf, receptionLine, buildPool, checkCandidate, writeSubject, aiSubjectDisabledReason, numbersIn, reusable, writerPrompt, firstSentence } from './subject-writer.mjs';

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
  preheader: 'It scores 83. The Bridge, at the Bush, ends Wednesday too.',
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
  const c = { angle: 'last chance', subject: 'School Girls, 84/100, closes Sunday, Nov 15', preheader: 'It scores 84/100 from 34 critics before it closes.', lede: 'School Girls (84) ends its Broadway run Sunday, Nov 15, and critics loved it all the way.' };
  assert.deepEqual(checkCandidate(c, p), []);
  assert.match(checkCandidate({ ...c, lede: c.lede + ' Hamilton plays on.' }, p).join(), /Hamilton/);
});

test('openings lead: with this week\'s openings in the facts, a closings-only subject or first sentence is rejected (owner, 2026-11-09)', () => {
  const f = { ...facts, leadTitles: ['The Bridge'] };
  const p = buildPool(f);
  const closingLead = { angle: 'last chance', subject: 'The Revlon Girl, 83/100, closes Saturday', preheader: 'It scores 83. Plus The Bridge, at the Bush.', lede: 'The Revlon Girl (83) closes Saturday, so this is the last call. The Bridge (76) is the other one to catch.' };
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

// ── Reception (owner, 2026-11-22) ──────────────────────────────────────────
// Real 2026-11-16 scores: Eurotrash 23 of 26 reviews at 70+, one pan at 16.
const EUROTRASH = [16, 56, 62, 71, 73, 74, 76, 76, 78, 79, 79, 80, 81, 82, 82, 84, 85, 87, 88, 88, 90, 90, 92, 94, 96, 100];
const DOGSTAR = [35, 37, 39, 44, 55, 55, 58, 59, 60, 60, 62, 62, 65, 66, 68, 68, 73, 74, 75, 75, 78, 81, 82, 82, 84, 84, 89];

test('receptionOf: one pan does not make a split; a real two-sided spread does', () => {
  assert.equal(receptionOf(EUROTRASH).verdict, 'liked');
  assert.equal(receptionOf(DOGSTAR).verdict, 'mixed');
  assert.equal(receptionOf([20, 30, 40, 85, 90, 95]).verdict, 'split');
  assert.equal(receptionOf([20, 30, 35, 40, 45]).verdict, 'disliked');
  assert.equal(receptionOf([90, 20]), null, 'too few reviews to say');
  assert.match(receptionLine('Eurotrash', EUROTRASH), /broadly liked it.*not split/);
  assert.doesNotMatch(receptionLine('Eurotrash', EUROTRASH), /\d/, 'words only, so no stray numbers reach the writer');
});

const rxFacts = {
  edition: 'west-end',
  lines: [
    'The email covers the week of Monday, Nov 16 to Sunday, Nov 22.',
    'Opening: Eurotrash, Off West End, play at Soho Theatre, opened this week, on Tuesday, Nov 17. Critic Score 77/100 from 26 critics.',
    'Opening: Goblin, Off West End, play at Bush Theatre, opened this week, on Wednesday, Nov 18. Critic Score 70/100 from 9 critics.',
    "Rave of the week: our score for Jane Critic (The Paper)'s review of Eurotrash is 100 out of 100.",
    "Pan of the week: our score for John Critic (The Other Paper)'s review of Eurotrash is 16 out of 100.",
    receptionLine('Eurotrash', EUROTRASH),
    receptionLine('Goblin', [60, 65, 70, 72, 75, 78, 80, 82, 85]),
  ],
  reception: [{ title: 'Eurotrash', verdict: 'liked' }, { title: 'Goblin', verdict: 'liked' }],
  titles: [{ id: 'e', slug: 'e', title: 'Eurotrash' }, { id: 'g', slug: 'g', title: 'Goblin' }],
  leadTitles: ['Eurotrash', 'Goblin'],
};
const rxPool = buildPool(rxFacts);
const rxGood = {
  angle: 'best-reviewed opening',
  subject: 'Eurotrash lands at a solid 77/100 from 26 critics',
  preheader: 'Goblin also opened and sits at 70. Critics broadly liked both.',
  lede: 'Eurotrash lands at a solid 77/100, and critics broadly liked it. Goblin (70) is the other London opening of the week.',
};

test('a well-liked show with one pan passes when written straight', () => {
  assert.deepEqual(checkCandidate(rxGood, rxPool), []);
});

test('the 2026-11-16 West End and Broadway outputs are rejected', () => {
  // West End, as drafted.
  const we = {
    angle: 'split verdict',
    subject: 'Eurotrash splits the room at 77/100 from 26 critics',
    preheader: 'Our review scores for it run from a 100 rave to a 16 pan. Goblin and Florence also opened.',
    lede: 'Eurotrash settles at 77/100, but the reviews behind that number are far from settled. Our scores for individual write-ups run all the way from 100 down to 16, so this is one to read up on before you book.',
  };
  const p = checkCandidate(we, rxPool).join('\n');
  assert.match(p, /subject says critics were split/);
  assert.match(p, /preheader (?:says critics were split|uses one review's score \(16\))/);
  assert.match(p, /lede says critics were split/);
  // Broadway pattern: lead the preview with the pan, "not every critic was on board".
  assert.match(checkCandidate({ ...rxGood, preheader: 'It also drew the harshest review of the week, which we score at 16/100.' }, rxPool).join(), /one review's score \(16\)/);
  assert.match(checkCandidate({ ...rxGood, lede: `${rxGood.lede} It also drew the pan of the week, so not every critic was on board.` }, rxPool).join(), /lede says critics were split/);
});

test('split language is allowed about a show whose reception was split', () => {
  const f = { ...rxFacts, reception: [{ title: 'Eurotrash', verdict: 'split' }, { title: 'Goblin', verdict: 'liked' }] };
  const c = { ...rxGood, subject: 'Eurotrash splits critics at 77/100 from 26' };
  assert.ok(!checkCandidate(c, buildPool(f)).some(x => /split/.test(x)), checkCandidate(c, buildPool(f)).join());
  // Still wrong about the other show.
  assert.match(checkCandidate({ ...c, preheader: 'Goblin divided critics too and sits at 70.' }, buildPool(f)).join(), /preheader says critics were split/);
});

test('subject and preview text may not credit a critic with a score (Nov 9: "Frank Scheck gave it 98 out of 100")', () => {
  assert.match(checkCandidate({ ...rxGood, preheader: 'Jane Critic gave it 100 out of 100. Goblin also opened at 70.' }, rxPool).join(), /preheader says a critic gave a score/);
  assert.match(checkCandidate({ ...rxGood, preheader: 'Jane Critic called it the best of the year. Goblin sits at 70.' }, rxPool).join(), /preheader names a critic or outlet \(Jane Critic\)/);
});

test('the writer prompt offers the split angle only when a show was split', () => {
  assert.doesNotMatch(writerPrompt(rxPool), /the split verdict/);
  assert.match(writerPrompt(buildPool({ ...rxFacts, reception: [{ title: 'Eurotrash', verdict: 'split' }] })), /the split verdict/);
  assert.match(writerPrompt(rxPool), /Reception/);
});

test('second-opinion cases: honest copy passes, other split phrasings are caught, one outlier keeps a consensus', () => {
  // One pan among six reviews is still a show critics liked.
  assert.equal(receptionOf([90, 90, 90, 90, 90, 30]).verdict, 'liked');
  assert.equal(receptionOf([80, 80, 40, 40]).verdict, 'split');
  assert.doesNotMatch(receptionLine('X', [75, 75, 72, 60, 60, 40, 30]), /middling/);
  const check = (field, text) => checkCandidate({ ...rxGood, [field]: text }, rxPool).filter(x => /split/.test(x));
  for (const ok of ['Eurotrash, a family divided by war, lands at a solid 77/100', 'Goblin sits at 70. Not everyone will want three hours.', 'Goblin sits at 70, a split-level set and all.']) {
    assert.deepEqual(check('preheader', ok), [], ok);
  }
  for (const bad of ['Critics disagreed on Goblin, which sits at 70.', 'Goblin is a love it or loathe it show at 70.', 'Critics at odds over Goblin at 70.', 'Goblin divides critics and sits at 70.', 'Goblin was not unanimous and sits at 70.']) {
    assert.ok(check('preheader', bad).length, bad);
  }
  // A real Critic Score that equals the pan's number is not the pan.
  const f = { ...rxFacts, lines: [...rxFacts.lines, 'Opening: Gloom, Off West End, play, opened this week, on Friday, Nov 20. Critic Score 16/100 from 5 critics.'], titles: [...rxFacts.titles, { id: 'gl', slug: 'gl', title: 'Gloom' }] };
  assert.ok(!checkCandidate({ ...rxGood, preheader: 'Goblin sits at 70 and Gloom sinks to 16/100.' }, buildPool(f)).some(x => /one review/.test(x)));
});

test('ship-check cases (2026-11-22)', () => {
  // Star bands: 70 is three stars, 50 is two.
  assert.notEqual(receptionOf([70, 70, 50]).verdict, 'liked');
  assert.equal(receptionOf([null, '', 90, 90, 90]).verdict, 'liked', 'null and blank are not pans');
  assert.match(receptionLine('X', [80, 40, 60]), /reviews were mixed/);
  assert.match(receptionLine('X', [60, 60, 65, 80, 45]), /mostly middling/);
  // One split show does not license split talk about another in the same field.
  const f = { ...rxFacts, reception: [{ title: 'Eurotrash', verdict: 'split' }, { title: 'Goblin', verdict: 'liked' }] };
  const fp = buildPool(f);
  assert.match(checkCandidate({ ...rxGood, lede: 'Eurotrash lands at 77/100 and splits the room. Goblin divided critics at 70.' }, fp).join(), /lede says critics were split/);
  assert.match(checkCandidate({ ...rxGood, lede: 'Eurotrash and Goblin both divided critics, at 77/100 and 70.' }, fp).join(), /lede says critics were split/);
  for (const bad of ["Critics weren't unanimous on Goblin at 70.", 'Some critics loved Goblin, others did not.', 'Critics are at loggerheads over Goblin at 70.', 'Reviews ran hot and cold for Goblin at 70.']) {
    assert.ok(checkCandidate({ ...rxGood, preheader: bad }, rxPool).some(x => /split/.test(x)), bad);
  }
  for (const ok of ['Goblin, about a polarizing figure, sits at 70.', 'Goblin, a contentious history play, sits at 70.']) {
    assert.ok(!checkCandidate({ ...rxGood, preheader: ok }, rxPool).some(x => /split/.test(x)), ok);
  }
  // The rave of a disliked show is 100: "42/100" elsewhere is not that rave.
  const d = {
    ...rxFacts,
    lines: [rxFacts.lines[0], 'Opening: Dud, Off West End, play, opened this week, on Friday, Nov 20. Critic Score 42/100 from 20 critics.',
      "Rave of the week: our score for Jane Critic (The Paper)'s review of Dud is 100 out of 100.",
      "Pan of the week: our score for John Critic (The Other Paper)'s review of Goblin is 20 out of 100."],
    reception: [{ title: 'Dud', verdict: 'disliked' }, { title: 'Goblin', verdict: 'liked' }],
    titles: [{ id: 'd', slug: 'd', title: 'Dud' }, { id: 'g', slug: 'g', title: 'Goblin' }],
    leadTitles: ['Dud'],
  };
  const dp = buildPool(d);
  const ok = { angle: 'a', subject: 'Dud stumbles to a weak 42/100 from 20 critics', preheader: 'Goblin fares better. Critics broadly liked it.', lede: 'Dud lands at a weak 42/100, and critics broadly disliked it. Goblin did better.' };
  assert.ok(!checkCandidate(ok, dp).some(x => /one review/.test(x)), checkCandidate(ok, dp).join());
  assert.match(checkCandidate({ ...ok, preheader: 'One critic scored Dud a perfect 100 anyway.' }, dp).join(), /one review's score \(100\)/);
});

// BRO-8053: the Sunday refresh of 2026-11-16 told West End readers Top Gunchained's
// "final performance is Saturday, Nov 21" on Sunday the 22nd.
const tgFacts = {
  ...rxFacts,
  lines: [
    ...rxFacts.lines,
    'Opening: Top Gunchained, Off West End, play at Some Theatre, opened this week, on Tuesday, Nov 17. Critic Score 79/100 from 6 critics. It has already closed: its final performance was Saturday, Nov 21. Never write that readers can still see it or that it is closing.',
  ],
  titles: [...rxFacts.titles, { id: 't', slug: 't', title: 'Top Gunchained' }],
  leadTitles: [...rxFacts.leadTitles, 'Top Gunchained'],
};
const tgPool = buildPool(tgFacts);
const tgGood = {
  angle: 'best-reviewed opening',
  subject: 'Top Gunchained hits 79/100 from 6 critics',
  preheader: 'It was the week\'s best London score. Eurotrash is close behind at 77.',
  lede: 'Top Gunchained was the best-scoring London opening this week at a solid 79/100. Eurotrash is close behind at 77, and Goblin lands at 70.',
};

test('a show that already closed may be praised but never called still on or closing (BRO-8053)', () => {
  assert.deepEqual(tgPool.closedTitles, ['Top Gunchained']);
  assert.deepEqual(checkCandidate(tgGood, tgPool), []);
  // The live 2026-11-22 preheader.
  assert.match(checkCandidate({ ...tgGood, preheader: "It's the week's best London score, and its final performance is Saturday, Nov 21." }, tgPool).join(), /preheader talks about a show that has already closed/);
  assert.match(checkCandidate({ ...tgGood, subject: 'Last chance: Top Gunchained hits 79/100' }, tgPool).join(), /subject talks about a show that has already closed/);
  assert.match(checkCandidate({ ...tgGood, lede: 'Top Gunchained scores 79/100 and closes Saturday. Eurotrash sits at 77, Goblin at 70.' }, tgPool).join(), /lede talks about a show that has already closed/);
  // Closing words about a show still running stay allowed.
  assert.doesNotMatch(checkCandidate({ ...tgGood, preheader: 'Eurotrash is close behind at 77 and still running.' }, tgPool).join(), /already closed/);
  // Nothing closed: the check is off (base fixture says "ends Wednesday" of a running show).
  assert.deepEqual(pool.closedTitles, []);
});
