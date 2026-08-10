import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const {
  placementsOf,
  findUnrenderedOpenings,
  subjectShowMissingFromBody,
  renderInvariantFailures,
} = require('./newsletter-render-invariants.js');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── The 2026-08-09 bug, reproduced ────────────────────────────────────────
// meta listed four West End openings; the coverage-gap swap dropped them from
// the HTML; the title still appeared in the lede, so a substring grep said
// "present" and the session reported success.
const BUGGY_HTML = `
  <div>Now You See Me Live opens to decent reviews.</div>
  <p>This week in the West End, I&#39;m Every Woman opened at the Peacock.</p>
  <h2>Closing this Week</h2><p>Some other show</p>
  <h2>Rave &amp; Pan of the Week</h2><p>I&#39;m Every Woman got a rave.</p>
  <h2>Coming Up</h2><p>Next week</p>`;

const OPENINGS = [
  { id: 'the-comedy-about-spies-west-end-2026', title: 'The Comedy About Spies' },
  { id: 'cats-west-end-2026', title: 'Cats' },
  { id: 'now-you-see-me-live-west-end-2026', title: 'Now You See Me Live' },
  { id: 'im-every-woman-off-west-end-2026', title: "I'm Every Woman" },
];

test('the substring check that fooled a session still "passes" — proving why it is useless', () => {
  // This is the exact check that was used to report success. It is true.
  assert.ok(BUGGY_HTML.includes('Every Woman'));
  // And yet the show is not rendered as an opening. Hence everything below.
});

test('placementsOf reports WHERE a title appears, not merely THAT it does', () => {
  const hits = placementsOf(BUGGY_HTML, 'Every Woman');
  assert.ok(hits.length >= 2, 'expected the lede hit and the Rave & Pan hit');
  assert.equal(hits[0].section, null, 'first hit is before any heading (the lede)');
  assert.ok(
    hits.some((h) => h.section && h.section.includes('Rave')),
    'later hit sits under Rave & Pan — not an openings section'
  );
});

test('findUnrenderedOpenings catches openings the swap deleted', () => {
  const missing = findUnrenderedOpenings(BUGGY_HTML, OPENINGS);
  const ids = missing.map((m) => m.id);
  assert.ok(ids.includes('the-comedy-about-spies-west-end-2026'), 'Comedy About Spies was dropped');
  assert.ok(ids.includes('cats-west-end-2026'), 'Cats was dropped');
  // Now You See Me Live and I'm Every Woman DO appear in the text (lede /
  // Rave & Pan), so this function does not flag them — that is correct and
  // deliberate: it is the "did anything vanish entirely" invariant. The
  // where-did-it-render question is placementsOf's job.
});

test('a correct render trips nothing', () => {
  const good =
    `<h2>Opened in the West End</h2>` +
    OPENINGS.map((s) => `<h3>${s.title}</h3><p>review</p>`).join('') +
    `<h2>Closing this Week</h2>`;
  assert.deepEqual(findUnrenderedOpenings(good, OPENINGS), []);
  assert.deepEqual(renderInvariantFailures({ html: good, meta: { openingShows: OPENINGS } }), []);
});

test('subject promising a show the body never covers is caught', () => {
  const html = `<h2>Closing this Week</h2><p>nothing relevant</p>`;
  const missing = subjectShowMissingFromBody(
    'Now You See Me Live opens to decent reviews.',
    html,
    OPENINGS
  );
  assert.equal(missing, 'Now You See Me Live');
});

test('subject check prefers the longest matching title (no substring collisions)', () => {
  const shows = [
    { id: 'spies', title: 'The Comedy About Spies' },
    { id: 'comedy', title: 'Comedy' },
  ];
  const html = `<p>The Comedy About Spies opened.</p>`;
  assert.equal(
    subjectShowMissingFromBody('The Comedy About Spies opens to strong reviews.', html, shows),
    null,
    'the longer title matched and is present, so no failure'
  );
});

test('editorial subject naming no featured show never trips the check', () => {
  assert.equal(
    subjectShowMissingFromBody('A quiet week in the West End', '<p>anything</p>', OPENINGS),
    null
  );
});

test('curly apostrophes and entities do not create false failures', () => {
  const shows = [{ id: 'iew', title: 'I’m Every Woman' }];
  const html = `<h2>Opened</h2><h3>I&#39;m Every Woman</h3>`;
  assert.deepEqual(findUnrenderedOpenings(html, shows), [],
    "curly-quote title vs &#39; entity in HTML must match — this exact title is the show that went missing");
});

