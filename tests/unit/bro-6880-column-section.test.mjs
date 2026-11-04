// BRO-6880: a T1/T2 multi-show critic column (Washington Post shape) keeps only the
// target show's section; a true roundup (quotes other critics) is still refused.
// v2: the isolation runs only after the verifier rejects the page as a multi-show page (never on the write path).
// Synthetic prose, not article text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { isolateMultiShowSection } = require('../../scripts/lib/multi-show-section-extract.js');
const { isolateColumnSection, countOtherCriticAttributions, columnSectionAfterRoundupRejection, isMultiShowRejection } = require('../../scripts/lib/column-section-extract.js');

const URL = 'https://www.washingtonpost.com/entertainment/theater/2026/10/23/stars-are-shining-broadway-an-upstart-musical-upstages-them-all/';
const TITLES = ['Other Desert Cities', 'School Girls; Or, The African Mean Girls Play', 'The Imaginary Invalid', 'Hamilton'];
const filler = (tag, n = 5) => Array.from({ length: n }, (_, i) => `The ${tag} cast keeps a steady pace through scene ${i + 1} and the staging stays clear.`).join(' ');

const ODC = `‘Other Desert Cities’ returns with a family fight over a memoir. ${filler('ODC')} ‘Other Desert Cities’ still has bite.\n\nThe second act of the ODC revival lands the reveal cleanly. ${filler('ODC-two')}`;
const SG = `Over at another house, ‘School Girls; Or, The African Mean Girls Play’ follows a clique in Ghana. ${filler('SG')} Seeing ‘School Girls; Or, The African Mean Girls Play’ again is a pleasure.\n\nThe ensemble of the SG production shares one voice. ${filler('SG-two')}`;
const TII = `Best of the three is ‘The Imaginary Invalid,’ a farce about a man sure he is dying. ${filler('TII')} ‘The Imaginary Invalid’ is the one to see.\n\nIts closing scene earns the loudest laugh of the column. ${filler('TII-two')}`;
const COLUMN = `Three openings this week, and one clear winner.\n\n${ODC}\n\n${SG}\n\n${TII}`;

test('WaPo three-show column: the real isolation function keeps only the target section', () => {
  const iso = isolateColumnSection(COLUMN, 'The Imaginary Invalid', { knownTitles: TITLES });
  assert.equal(iso.action, 'isolated');
  assert.match(iso.text, /closing scene earns the loudest laugh/);
  assert.doesNotMatch(iso.text, /ODC|School Girls|SG production|Three openings/);
  const sg = isolateColumnSection(COLUMN, 'School Girls; Or, The African Mean Girls Play', { knownTitles: TITLES });
  assert.equal(sg.action, 'isolated');
  assert.match(sg.text, /ensemble of the SG production/);
  assert.doesNotMatch(sg.text, /Imaginary|ODC/);
});

test('a wrap-up paragraph naming several shows belongs to no section', () => {
  const wrap = `Compared with ‘Other Desert Cities’ and ‘School Girls; Or, The African Mean Girls Play’, this one is the funniest.`;
  const iso = isolateColumnSection(`${COLUMN}\n\n${wrap}`, 'The Imaginary Invalid', { knownTitles: TITLES });
  assert.equal(iso.action, 'isolated');
  assert.doesNotMatch(iso.text, /Compared with/);
});

test('true roundup that quotes other critics is refused, not isolated', () => {
  const quotes = (t) => `According to The New York Times, ${t} is a delight. Variety called it a triumph, and Jesse Green of the Times wrote that it sings.`;
  const roundup = `Critics weigh in this week.\n\n${ODC}\n\n${quotes('‘Other Desert Cities’')}\n\n${SG}\n\n${TII}\n\n${quotes('‘The Imaginary Invalid’')}`;
  assert.ok(countOtherCriticAttributions(roundup) >= 2);
  const iso = isolateColumnSection(roundup, 'The Imaginary Invalid', { knownTitles: TITLES });
  assert.equal(iso.action, 'refuse');
  assert.equal(iso.text, null);
  assert.equal(iso.reason, 'roundup');
});

test('target not in the column, or too thin, is refused rather than guessed', () => {
  assert.equal(isolateColumnSection(COLUMN, 'Hamilton', { knownTitles: TITLES }).action, 'refuse');
  const thin = `‘Other Desert Cities’ opens here. ${filler('A')}\n\n${ODC}\n\n${SG}\n\nQuick note on ‘The Imaginary Invalid’: fun.`;
  assert.equal(isolateColumnSection(thin, 'The Imaginary Invalid', { knownTitles: TITLES }).action, 'refuse');
});

