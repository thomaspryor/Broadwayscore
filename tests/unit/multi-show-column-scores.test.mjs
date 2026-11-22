// LIVE-DATA-LANE: reads data/shows.json and data/review-texts (untracked core and private data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
// BRO-7877: multi-show critic columns are scored on the target show's section only.
// (1) Vulture columns: scoreTimeColumnSection (scripts/lib/column-section-extract.js) cuts the target's
//     section; the scorer's trim and detector call it (scripts/llm-scoring/trim-multi-show.ts).
// (2) Finkle First Nighter columns: every scored, included column the asterisk divider can split
//     was scored on that section (multiShowTrim provenance), including the 8 BRO-7346-b rescores.
// The private-data checks read data/review-texts (REVIEW_TEXTS_DIR overrides) and skip when absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../..');
const { scoreTimeColumnSection, knownTitleVariants, isolateColumnSection } = require('../../scripts/lib/column-section-extract.js');
const { trimByAsteriskDivider } = require('../../scripts/lib/multi-show-asterisk-divider.js');

const showsRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
const SHOWS = showsRaw.shows || showsRaw;
const AVA_ID = 'ava-the-secret-conversations-off-broadway-2025';
const AVA = SHOWS.find((s) => s.id === AVA_ID);
const FRANK = SHOWS.find((s) => s.id === 'morgan-bassichis-can-i-be-frank-off-broadway-2026');
const VULTURE_URL = 'https://www.vulture.com/article/theater-reviews-ava-frank.html';

// Invented prose in the Vulture column's layout: caption, opener naming the show, body, next show, wrap-up.
const body = (s) => `${s} The staging is careful and the performances give the evening a steady pulse throughout. `.repeat(6);
const COLUMN = [
  'An actor as the star in Ava: The Secret Conversations. Photo: A Photographer',
  `The legend haunts Ava: The Secret Conversations, a two-hander about a film star. ${body('The writing circles its subject.')}`,
  body('The lead relishes the role and the scene partner holds his own.'),
  `If there are revelations to uncover, Ava: The Secret Conversations does not find them. ${body('It stays polite.')}`,
  `At a downtown playhouse in Can I Be Frank?, a comedian plays an invented icon. ${body('The act is stuffed inside another act.')}`,
  `Can I Be Frank? knows the attention economy of its business. ${body('The jokes land in clusters.')}`,
  body('The second half slows, then the finale pays off the setup.'),
  'Ava: The Secret Conversations is at City Center. Can I Be Frank? is at the playhouse.',
].join('\n');

test('fixtures: both catalogue titles exist (the column prints only the part after "Morgan Bassichis: ")', () => {
  assert.ok(AVA, 'Ava show entry');
  assert.ok(FRANK, 'Can I Be Frank? show entry');
  assert.match(FRANK.title, /^Morgan Bassichis: Can I Be Frank\?$/);
  assert.ok(knownTitleVariants(FRANK.title).includes('can i be frank'));
});

test('a Vulture column is cut to the target section, not the whole column', () => {
  const r = scoreTimeColumnSection({ url: VULTURE_URL, text: COLUMN, show: AVA, allShows: SHOWS });
  assert.equal(r.isolated, true, JSON.stringify(r));
  assert.match(r.text, /two-hander/);
  assert.doesNotMatch(r.text, /Can I Be Frank/);
  assert.doesNotMatch(r.text, /attention economy/);
  // The other show's section, from the same function.
  const f = scoreTimeColumnSection({ url: VULTURE_URL, text: COLUMN, show: FRANK, allShows: SHOWS });
  assert.equal(f.isolated, true, JSON.stringify(f));
  assert.match(f.text, /attention economy/);
  assert.doesNotMatch(f.text, /two-hander/);
});

test('the catalogue title "Morgan Bassichis: Can I Be Frank?" alone splits the column (BRO-7877: it used to read as one show)', () => {
  // Before BRO-7877 the catalogue title was dropped as "not named in this column" and the page read as one show.
  const r = isolateColumnSection(COLUMN, AVA.title, { knownTitles: [FRANK.title] });
  assert.equal(r.action, 'isolated');
});

