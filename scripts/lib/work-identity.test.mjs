// Class guard for BRO-7429: a shared title is not a shared work.
// Fails with the fix reverted: getOtherProductions must consult work-identity, add-show must gate
// indistinguishable rows, and the Galileo shape must resolve.
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { workIdentity, differentWorks, writerSurnames, undistinguishableSibling, sameWorkFromText } = require('./work-identity.js');
const { applyAddShow } = require('./add-show-action.js');
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const musical = { id: 'galileo-2026', title: 'Galileo', type: 'musical', category: 'broadway', creativeTeam: [{ name: 'Danny Strong', role: 'Book' }, { name: 'Zoë Sarnak', role: 'Music & Lyrics' }] };
const brechtBare = { id: 'galileo-regional-2025', title: 'Galileo', type: 'play', category: 'regional' };
const brechtCredited = { ...brechtBare, creativeTeam: [{ name: 'Bertolt Brecht', role: 'Playwright' }] };

test('writerSurnames folds accents, splits joint credits, ignores music direction and template junk', () => {
  const s = writerSurnames({ creativeTeam: [
    { name: 'Noël Coward', role: 'Playwright' },
    { name: 'Marla Mindelle, Constantine Rousouli & Tye Blue', role: 'Book' },
    { name: 'Joe Bunker', role: 'Music Direction' },
    { name: '{{plainlist | Zoe Sarnak', role: 'Music & Lyrics' },
  ] });
  assert.deepEqual([...s].sort(), ['blue', 'coward', 'mindelle', 'rousouli']);
  assert.equal(writerSurnames({ creativeTeam: [{ name: 'Friedrich Dürrenmatt', role: 'Playwright' }] }).has('durrenmatt'), true);
});

test('Galileo shape: bare regional play is unknown beside the musical, different once writers or workKey exist', () => {
  assert.equal(workIdentity(musical, brechtBare).verdict, 'unknown');
  assert.equal(workIdentity(musical, brechtCredited).verdict, 'different');
  assert.equal(differentWorks(musical, { ...brechtBare, workKey: 'galileo-brecht-play' }), true);
});

test('same-type disjoint writers are not split on their own, shared surname is the same work', () => {
  const a = { id: 'a', title: 'Oklahoma!', type: 'musical', creativeTeam: [{ name: 'Richard Rodgers', role: 'Music' }] };
  const b = { id: 'b', title: 'Oklahoma!', type: 'musical', creativeTeam: [{ name: 'Oscar Hammerstein II', role: 'Lyrics' }] };
  assert.equal(workIdentity(a, b).verdict, 'unknown');
  assert.equal(workIdentity(a, { ...b, creativeTeam: [{ name: 'Rodgers and Hammerstein', role: 'Book' }] }).verdict, 'same');
});

test('explicit links and sameWorkAs beat everything; workKey must match', () => {
  assert.equal(workIdentity(musical, { ...brechtCredited, transferOf: musical.id }).verdict, 'same');
  assert.equal(workIdentity(musical, { ...brechtCredited, sameWorkAs: [musical.id] }).verdict, 'same');
  assert.equal(workIdentity({ ...musical, workKey: 'k' }, { ...brechtBare, workKey: 'k' }).verdict, 'same');
  assert.equal(workIdentity({ ...musical, workKey: 'k' }, { ...brechtBare, workKey: 'j' }).verdict, 'different');
});

test('undistinguishableSibling flags the Galileo shape and clears once identified', () => {
  assert.equal(undistinguishableSibling(brechtBare, [musical, brechtBare]), 'galileo-2026');
  assert.equal(undistinguishableSibling(brechtCredited, [musical]), null);
  assert.equal(undistinguishableSibling({ ...brechtBare, sameWorkAs: ['galileo-2026'] }, [musical]), null);
  assert.equal(undistinguishableSibling({ ...brechtBare, workKey: 'galileo-brecht-play' }, [musical]), null);
  // same type: not flagged (type labels alone are unreliable)
  assert.equal(undistinguishableSibling({ id: 'x', title: 'Galileo', type: 'musical' }, [musical]), null);
});

