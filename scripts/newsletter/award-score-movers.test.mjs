import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '../..');
const week = '2026-10-26';

function fixture(t, westEndDates = ['2026-10-24', '2026-10-31'], londonOpening = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newsletter-award-movers-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const history = path.join(dir, 'history');
  fs.mkdirSync(history);
  const shows = ['broadway', 'west-end'].map((market) => ({
    id: `award-fixture-${market}`, slug: `award-fixture-${market}`,
    title: market === 'west-end' ? 'London Award Fixture' : 'Broadway Award Fixture',
    category: market, status: 'open', type: 'musical', venue: 'Fixture Theatre',
    openingDate: londonOpening && market === 'west-end' ? week : '2020-01-01',
    previewsStartDate: '2019-12-01',
  }));
  fs.writeFileSync(path.join(dir, 'shows.json'), JSON.stringify({ shows }));
  fs.writeFileSync(path.join(dir, 'reviews.json'), JSON.stringify({ reviews: [] }));
  if (londonOpening) {
    fs.writeFileSync(path.join(dir, 'award-fixture-west-end.json'), JSON.stringify({ cs: 82, rc: 5 }));
  }
  for (const show of shows) {
    const dates = show.category === 'west-end' ? westEndDates : ['2026-10-24', '2026-10-31'];
    dates.forEach((date, i) => {
      const filename = `${date}${show.category === 'west-end' ? '-west-end' : ''}.json`;
      fs.writeFileSync(path.join(history, filename), JSON.stringify({
        snapshotDate: date, market: show.category,
        shows: { [show.id]: { title: show.title, displayScore: i ? 75 : 50, badge: i ? 'decorated' : 'nominated' } },
      }));
    });
  }
  function generate(edition, issueWeek = week) {
    const output = path.join(dir, edition);
    execFileSync(process.execPath, ['scripts/newsletter/generate.mjs', issueWeek], {
      cwd: repo, timeout: 60_000, stdio: 'pipe',
      env: {
        ...process.env, GA4_PROPERTY_ID: '', NEWSLETTER_EDITION: edition,
        NEWSLETTER_OUT_DIR: output, NEWSLETTER_STATE_PATH: path.join(dir, 'state.json'),
        NEWSLETTER_TEST_SHOWS_PATH: path.join(dir, 'shows.json'),
        NEWSLETTER_TEST_REVIEWS_PATH: path.join(dir, 'reviews.json'),
        NEWSLETTER_TEST_COMPOSITES_DIR: dir, AWARD_SCORE_HISTORY_DIR: history,
        NEWSLETTER_DROP_SECTIONS: '', NEWSLETTER_INCLUDE_SECTIONS: '',
      },
    });
    return {
      html: fs.readFileSync(path.join(output, `A-${issueWeek}.html`), 'utf8'),
      meta: JSON.parse(fs.readFileSync(path.join(output, `A-${issueWeek}.meta.json`), 'utf8')),
      state: JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')),
    };
  }
  return { generate };
}

test('each edition renders its own award movers and keeps snapshot deduplication separate', (t) => {
  const { generate } = fixture(t);
  const broadway = generate('broadway');
  assert.equal(broadway.meta.sections.find((s) => s.name === 'award-score-movers').fired, true);
  assert.match(broadway.html, /Tony race/);
  assert.match(broadway.html, /Broadway Award Fixture/);
  assert.doesNotMatch(broadway.html, /London Award Fixture/);

  // The earlier Broadway issue must not suppress a later West End issue
  // comparing the same snapshots.
  const london = generate('west-end', '2026-11-02');
  assert.equal(london.meta.sections.find((s) => s.name === 'award-score-movers').fired, true);
  assert.match(london.html, /Award Score Movers/);
  assert.match(london.html, /Olivier race/);
  assert.match(london.html, /London Award Fixture/);
  assert.doesNotMatch(london.html, /Tony race|Broadway Award Fixture/);
  const londonState = london.state.issues.find((issue) => issue.edition === 'west-end');
  assert.equal(londonState.awardMoverSnapshotDate, '2026-10-31');
  assert.ok(londonState.featuredShowIds.includes('award-fixture-west-end'));

  const repeated = generate('west-end', '2026-11-09');
  assert.equal(repeated.meta.sections.find((s) => s.name === 'award-score-movers').fired, false);
  assert.doesNotMatch(repeated.html, /Award Score Movers/);
});

test('West End opening takes priority over award movement for the same show', (t) => {
  const { generate } = fixture(t, undefined, true);
  const { html, meta } = generate('west-end');
  assert.equal(meta.sections.find((s) => s.name === 'london-openings').fired, true);
  assert.match(html, /Opened in the West End/);
  assert.match(html, /London Award Fixture/);
  assert.equal(meta.sections.find((s) => s.name === 'award-score-movers').fired, false);
  assert.doesNotMatch(html, /Award Score Movers/);
});

for (const dates of [[], ['2026-10-31']]) {
  test(`West End newsletter skips ${dates.length} snapshots despite a Broadway pair`, (t) => {
    const { generate } = fixture(t, dates);
    const { html, meta } = generate('west-end');
    assert.equal(meta.sections.find((s) => s.name === 'award-score-movers').fired, false);
    assert.doesNotMatch(html, /Award Score Movers|Tony race/);
  });
}