test('a single-show WaPo review that mentions another show in passing is left whole', () => {
  const single = `‘The Imaginary Invalid’ is a farce about a hypochondriac. ${filler('TII', 8)}\n\n${filler('TII-b', 8)}\n\nIt recalls ‘Hamilton’ only in its pace.\n\n${filler('TII-c', 8)}`;
  const iso = isolateColumnSection(single, 'The Imaginary Invalid', { knownTitles: TITLES });
  assert.equal(iso.action, 'single-section');
  assert.equal(iso.text, single);
});

test('non-column hosts are untouched; short text is returned unchanged', () => {
  assert.equal(isolateMultiShowSection('https://example.com/a', COLUMN, 'The Imaginary Invalid', [], TITLES).action, 'not-multi-show');
  assert.equal(isolateColumnSection('Short.', 'The Imaginary Invalid', { knownTitles: TITLES }).action, 'single-section');
});

// BRO-6872: some fetch routes flatten the column to one line. Sections are then found from each review's listing
// footer ("About 1 hour 30 minutes. example.org."), and a section belongs to the show it names first.
const foot = (site) => `Through Nov. 22 at the Example Theatre. About 1 hour 30 minutes. ${site}.org.`;
// Each section names its show more than once, as a real review does: a show named only in passing never owns a section.
const FLAT_ODC = `Two big names lead this week. ‘Other Desert Cities’ returns with a family fight over a memoir. ${filler('ODC', 8)} ‘Other Desert Cities’ still has bite. ${foot('odc')}`;
const FLAT_SG = `Here are two more. ‘School Girls; Or, The African Mean Girls Play’ follows a clique in Ghana. ${filler('SG', 8)} ‘School Girls; Or, The African Mean Girls Play’ rewards a second visit. ${foot('sg')}`;
const FLAT_TII = `If anyone can adapt Moliere, it is this company with ‘The Imaginary Invalid,’ a farce about a man sure he is dying. ${filler('TII', 6)} ‘The Imaginary Invalid’ is the one to see. Unlike ‘Other Desert Cities,’ it never sags. Sometimes that is just what the doctor ordered. ${foot('tii')}`;
const FLAT = [FLAT_ODC, FLAT_SG, FLAT_TII].join(' ');
const FLAT_TITLES = [...TITLES, 'The Doctor', 'Broadway'];

test('flattened column: the target section is kept, sentences naming another show are dropped', () => {
  assert.ok(!FLAT.includes('\n') && FLAT.length > 1500);
  const iso = isolateColumnSection(FLAT, 'The Imaginary Invalid', { knownTitles: FLAT_TITLES });
  assert.equal(iso.action, 'isolated');
  assert.match(iso.text, /^If anyone can adapt Moliere/);
  assert.match(iso.text, /just what the doctor ordered/, 'lower-case prose is not the title "The Doctor"');
  assert.match(iso.text, /tii\.org\.$/);
  assert.doesNotMatch(iso.text, /Desert Cities|School Girls|ODC|SG cast/);
  const sg = isolateColumnSection(FLAT, 'School Girls; Or, The African Mean Girls Play', { knownTitles: FLAT_TITLES });
  assert.equal(sg.action, 'isolated');
  assert.doesNotMatch(sg.text, /Imaginary|ODC/);
});

test('flattened column: refuses when the show owns no section or two; one footer is a single review', () => {
  assert.equal(isolateColumnSection(FLAT, 'Hamilton', { knownTitles: FLAT_TITLES }).action, 'refuse');
  const twice = `${FLAT} ‘The Imaginary Invalid’ again, briefly. ${filler('again', 6)} ‘The Imaginary Invalid’ holds up. ${foot('again')}`;
  assert.equal(isolateColumnSection(twice, 'The Imaginary Invalid', { knownTitles: FLAT_TITLES }).reason, 'ambiguous');
  const one = `${FLAT_TII} ${filler('more', 10)}`;
  assert.equal(isolateColumnSection(one, 'The Imaginary Invalid', { knownTitles: FLAT_TITLES }).action, 'single-section');
});

