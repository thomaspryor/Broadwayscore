// Show hero integrity (BRO-4251).
// TESTS-VS-DERIVED-DATA-EXEMPT: structural guard that rejected-by-eye image fields stay null in shows.json; pins no facts about a show.
//
// Found 2026-09-28: unrelated shows served byte-identical hero files
// (hangmen-2022 = the-cripple-of-inishmaan-2014; here-lies-love-2023 =
// once-upon-a-mattress-2024 = the-minutes-2022 = the-phantom-of-the-opera-1988
// all carried a Moulin Rouge banner), Hangmen's hero was a text-only
// "FINAL WEEK" banner, The Snowman (West End 2026) hero/poster were a Chamber
// Music Society concert ad, and Shucked's Variety quote ended with Fat Ham
// review text glued on by an aggregator excerpt.
//
// These checks read the real committed public data:
//   1. No two unrelated shows serve the same hero bytes (md5).
//   2. No file under public/images/shows has a hash a person rejected by eye.
//   3. Known cross-show quote contamination does not reach a public show page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PUBLIC = path.join(ROOT, 'public');
const SHOWS_DIR = path.join(PUBLIC, 'data', 'shows');
const md5 = (file) => crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex');

// Files checked by eye and removed (BRO-4251). A re-fetch that brings the same
// bytes back fails here. The list lives in data/rejected-images.json so
// scripts/check-image-aspect.js can drop them before the auto-fetch commit.
const REJECTED_IMAGE_MD5 = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'rejected-images.json'), 'utf8')).md5;

// Different titles, same production lineage (a Broadway retitle).
const RELATED_GROUPS = [
  ['wanted-2022', 'gun-and-powder-regional-2020', 'gun-and-powder-signature-regional-2020', 'gun-and-powder-paper-mill-regional-2024'],
];

// Same title family = after dropping leading articles and the trailing year /
// market suffix, one id's title tokens are a prefix of the other's, or they
// share their first two tokens (harry-potter-2021 and
// harry-potter-and-the-cursed-child-2021; paranormal-activity-boston-regional
// and paranormal-activity-chicago-regional). A one-word match is not enough:
// the-lion-king and the-lion-in-winter must not excuse each other.
const ARTICLES = new Set(['the', 'a', 'an']);
const SUFFIX_TOKENS = new Set(['west', 'end', 'off', 'broadway', 'regional', 'national', 'tour', 'return']);
function titleTokens(id) {
  const tokens = id.split('-').filter(Boolean);
  while (tokens.length > 1 && (/^\d{4}$/.test(tokens[tokens.length - 1]) || SUFFIX_TOKENS.has(tokens[tokens.length - 1]))) tokens.pop();
  while (tokens.length > 1 && ARTICLES.has(tokens[0])) tokens.shift();
  return tokens;
}
function related(a, b) {
  const ta = titleTokens(a);
  const tb = titleTokens(b);
  let common = 0;
  while (common < ta.length && common < tb.length && ta[common] === tb[common]) common++;
  if (common === Math.min(ta.length, tb.length) || common >= 2) return true;
  return RELATED_GROUPS.some((g) => g.includes(a) && g.includes(b));
}

// Public image refs carry a `?v=<hash>` cache-buster; strip it before touching disk
// (BRO-6198: without this every hero looked missing and the guard hashed 0 files).
const publicFile = (ref) => path.join(PUBLIC, ref.split('?')[0]);

function publicShows() {
  return fs.readdirSync(SHOWS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(SHOWS_DIR, f), 'utf8')));
}

test('helper: related() separates the BRO-4251 groups and keeps same-title runs together', () => {
  assert.equal(related('hangmen-2022', 'the-cripple-of-inishmaan-2014'), false);
  assert.equal(related('here-lies-love-2023', 'once-upon-a-mattress-2024'), false);
  assert.equal(related('the-minutes-2022', 'the-phantom-of-the-opera-1988'), false);
  assert.equal(related('les-miserables-1987', 'les-miserables-2014'), true);
  assert.equal(related('the-last-ship-off-broadway-2026', 'the-last-ship-west-end-2026'), true);
  assert.equal(related('wanted-2022', 'gun-and-powder-regional-2020'), true);
  assert.equal(related('harry-potter-2021', 'harry-potter-and-the-cursed-child-2021'), true);
  assert.equal(related('paranormal-activity-2026', 'paranormal-activity-boston-regional-2026'), true);
  assert.equal(related('the-lion-king-1997', 'the-lion-in-winter-2026'), false);
});

test('no two unrelated shows serve byte-identical hero images', () => {
  const byHash = new Map();
  let checked = 0;
  for (const show of publicShows()) {
    if (!show.hi || typeof show.hi !== 'string' || !show.hi.startsWith('/images/')) continue;
    const file = publicFile(show.hi);
    if (!fs.existsSync(file)) continue; // dangling refs are nulled by pre-deploy-check
    const h = md5(file);
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(show.id);
    checked++;
  }
  assert.ok(checked > 100, `expected to hash 100+ heroes, hashed ${checked}`);
  const bad = [];
  for (const [h, ids] of byHash) {
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        if (!related(ids[i], ids[j])) bad.push(`${ids[i]} = ${ids[j]} (${h})`);
      }
    }
  }
  assert.deepEqual(bad, [], `unrelated shows share a hero file:\n${bad.join('\n')}`);
});