test('renderInvariantFailures produces actionable messages, not booleans', () => {
  const failures = renderInvariantFailures({
    html: BUGGY_HTML,
    meta: { subject: 'Now You See Me Live opens to decent reviews.', openingShows: OPENINGS },
  });
  assert.ok(failures.length >= 2, 'expected the dropped openings to be reported');
  assert.ok(failures.some((f) => f.includes('The Comedy About Spies')));
  assert.ok(
    failures.some((f) => f.includes('Do NOT verify this by grepping')),
    'the message must steer the reader away from the check that failed tonight'
  );
});

// ── Word-boundary regressions ────────────────────────────────────────────
// A reviewer caught both of these with real data before this shipped.
// data/shows.json has 448 single-word titles including "Art", "Home", "Elf",
// "Bug", "Chess", "Job", "English". Plain includes() breaks BOTH ways.

test('BLOCKER 1: an editorial subject containing "smart" must not match the show "Art"', () => {
  const shows = [{ id: 'art-2025', title: 'Art' }];
  const html = '<p>Nothing about that show here.</p>';
  assert.equal(
    subjectShowMissingFromBody('A smart pick for theatergoers this week', html, shows),
    null,
    'substring matching would hard-fail here and block a correct Sunday send'
  );
});

test('BLOCKER 2: "Art" genuinely dropped is still caught even when "smart" appears', () => {
  const shows = [{ id: 'art-2025', title: 'Art' }];
  const html = '<h2>Opened</h2><p>The smart set went uptown instead.</p>';
  const missing = findUnrenderedOpenings(html, shows);
  assert.deepEqual(missing.map((m) => m.id), ['art-2025'],
    'substring matching would match "art" inside "smart" and silently miss the drop');
});

test('a genuinely present single-word title still passes, with punctuation around it', () => {
  const shows = [{ id: 'art-2025', title: 'Art' }];
  for (const body of ['<h3>Art</h3>', '<p>Art, revived.</p>', '<p>(Art)</p>', '<p>"Art" opened.</p>']) {
    assert.deepEqual(findUnrenderedOpenings(body, shows), [], `should pass: ${body}`);
  }
});

test('titles ending in punctuation match (the \\b trap)', () => {
  const shows = [{ id: 'schmig', title: 'Schmigadoon!' }];
  assert.deepEqual(findUnrenderedOpenings('<h3>Schmigadoon!</h3>', shows), []);
  // and a near-miss must still be reported
  assert.equal(findUnrenderedOpenings('<h3>Schmigadoonery</h3>', shows).length, 1);
});

test('possessive/colon titles match', () => {
  const shows = [{ id: 'rosie', title: "Rosie O'Donnell: Common Knowledge" }];
  assert.deepEqual(
    findUnrenderedOpenings("<h3>Rosie O&#39;Donnell: Common Knowledge</h3>", shows),
    []
  );
});

test('empty/malformed input degrades safely rather than throwing', () => {
  assert.deepEqual(findUnrenderedOpenings('', []), []);
  assert.deepEqual(findUnrenderedOpenings(null, null), []);
  assert.deepEqual(renderInvariantFailures({ html: null, meta: null }), []);
  assert.deepEqual(placementsOf(null, null), []);
  assert.equal(subjectShowMissingFromBody(null, null, null), null);
});

// ── Live corpus: no false positives on the real, correct draft ────────────
test('the real generated draft passes (guards against a false-alarm gate)', (t) => {
  const dir = path.join(process.env.HOME || '', 'Documents/claude-outputs/newsletter-mocks');
  let htmlPath = null;
  let metaPath = null;
  try {
    const files = fs.readdirSync(dir);
    const html = files.find((f) => f.endsWith('.html'));
    const meta = files.find((f) => f.endsWith('.meta.json'));
    if (html && meta) {
      htmlPath = path.join(dir, html);
      metaPath = path.join(dir, meta);
    }
  } catch {
    /* not present in CI */
  }
  if (!htmlPath) return t.skip('no locally generated draft available');
  const html = fs.readFileSync(htmlPath, 'utf8');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const failures = renderInvariantFailures({ html, meta });
  assert.deepEqual(failures, [],
    `the real draft must pass; a gate that fires on a correct newsletter would be turned off within a week:\n${failures.join('\n')}`);
});