test('flattened column: a show named once in passing never owns a section (it would take the neighbour review)', () => {
  // Real case the first cut of this got wrong: in the Washington Post column of 2026-10-30, "Charlie and the
  // Chocolate Factory" appears once, as a Roald Dahl aside inside the section reviewing another show, and was
  // handed that whole section. A section's show must be named at least twice, and be the only one named early.
  const aside = FLAT.replace('Unlike ‘Other Desert Cities,’ it never sags.', 'It nods to ‘Hamilton’ once.');
  const passing = isolateColumnSection(aside, 'Hamilton', { knownTitles: [...FLAT_TITLES, 'Hamilton'] });
  assert.equal(passing.action, 'refuse');
  assert.equal(passing.text, null);
  // the real owner of that section is unaffected
  assert.equal(isolateColumnSection(aside, 'The Imaginary Invalid', { knownTitles: FLAT_TITLES }).action, 'isolated');
});

test('flattened column: a long column we cannot split refuses instead of storing every review as one', () => {
  const fourth = `Also open is ‘Dog Day Afternoon,’ back for a run. ${filler('DDA', 8)} ‘Dog Day Afternoon’ sells out all the same.`;
  const noFooters = `${FLAT} ${fourth}`.replaceAll(/About 1 hour 30 minutes\. \w+\.org\./g, 'It plays into next month.');
  assert.ok(noFooters.length > 1500 && !/\n/.test(noFooters));
  const r = isolateColumnSection(noFooters, 'The Imaginary Invalid', { knownTitles: [...FLAT_TITLES, 'Dog Day Afternoon'] });
  assert.equal(r.action, 'refuse');
  assert.equal(r.text, null);
  // a single review that name-drops one other show is still left alone
  const single = `${FLAT_TII.replaceAll(/About 1 hour 30 minutes\. \w+\.org\./g, 'It plays on.')} ${filler('more', 12)}`;
  assert.equal(isolateColumnSection(single, 'The Imaginary Invalid', { knownTitles: FLAT_TITLES }).action, 'single-section');
});

