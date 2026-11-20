// LIVE-DATA-LANE: reads data/shows.json (untracked core data); data/critic-registry.json (untracked core data). Runs in check-corpus-drift.yml, not test.yml's blocking batch (BRO-7101).
/**
 * cross-outlet-excerpt-containment.test.mjs — BRO-7684.
 *
 * A bylineless, url-less aggregator quote whose words sit (>=85% trigram
 * containment) inside another outlet's fullText is that review re-filed under
 * the wrong outlet (BRO-7663). Only the weekly detect-cross-outlet-duplicates.js
 * flagged it, so the quote counted as a second review for up to a week. The
 * rebuild now flags it in the same run, with no LLM, via the real
 * excerptContainmentFlags() in scripts/lib/cross-outlet-group.js.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const { excerptContainmentFlags, applyExcerptContainmentFlag } = require(path.join(ROOT, 'scripts/lib/cross-outlet-group.js'));

const SHOW = 'operation-mincemeat-2025';
const showsJson = path.join(ROOT, 'data', 'shows.json');
const haveShow = fs.existsSync(showsJson) && fs.readFileSync(showsJson, 'utf8').includes(`"${SHOW}"`);

const QUOTE = 'The cast of five plays dozens of roles with such breakneck precision that the evening feels less like a musical than a magic trick performed in plain sight';
const FULL = [
  'Operation Mincemeat arrives on Broadway after a long run in London, and it has lost none of its cheek on the journey across the Atlantic.',
  'The story of the British intelligence officers who dressed a corpse as a courier to fool the Nazis is absurd enough on its own.',
  `${QUOTE}.`,
  'The songs borrow from sea shanties, Gilbert and Sullivan and modern pop without ever feeling like a pastiche of any of them.',
  'A late ballad sung by a secretary who writes the dead man love letters stops the show cold and earns every tear it draws from the audience.',
  'There are moments when the jokes pile up faster than the plot can carry them, but the energy rarely flags across two and a half hours.',
].join(' ');

const fullRec = () => ({
  showId: SHOW, outlet: 'The New York Times', outletId: 'nytimes', criticName: 'Jesse Green',
  url: 'https://www.nytimes.com/2025/03/20/theater/operation-mincemeat-review.html',
  publishDate: '2025-03-20', fullText: FULL, assignedScore: 85, contentTier: 'complete', source: 'collect-review-texts',
});
const quoteRec = (extra = {}) => ({
  showId: SHOW, outlet: 'New York Daily News', outletId: 'nydailynews', criticName: 'Unknown',
  publishDate: '2025-03-20', source: 'bww-roundup', bwwExcerpt: `${QUOTE}.`,
  assignedScore: 85, bwwSentiment: 'positive', contentTier: 'excerpt', ...extra,
});

// --- the pure rule ---
test('a bylineless url-less quote inside a sibling fullText is flagged against that file', () => {
  const flags = excerptContainmentFlags([
    { file: 'nytimes--jesse-green.json', data: fullRec() },
    { file: 'nydailynews--unknown.json', data: quoteRec() },
  ]);
  assert.equal(flags.length, 1);
  assert.equal(flags[0].file, 'nydailynews--unknown.json');
  assert.equal(flags[0].primaryFile, 'nytimes--jesse-green.json');
  assert.ok(flags[0].containment >= 85);
  const d = applyExcerptContainmentFlag(quoteRec(), SHOW, flags[0], new Date('2026-11-20T00:00:00Z'));
  assert.equal(d.crossOutletDuplicate, true);
  assert.equal(d.crossOutletPrimaryFile, `${SHOW}/nytimes--jesse-green.json`);
  assert.equal(d.crossOutletMethod, 'excerpt-containment');
});

test('a quote with its own url, a named critic, or a human clear is never flagged', () => {
  for (const extra of [
    { url: 'https://www.nydailynews.com/2025/03/20/operation-mincemeat-review/' },
    { criticName: 'Joe Dziemianowicz' },
    { crossOutletDuplicate: false, crossOutletClearReason: 'human: different review' },
  ]) {
    const flags = excerptContainmentFlags([
      { file: 'nytimes--jesse-green.json', data: fullRec() },
      { file: 'nydailynews--unknown.json', data: quoteRec(extra) },
    ]);
    assert.deepEqual(flags, [], JSON.stringify(extra));
  }
});

test('a quote that is not inside the sibling fullText is not flagged', () => {
  const flags = excerptContainmentFlags([
    { file: 'nytimes--jesse-green.json', data: fullRec() },
    { file: 'nydailynews--unknown.json', data: quoteRec({ bwwExcerpt: 'A clumsy, overlong evening whose jokes land with a thud and whose songs vanish from memory before the curtain call has even finished.' }) },
  ]);
  assert.deepEqual(flags, []);
});

// --- the pipeline: same rebuild run ---
function rebuild(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bro7684-'));
  const texts = path.join(root, 'review-texts');
  const dir = path.join(texts, SHOW);
  fs.mkdirSync(dir, { recursive: true });
  for (const [n, d] of Object.entries(files)) fs.writeFileSync(path.join(dir, n), JSON.stringify(d, null, 2));
  const out = execFileSync('node', [path.join(ROOT, 'scripts', 'rebuild-all-reviews.js'), `--show=${SHOW}`], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, REBUILD_REVIEW_TEXTS_DIR: texts, REBUILD_EXCLUSION_AUDIT_DIR: path.join(root, 'audit') },
  });
  const included = Number((/(\d+) review\(s\) would be included/.exec(out) || [])[1]);
  const read = (n) => JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'));
  return { included, out, read };
}

test('rebuild: a fresh bylineless quote inside a sibling fullText is flagged and dropped in the same run', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({ 'nytimes--jesse-green.json': fullRec(), 'nydailynews--unknown.json': quoteRec() });
  const q = r.read('nydailynews--unknown.json');
  assert.equal(q.crossOutletDuplicate, true, r.out.slice(-800));
  assert.equal(q.crossOutletPrimaryFile, `${SHOW}/nytimes--jesse-green.json`);
  assert.equal(q.crossOutletMethod, 'excerpt-containment');
  assert.equal(r.read('nytimes--jesse-green.json').crossOutletDuplicate, undefined, 'the fullText keeper is never flagged');
  assert.equal(r.included, 1);
});

test('rebuild: a quote with its own url is left alone (two reviews)', { skip: !haveShow && 'data/shows.json lacks the fixture show' }, () => {
  const r = rebuild({
    'nytimes--jesse-green.json': fullRec(),
    'nydailynews--unknown.json': quoteRec({ url: 'https://www.nydailynews.com/2025/03/20/operation-mincemeat-review/' }),
  });
  assert.equal(r.read('nydailynews--unknown.json').crossOutletDuplicate, undefined);
  assert.equal(r.included, 2);
});
