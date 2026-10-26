// Show data shared by render.js and voscript.js (BRO-6250): slim show files, shows.json metadata, key art, Top 5 lists.
const fs = require('fs'), path = require('path');
const { getGoldThreshold } = require('../lib/score-tiers.js');
const { getAudienceGrade, totalAudienceReviews, MIN_AUDIENCE_REVIEWS } = require('../lib/audience-grade.js');
const ROOT = path.resolve(__dirname, '../..');
const slim = id => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/shows/' + id + '.json'), 'utf8'));
const meta = id => { const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')); return (s.shows || s).find(x => x.id === id); };
// Owner rule 2026-10-26: no video without a real poster. Only art that fetch-art.js measured and vision-checked is used.
function art(id) {
  const ok = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'art', 'verified.json'), 'utf8'))[id]; } catch (e) { return null; } })();
  if (!ok) throw new Error(`${id}: no verified poster, so no video. Run: node fetch-art.js ${id}`);
  const b = fs.readFileSync(path.join(__dirname, 'art', id + '.img'));
  const mime = b[0] === 0x89 ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${b.toString('base64')}`;
}
const showInfo = id => { const m = meta(id), p = slim(id); return { id, title: m.title, type: m.type, category: m.category, isNew: (Date.now() - Date.parse(m.openingDate)) < 45 * 864e5, score: p.cs, rc: p.rc, p, art: art(id) }; };

// Top 5 lists: Broadway only, musicals and plays, ranked by the site's Critic Score (cs, set only once a show clears the review gate)
const { getSeasonForDate, getCurrentSeason } = require('../lib/broadway-seasons.js');
const fmtSeason = s => s.slice(0, 5) + s.slice(7);
function topList(key) {
  const all = (j => j.shows || j)(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')));
  // a 'best of' claim needs a real sample: at least LIST_MIN_REVIEWS reviews (default 15), well above the site's 5-review score gate
  const MINR = +(process.env.LIST_MIN_REVIEWS || 15);
  const cs = id => { try { const p = slim(id); return typeof p.cs === 'number' && p.rc >= MINR ? p.cs : null; } catch (e) { return null; } };
  const today = new Date().toISOString().slice(0, 10), yearsAgo = y => String(+today.slice(0, 4) - y) + today.slice(4);
  const cur = getCurrentSeason(), [a] = cur.split('-').map(Number), last = `${a - 1}-${a}`;
  const month = d => new Date(d + 'T12:00:00Z').toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const NOW_END = 'New scores every week.', HIST_END = 'Every review. One score.';
  const defs = {
    now: { title: 'Top 5 on Broadway', sub: 'Ranked by Critic Score, shows playing now', end: NOW_END, f: s => s.status === 'open' },
    'now-musicals': { title: 'Top 5 musicals on Broadway', sub: 'Ranked by Critic Score, playing now', end: NOW_END, f: s => s.status === 'open' && s.type === 'musical' },
    'now-plays': { title: 'Top 5 plays on Broadway', sub: 'Ranked by Critic Score, playing now', end: NOW_END, f: s => s.status === 'open' && s.type === 'play' },
    'last-season': { title: `Top 5 of the ${fmtSeason(last)} season`, sub: 'Broadway shows that opened that season', end: HIST_END, f: s => getSeasonForDate(s.openingDate) === last },
    'five-years': { title: 'Top 5 of the last 5 years', sub: `Broadway shows that opened since ${month(yearsAgo(5))}`, end: HIST_END, f: s => s.openingDate >= yearsAgo(5) },
    'decade-musicals': { title: 'Top 5 musicals of the last 10 years', sub: `Broadway musicals that opened since ${month(yearsAgo(10))}`, end: HIST_END, f: s => s.type === 'musical' && s.openingDate >= yearsAgo(10) },
  };
  const D = defs[key]; if (!D) throw new Error(`unknown LIST ${key}; one of ${Object.keys(defs).join(', ')}`);
  const pick = all.filter(s => s.category === 'broadway' && ['musical', 'play'].includes(s.type) && s.openingDate && s.openingDate <= today && D.f(s))
    .map(s => ({ id: s.id, cs: cs(s.id) })).filter(s => s.cs != null).sort((x, y) => y.cs - x.cs).slice(0, 5);
  if (pick.length < 5) throw new Error(`LIST ${key}: only ${pick.length} scored shows`);
  const missing = pick.filter(s => { try { art(s.id); return false; } catch (e) { return true; } }).map(s => s.id);
  if (missing.length) throw new Error(`LIST ${key}: no key art yet, run: node fetch-art.js ${missing.join(' ')}`);
  return { title: D.title, sub: D.sub, endLine: D.end, ids: pick.map(s => s.id) };
}

// rave / positive / mixed / negative, the same lines as the site's breakdown bar
const bucket = (s, category) => s >= getGoldThreshold(category) ? 'rave' : s >= 70 ? 'positive' : s >= 55 ? 'mixed' : 'negative';
const breakdown = (rv, category) => { const c = { rave: 0, positive: 0, mixed: 0, negative: 0 }; rv.forEach(r => c[bucket(r.s, category)]++); return c; };
// the letter grade the site shows, or null when there are too few audience reviews for one
const audienceGradeOf = p => p.au && Number.isFinite(p.au.score) && totalAudienceReviews(p.au) >= MIN_AUDIENCE_REVIEWS ? getAudienceGrade(p.au.score) : null;
const gapLine = (aud, score) => aud - score > 3 ? 'Audiences love it even more.' : aud - score < -3 ? 'Critics like it more than audiences do.' : 'Critics and audiences agree.';

module.exports = { ROOT, slim, meta, art, showInfo, topList, bucket, breakdown, audienceGradeOf, gapLine };