// Real corpus check (skipped in CI, where data/review-texts is private): the stored Washington Post column that
// covers five shows must never hand a show a section it does not own. No article text is pinned here.
test('real flattened column: no show is given another show\'s section', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const col = path.join(root, 'data/review-texts/death-of-a-salesman-2026/washpost--thomas-floyd.json');
  const showsPath = path.join(root, 'data/shows.json');
  if (!fs.existsSync(col) || !fs.existsSync(showsPath)) { t.skip('no local review texts'); return; }
  const raw = JSON.parse(fs.readFileSync(col, 'utf8'));
  const text = raw.fullText || raw.text || '';
  if (!text || /\n/.test(text.trim())) { t.skip('stored copy is not the flattened column'); return; }
  const shows = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const titles = (Array.isArray(shows) ? shows : shows.shows).map((s) => s.title);
  const { isolateFlatColumnSection } = require('../../scripts/lib/column-section-extract.js');
  for (const [title, expect] of [['Charlie and the Chocolate Factory', 'refuse'], ['Dog Day Afternoon', 'isolated']]) {
    const r = isolateFlatColumnSection(text, title, { aliases: [], knownTitles: titles });
    assert.ok(r, `${title}: the column should take the flat path`);
    assert.equal(r.action, expect, `${title}`);
    if (r.action === 'isolated') assert.ok(r.text.includes(title.split(' ')[0]), `${title}: kept text is its own section`);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// v2 gate: columnSectionAfterRoundupRejection. The column is cut only when the verifier REJECTED it as a multi-show
// page; a page the verifier accepts is stored as fetched.
const II_SHOW = { id: 'the-imaginary-invalid-2026', title: 'The Imaginary Invalid', category: 'broadway', openingDate: '2026-10-22' };
const ALL_SHOWS = [
  II_SHOW,
  { id: 'other-desert-cities-2026', title: 'Other Desert Cities', category: 'broadway', openingDate: '2026-10-18' },
  { id: 'school-girls-2026', title: 'School Girls; Or, The African Mean Girls Play', category: 'broadway', openingDate: '2026-10-20' },
  { id: 'hamilton-2015', title: 'Hamilton', category: 'broadway', openingDate: '2015-08-06' },
];
const MULTI_SHOW_REJECTION = {
  isValid: false, confidence: 'high', articleType: 'other',
  issues: ['Multi-show roundup: the article reviews three different productions (Other Desert Cities, School Girls, The Imaginary Invalid)'],
  reasoning: 'This is a multi-show column, not a single review of The Imaginary Invalid.',
};
const gate = (over = {}) => columnSectionAfterRoundupRejection({ url: URL, text: COLUMN, show: II_SHOW, allShows: ALL_SHOWS, verdict: MULTI_SHOW_REJECTION, ...over });

test('gate: a WaPo three-show column rejected as multi-show keeps only the target section', () => {
  const r = gate();
  assert.equal(r.isolated, true);
  assert.match(r.text, /closing scene earns the loudest laugh/);
  assert.doesNotMatch(r.text, /ODC|School Girls|SG production|Three openings/);
  const flat = gate({ text: FLAT });
  assert.equal(flat.isolated, true);
  assert.match(flat.text, /^If anyone can adapt Moliere/);
});

test('gate: the same column is never cut when the verifier accepted it, or rejected it for another reason', () => {
  assert.deepEqual(gate({ verdict: { ...MULTI_SHOW_REJECTION, isValid: true } }), { isolated: false, reason: 'not-multi-show-rejection' });
  assert.equal(gate({ verdict: null }).isolated, false);
  assert.equal(gate({ verdict: { isValid: false, issues: ['Truncated mid-sentence'], reasoning: 'Paywall.' } }).isolated, false);
  assert.equal(gate({ url: 'https://www.nytimes.com/2026/10/23/theater/x.html' }).reason, 'not-column-host');
});

test('gate: the verdict shape the real Imaginary Invalid column got (roundup/aggregation of the critic\'s own reviews) qualifies', () => {
  const real = {
    isValid: false, confidence: 'high', wrongArticle: true, articleType: 'review',
    issues: [
      'This is a multi-show roundup/aggregation, not a single-show review. The scraped content reviews at least three different Broadway productions.',
      'Expected review is for the show but the article is structured as a theater column/roundup covering multiple fall Broadway shows.',
    ],
    reasoning: 'It is a multi-show column or roundup that aggregates brief reviews of several Broadway productions.',
  };
  assert.equal(isMultiShowRejection(real), true);
  assert.equal(gate({ verdict: real }).isolated, true);
});

test('gate: a true roundup (other critics quoted) stays refused', () => {
  const quoteVerdict = { isValid: false, issues: ['Roundup aggregating multiple critics\' quotes, not a single review'], reasoning: 'Pull quotes from other critics.' };
  assert.equal(isMultiShowRejection(quoteVerdict), false);
  assert.equal(gate({ verdict: quoteVerdict }).isolated, false);
  // A verdict that only says multi-show, on a page that quotes other critics, is refused by the extractor.
  const quotes = (t) => `According to The New York Times, ${t} is a delight. Variety called it a triumph, and Jesse Green of the Times wrote that it sings.`;
  const roundup = `Critics weigh in this week.\n\n${ODC}\n\n${quotes('‘Other Desert Cities’')}\n\n${SG}\n\n${TII}\n\n${quotes('‘The Imaginary Invalid’')}`;
  assert.deepEqual(gate({ text: roundup }), { isolated: false, reason: 'roundup' });
});

test('gate: a single-show review the verifier wrongly calls multi-show is not cut (needs 2+ same-weeks shows named)', () => {
  const single = `‘The Imaginary Invalid’ is a farce about a hypochondriac. ${filler('TII', 8)}\n\n${filler('TII-b', 8)}\n\nIt recalls ‘Other Desert Cities’ only in its family fights.\n\n${filler('TII-c', 8)}`;
  assert.deepEqual(gate({ text: single }), { isolated: false, reason: 'not-a-column' });
});

test('write-time gate leaves Washington Post pages whole (isolation is verdict-gated, BRO-6880 v2)', () => {
  // Fails on the first cut, which isolated every washingtonpost.com write and truncated single-show reviews.
  assert.deepEqual(isolateMultiShowSection(URL, COLUMN, 'The Imaginary Invalid'), { action: 'not-multi-show', text: COLUMN });
  const { isolateMultiShowSectionForShowId } = require('../../scripts/lib/multi-show-section-extract.js');
  assert.equal(isolateMultiShowSectionForShowId(URL, COLUMN, 'the-imaginary-invalid-2026').action, 'not-multi-show');
  const { storedTextForm } = require('../../scripts/lib/stored-text-form.js');
  assert.equal(storedTextForm(FLAT, { url: URL, showTitle: 'The Imaginary Invalid' }).refused, false);
});

// Corpus regression (skipped where data/review-texts is absent, e.g. CI): over every stored Washington Post text,
// (1) the write-time gate changes nothing; (2) the v2 gate, given each file's own stored verdict, changes only pages
// that are multi-show columns by the lane's independent detector; (3) the single-show reviews the first cut truncated
// stay whole even under a simulated multi-show rejection. No article text is pinned here.
test('corpus: stored Washington Post texts change only when they are verifier-rejected multi-show columns', async (t) => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const dir = path.join(root, 'data/review-texts');
  const showsPath = path.join(root, 'data/shows.json');
  if (!fs.existsSync(dir) || !fs.existsSync(showsPath)) { t.skip('no local review texts'); return; }
  const raw = JSON.parse(fs.readFileSync(showsPath, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const byId = new Map(shows.map((s) => [s.id, s]));
  const lane = require('../../scripts/lib/opening-night-lane/lane-guards.js');
  let scanned = 0;
  const writeChanged = []; const gateChanged = []; const notColumn = [];
  for (const sid of fs.readdirSync(dir)) {
    const show = byId.get(sid);
    if (!show) continue;
    let files; try { files = fs.readdirSync(path.join(dir, sid)); } catch { continue; }
    for (const f of files.filter((x) => /^washpost.*\.json$/.test(x))) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, sid, f), 'utf8'));
      if (!d.fullText) continue;
      scanned++;
      const w = isolateMultiShowSection(d.url, d.fullText, show.title);
      if (w.text !== d.fullText) writeChanged.push(`${sid}/${f}`);
      const g = columnSectionAfterRoundupRejection({ url: d.url, text: d.fullText, show, allShows: shows, verdict: d.contentVerification });
      if (g.isolated) {
        gateChanged.push(`${sid}/${f}`);
        if (!lane.multiShowColumnReason({ url: d.url, fullText: d.fullText }, lane.nearbyShowTitles(show, shows))) notColumn.push(`${sid}/${f}`);
      }
    }
  }
  if (scanned < 50) { t.skip(`only ${scanned} stored Washington Post texts`); return; }
  assert.deepEqual(writeChanged, [], 'the write-time gate must not cut any stored Washington Post text');
  assert.deepEqual(notColumn, [], 'only multi-show columns may be cut');
  for (const sid of ['funny-girl-2022', 'six-2021', 'spamalot-2023', 'the-wiz-2024', 'sweeney-todd-2023', 'bloody-bloody-andrew-jackson-2010']) {
    const show = byId.get(sid);
    let files = []; try { files = fs.readdirSync(path.join(dir, sid)).filter((x) => /^washpost.*\.json$/.test(x)); } catch { /* absent */ }
    for (const f of files) {
      const d = JSON.parse(fs.readFileSync(path.join(dir, sid, f), 'utf8'));
      if (!d.fullText) continue;
      const g = columnSectionAfterRoundupRejection({ url: d.url, text: d.fullText, show, allShows: shows, verdict: MULTI_SHOW_REJECTION });
      assert.equal(g.isolated, false, `${sid}/${f}: a single-show review is never cut, even on a wrong multi-show verdict`);
    }
  }
});

test('flattened column: a closing capsule that names its show once owns its section; a one-off aside does not', () => {
  // The real 10-23 column's Imaginary Invalid capsule names the show once, as the section's first quoted title.
  const capsule = `If a veteran clown is going to stage Moliere's farce “The Imaginary Invalid,” he may as well star in it. ${filler('TII', 6)} Sometimes that is just what the doctor ordered. ${foot('tii')}`;
  const col = [FLAT_ODC, FLAT_SG, capsule].join(' ');
  const r = isolateColumnSection(col, 'The Imaginary Invalid', { knownTitles: FLAT_TITLES });
  assert.equal(r.action, 'isolated');
  assert.match(r.text, /veteran clown/);
  // The same single mention inside a section whose first quoted title is another (one-word) show owns nothing.
  const aside = `Much of the talk around “Giant,” a play about a famous author, is its star. It nods to “The Imaginary Invalid” once. ${filler('GI', 6)} ${foot('gi')}`;
  const r2 = isolateColumnSection([FLAT_ODC, FLAT_SG, aside].join(' '), 'The Imaginary Invalid', { knownTitles: FLAT_TITLES });
  assert.equal(r2.action, 'refuse');
});