test('sameWorkFromText resolves only when the page names a sibling writer, never concludes different', () => {
  const pool = [musical, brechtBare];
  assert.equal(sameWorkFromText('A new musical with a book by Danny Strong', brechtBare, pool), 'galileo-2026');
  assert.equal(sameWorkFromText("One of Brecht's great masterpieces", brechtBare, pool), null);
});

test('add-show accepts workKey and sameWorkAs on a new row (and does not refuse same-title regional productions of one work)', () => {
  const base = { id: 'galileo-regional-2026', title: 'Galileo', slug: 'galileo-regional-2026', venue: 'Trap Door Theatre, Chicago, IL', status: 'closed', type: 'play', category: 'regional', market: 'regional', openingDate: '2026-05-01', city: 'chicago-il' };
  const opts = { isRetired: () => false };
  const withKey = applyAddShow([{ ...musical }], { type: 'add-show', show: { ...base, workKey: 'galileo-brecht-play' } }, opts);
  assert.equal(withKey.ok, true);
  assert.equal(withKey.show ? withKey.show.workKey : 'galileo-brecht-play', 'galileo-brecht-play');
  assert.equal(applyAddShow([{ ...musical }], { type: 'add-show', show: { ...base, sameWorkAs: ['galileo-2026'] } }, opts).ok, true);
  // regional Annie is labelled "play" beside the musical: must not be refused
  const annie = { id: 'annie-2012', title: 'Annie', type: 'musical', category: 'broadway', creativeTeam: [{ name: 'Thomas Meehan', role: 'Book' }] };
  assert.equal(applyAddShow([annie], { type: 'add-show', show: { ...base, id: 'annie-regional-2026', slug: 'annie-regional-2026', title: 'Annie' } }, opts).ok, true);
});

test('the computed show carries workKey and sameWorkAs to getOtherProductions (engine.ts pass-through)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/engine.ts'), 'utf8');
  assert.match(src, /workKey: show\.workKey/);
  assert.match(src, /sameWorkAs: show\.sameWorkAs/);
});

test('writerSurnames: staging is not writing, parentheticals are dropped, written-and-directed counts', () => {
  const s = writerSurnames({ creativeTeam: [
    { name: 'Sergio Trujillo', role: 'Musical Staging' },
    { name: 'Lorraine Hansberry (based on her play)', role: 'Playwright' },
    { name: 'Annie Baker', role: 'Written and Directed by' },
  ] });
  assert.deepEqual([...s].sort(), ['baker', 'hansberry']);
});

test('getOtherProductions consults work-identity (reverting the wiring re-links unrelated same-title works)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/lib/data-core.ts'), 'utf8');
  const fn = src.slice(src.indexOf('export function getOtherProductions'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(src, /from '..\/..\/scripts\/lib\/work-identity'/);
  assert.match(body, /differentWorks\(show, s\)/);
});

test('live data: no audited different-work pair is still linked, and the Galileo musical lists only its tryout', { skip: !fs.existsSync(path.join(ROOT, 'data/shows.json')) }, () => {
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8'));
  const shows = Array.isArray(raw) ? raw : raw.shows;
  const byId = Object.fromEntries(shows.map((s) => [s.id, { ...s }]));
  // The BRO-7429 data plans may be landed but not yet applied by execute-approved-fix: overlay them.
  const planDir = path.join(ROOT, 'data/pending-fixes');
  if (fs.existsSync(planDir)) for (const f of fs.readdirSync(planDir).filter((n) => /^bro-7429(-[a-z])?\.json$/.test(n))) {
    const plan = JSON.parse(fs.readFileSync(path.join(planDir, f), 'utf8')).plan;
    for (const a of (Array.isArray(plan) ? plan : plan.actions || plan.fixes || [])) if (byId[a.showId] && a.type === 'data-edit') byId[a.showId][a.field] = a.newValue;
  }
  const { audit } = require('./same-title-audit.js');
  const leaks = [];
  for (const g of audit(Object.values(byId))) for (const p of g.pairs) if (p.verdict === 'different' && !differentWorks(byId[p.a], byId[p.b])) leaks.push(`${p.a} / ${p.b}`);
  assert.deepEqual(leaks, [], `audited different works the matcher still links: ${leaks.join(', ')}`);
  const m = byId['galileo-2026']; const r = byId['galileo-regional-2025'];
  if (m && r && (r.workKey || (r.creativeTeam || []).length)) assert.equal(differentWorks(m, r), true);
});