test('refusals: other hosts, single reviews, and a kept caption or credit block', () => {
  assert.equal(scoreTimeColumnSection({ url: 'https://example-blog.com/x', text: COLUMN, show: AVA, allShows: SHOWS }).isolated, false);
  const single = COLUMN.split('\n').slice(0, 4).join('\n');
  assert.equal(scoreTimeColumnSection({ url: VULTURE_URL, text: single, show: AVA, allShows: SHOWS }).isolated, false);
  // Target section is a caption plus a short line: under the score-time minimum, so the whole page stays.
  const thin = [
    'An actor as the star in Ava: The Secret Conversations.',
    `Ava: The Secret Conversations opens the night. ${'Short words here. '.repeat(16)}`,
    `At a downtown playhouse in Can I Be Frank?, a comedian plays an icon. ${body('The act is stuffed.')}`,
    `Can I Be Frank? knows its business. ${body('The jokes land.')}`,
    'Both are running now.',
  ].join('\n');
  const t = scoreTimeColumnSection({ url: VULTURE_URL, text: thin, show: AVA, allShows: SHOWS });
  assert.equal(t.isolated, false);
});

test('the scorer trim and detector are wired to the column section', () => {
  const trim = fs.readFileSync(path.join(ROOT, 'scripts/llm-scoring/trim-multi-show.ts'), 'utf8');
  const det = fs.readFileSync(path.join(ROOT, 'scripts/llm-scoring/multi-show-detector.ts'), 'utf8');
  assert.match(trim, /scoreTimeColumnSection\(/);
  assert.match(trim, /trimByColumnSection\(fullText, targetShowId, source\)/);
  assert.match(det, /trimByColumnSection\(text, targetShowId, source\)/);
});

// ---- Private data (CI checks out the review-texts repo; local runs link it) ----
const TEXTS = process.env.REVIEW_TEXTS_DIR || path.join(ROOT, 'data/review-texts');
const readReview = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(TEXTS, rel), 'utf8')); } catch { return null; } };

test('real Ava Vulture column: section only, the other two reviews cut', (t) => {
  const r = readReview(`${AVA_ID}/vulture--jackson-mchenry.json`);
  if (!r || !/Can I Be Frank\?/.test(r.fullText || '')) return t.skip('full Ava column not in local review texts');
  const cut = scoreTimeColumnSection({ url: r.url, text: r.fullText, show: AVA, allShows: SHOWS });
  assert.equal(cut.isolated, true, JSON.stringify(cut));
  assert.ok(cut.text.length < r.fullText.length * 0.6, `${cut.text.length} of ${r.fullText.length}`);
  assert.doesNotMatch(cut.text, /Can I Be Frank|Let You Go/);
});

const BRO_7346_B = ['ernest-shackleton-loves-me-off-broadway-2017', 'fade-off-broadway-2017', 'fool-for-love-2015',
  'god-of-vengeance-off-broadway-2016', 'henry-iv-off-broadway-2015', 'othello-the-remix-off-broadway-2016',
  'the-gin-game-2015', 'turn-me-loose-off-broadway-2016'];

test('the 8 BRO-7346-b Finkle rows were rescored on their section', (t) => {
  const rows = BRO_7346_B.map((id) => [id, readReview(`${id}/huffpost--david-finkle.json`)]);
  if (rows.some(([, r]) => !r)) return t.skip('Finkle review texts not available');
  for (const [id, r] of rows) {
    assert.ok(!r.needsRescore, `${id} still needsRescore`);
    assert.equal(r.multiShowTrim?.method, 'asterisk-divider', `${id} scored without the section trim`);
    assert.ok(r.multiShowTrim.scoredLength < r.multiShowTrim.originalLength, id);
    assert.ok(Date.parse(r.llmMetadata?.scoredAt) > Date.parse('2026-11-19T20:45:53Z'), `${id} not rescored after the plan`);
  }
});

test('audit: every scored, included Finkle column the divider splits was scored on its section', (t) => {
  if (!fs.existsSync(TEXTS)) return t.skip('review texts not available');
  const byId = new Map(SHOWS.map((s) => [s.id, s]));
  const wrong = []; let columns = 0;
  for (const dir of fs.readdirSync(TEXTS)) {
    const r = readReview(`${dir}/huffpost--david-finkle.json`);
    if (!r || !r.fullText || r.assignedScore == null || !byId.has(r.showId)) continue;
    const cut = trimByAsteriskDivider(r.fullText, byId.get(r.showId).title, r);
    if (!cut.trimmed) continue;
    columns++;
    if (r.wrongProduction || r.wrongShow || r.isRoundupArticle || r.duplicateOf) continue; // not displayed
    if (r.multiShowTrim?.method !== 'asterisk-divider' || r.multiShowTrim.scoredLength !== cut.trimmedLength) wrong.push(dir);
  }
  if (!columns) return t.skip('no Finkle columns in local review texts');
  assert.deepEqual(wrong, [], `scored on the whole column: ${wrong.join(', ')}`);
});