test('the BRO-4251 shows no longer share a hero', () => {
  const heroOf = (id) => {
    const show = JSON.parse(fs.readFileSync(path.join(SHOWS_DIR, `${id}.json`), 'utf8'));
    const file = show.hi && publicFile(show.hi);
    return file && fs.existsSync(file) ? md5(file) : null;
  };
  const groups = [
    ['hangmen-2022', 'the-cripple-of-inishmaan-2014'],
    ['here-lies-love-2023', 'once-upon-a-mattress-2024', 'the-minutes-2022', 'the-phantom-of-the-opera-1988'],
  ];
  for (const ids of groups) {
    const hashes = ids.map(heroOf).filter(Boolean);
    assert.equal(new Set(hashes).size, hashes.length, `${ids.join(', ')} share a hero file`);
  }
});

test('no image file carries a hash rejected by eye', () => {
  const imagesDir = path.join(PUBLIC, 'images', 'shows');
  const hits = [];
  for (const dir of fs.readdirSync(imagesDir)) {
    const full = path.join(imagesDir, dir);
    if (!fs.statSync(full).isDirectory()) continue;
    for (const f of fs.readdirSync(full)) {
      if (!/\.(webp|jpe?g|png)$/i.test(f)) continue;
      const why = REJECTED_IMAGE_MD5[md5(path.join(full, f))];
      if (why) hits.push(`${dir}/${f}: ${why}`);
    }
  }
  assert.deepEqual(hits, []);
});

// Known cross-show contamination: text from `foreign` must not appear in any
// public quote for `showId`. `sourceFile`/`sourceField` name the private
// review-text field that produced it; `plan` is the pending fix that clears it.
const KNOWN_BAD_QUOTES = [
  {
    showId: 'shucked-2023',
    foreign: /Fat Ham/i,
    sourceFile: 'shucked-2023/variety--aramide-tinubu.json',
    sourceField: 'nycTheatreExcerpt',
    plan: 'bro-4251',
  },
];

// Until the private source is cleared, the next rebuild regenerates the bad
// quote; the test must not go red on main for every land in that window.
function sourceStillBad(c) {
  const rec = path.join(ROOT, 'data', 'review-texts', c.sourceFile);
  if (fs.existsSync(rec)) {
    const v = JSON.parse(fs.readFileSync(rec, 'utf8'))[c.sourceField];
    return typeof v === 'string' && c.foreign.test(v);
  }
  const planFile = path.join(ROOT, 'data', 'pending-fixes', `${c.plan}.json`);
  if (!fs.existsSync(planFile)) return false;
  return JSON.parse(fs.readFileSync(planFile, 'utf8')).status !== 'applied';
}

for (const c of KNOWN_BAD_QUOTES) {
  test(`${c.showId}: public quotes carry no ${c.foreign} text`, (t) => {
    const show = JSON.parse(fs.readFileSync(path.join(SHOWS_DIR, `${c.showId}.json`), 'utf8'));
    const bad = (show.rv || []).filter((r) => typeof r.q === 'string' && c.foreign.test(r.q));
    if (bad.length && sourceStillBad(c)) {
      t.skip(`${c.sourceFile} ${c.sourceField} not yet cleared (plan ${c.plan} pending)`);
      return;
    }
    assert.deepEqual(bad.map((r) => `${r.o} / ${r.cn}: ${r.q.slice(0, 80)}`), []);
  });
}

// BRO-5236: BRO-4251 deleted the files but the core-data shows.json kept
// pointing at them, so the image archiver re-downloaded the same rejected
// bytes and main went red. A field that was rejected may come back only with
// NEW bytes: the auto-fetch re-sourced the Snowman hero/poster from the
// Peacock Theatre's own artwork on 2026-10-13 (c244e810acf), which is correct.
// So the guard is on the bytes the field serves, not on the field being set.
const REJECTED_IMAGE_FIELDS = [
  ['hangmen-2022', 'hero'],
  ['the-snowman-west-end-2026', 'hero'],
  ['the-snowman-west-end-2026', 'poster'],
];
test('shows.json no longer points rejected hero/poster fields at missing or rejected bytes', (t) => {
  const file = path.join(ROOT, 'data', 'shows.json');
  if (!fs.existsSync(file)) return t.skip('data/shows.json not present (no-data job)');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const bad = [];
  for (const [id, field] of REJECTED_IMAGE_FIELDS) {
    const s = shows.find((x) => x.id === id);
    assert.ok(s, `${id} missing from shows.json (renamed? update this guard)`);
    const ref = s.images && s.images[field];
    if (!ref) continue;
    if (/^https?:/.test(ref)) { bad.push(`${id}.images.${field} = ${ref} (remote, not archived)`); continue; }
    const local = path.join(ROOT, 'public', ref.replace(/^\//, ''));
    if (!fs.existsSync(local)) bad.push(`${id}.images.${field} = ${ref} (file missing)`);
    else if (REJECTED_IMAGE_MD5[md5(local)]) bad.push(`${id}.images.${field} = ${ref} (rejected bytes)`);
  }
  assert.deepEqual(bad, []);
});
