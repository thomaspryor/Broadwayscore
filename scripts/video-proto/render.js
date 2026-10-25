// Prototype (BRO-6250): Playwright frames -> ffmpeg MP4, 1080x1920 @30fps. No posting, no network except art fetch.
// usage: node render.js <reveal|every|top5> [outDir] [--stills 2,6,12]
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(path.join(process.env.PW_GLOBAL || '/opt/node22/lib/node_modules', 'playwright'))); }
const { getGoldThreshold, getScoreTierId, SCORE_TIER_LABELS } = require('../lib/score-tiers.js');
const { getAudienceGrade, totalAudienceReviews, MIN_AUDIENCE_REVIEWS } = require('../lib/audience-grade.js');
const ROOT = path.resolve(__dirname, '../..');
const FPS = 30;
const name = process.argv[2], outDir = process.argv[3] || __dirname;
const stills = (process.argv.find(a => a.startsWith('--stills=')) || '').slice(9).split(',').filter(Boolean).map(Number);

const slim = id => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/shows/' + id + '.json'), 'utf8'));
const meta = id => { const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')); return (s.shows || s).find(x => x.id === id); };
function art(id) {
  const b = fs.readFileSync(path.join(__dirname, 'art', id + '.img'));
  const mime = b[0] === 0x89 ? 'image/png' : 'image/jpeg';
  return `data:${mime};base64,${b.toString('base64')}`;
}
const showInfo = id => { const m = meta(id), p = slim(id); return { id, title: m.title, type: m.type, category: m.category, isNew: (Date.now() - Date.parse(m.openingDate)) < 45 * 864e5, score: p.cs, rc: p.rc, p, art: art(id) }; };

function data(n) {
  if (n === 'reveal') {
    const x = showInfo(process.env.REVEAL_ID || 'maybe-happy-ending-2024'), rv = x.p.rv.filter(r => Number.isFinite(r.s));
    const quotes = rv.filter(r => r.t === 1 && r.q && r.q.length <= 110).sort((a, b) => b.s - a.s).slice(0, 3);
    const aud = x.p.au && Number.isFinite(x.p.au.score) ? x.p.au.score : null, gap = aud == null ? null : aud - x.score;
    if (aud == null || totalAudienceReviews(x.p.au) < MIN_AUDIENCE_REVIEWS) throw new Error(`${x.id}: no audience grade (needs a score and ${MIN_AUDIENCE_REVIEWS}+ audience reviews, same as the site); pick another show`);
    const audienceGrade = getAudienceGrade(aud);
    const gold = getGoldThreshold(x.category);
    if (Math.abs(x.score - (gold - 0.5)) < 1 && !process.env.ALLOW_BOUNDARY) throw new Error(`${x.id}: score ${x.score} is within 1 point of the Gold line (${gold}); one new review could flip the tier, skipping`);
    return { show: { title: x.title, type: x.type }, isNew: x.isNew, category: x.category, art: x.art, score: x.score, count: x.rc, scores: rv.map(r => r.s), quotes,
      audienceGrade, gapLine: gap == null ? null : gap > 3 ? 'Audiences love it even more.' : gap < -3 ? 'Critics like it more than audiences do.' : 'Critics and audiences agree.' };
  }
  if (n === 'every') {
    const x = showInfo('school-girls-or-the-african-mean-girls-play-2026');
    const rv = x.p.rv.filter(r => Number.isFinite(r.s)).sort((a, b) => String(a.d).localeCompare(String(b.d)) || a.t - b.t || b.s - a.s);
    return { show: { title: x.title, type: x.type }, isNew: x.isNew, category: x.category, art: x.art, score: x.score, reviews: rv.map(r => ({ o: r.o, cn: r.cn, s: r.s })) };
  }
  if (n === 'top5') {
    const ids = ['hamilton-2015', 'book-of-mormon-2011', 'oh-mary-2024', 'the-lion-king-1997', 'maybe-happy-ending-2024'];
    const shows = ids.map(showInfo);
    for (let i = 1; i < shows.length; i++) if (shows[i].score > shows[i - 1].score) throw new Error('top5 not sorted by score');
    return { shows: shows.map(s => ({ title: s.title, type: s.type, score: s.score, rc: s.rc, art: s.art })) };
  }
  throw new Error('unknown composition ' + n);
}

const { synth } = require('./audio.js');
const AUDIO_STYLE = process.env.AUDIO_STYLE || 'groove';

(async () => {
  const d = data(name);
  const fontDir = path.join(ROOT, 'public/fonts'), ff = fs.readdirSync(fontDir).find(f => /^Inter-latin-var\..*\.woff2$/.test(f));
  const font = `@font-face{font-family:'Inter';src:url(data:font/woff2;base64,${fs.readFileSync(path.join(fontDir, ff)).toString('base64')}) format('woff2');font-weight:100 900;font-display:block}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${font}${fs.readFileSync(path.join(__dirname, 'stage.css'), 'utf8')}</style></head><body><div id="stage"></div></body></html>`;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 360, height: 640 }, deviceScaleFactor: 3 });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  const TIERS = { gold: getGoldThreshold(d.category), label: SCORE_TIER_LABELS, id: Array.from({ length: 101 }, (_, i) => getScoreTierId(i, d.category)) };
  await page.addScriptTag({ content: `window.TIERS=${JSON.stringify(TIERS)};` + fs.readFileSync(path.join(__dirname, 'stage.js'), 'utf8') + `;window.__C=COMPS;` });
  const info = await page.evaluate(([n, dd]) => { const c = window.__C[n]; window.C = c; c.build(document.getElementById('stage'), dd); return { dur: c.dur, events: c.events }; }, [name, d]);
  if (process.argv.includes('--audio-only')) { // re-sound an already rendered video: node render.js <comp> <dir> --audio-only
    const src = path.join(outDir, `${name}.mp4`), wav = path.join(outDir, `${name}-${AUDIO_STYLE}.wav`), dst = path.join(outDir, `${name}-${AUDIO_STYLE}.mp4`);
    synth(info.events, info.dur, wav, AUDIO_STYLE);
    require('child_process').execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', src, '-i', wav, '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', dst]);
    console.log('wrote ' + dst); await browser.close(); return;
  }
  const frame = async t => { await page.evaluate(t => { C.update(t); document.getAnimations().forEach(a => { a.pause(); a.currentTime = t * 1000; }); }, t); return page.screenshot({ type: 'jpeg', quality: 95 }); };
  fs.mkdirSync(outDir, { recursive: true });
  // overflow gate: sample the timeline; no visible text may spill past the viewport or past its own nowrap box
  const bad = new Set();
  for (let t = 0.5; t < info.dur; t += 0.5) {
    await frame(t);
    (await page.evaluate(() => [...document.querySelectorAll('#stage *')].flatMap(e => {
      const cs = getComputedStyle(e), r = e.getBoundingClientRect(); let op = 1; for (let n = e; n && n.id !== 'stage'; n = n.parentElement) op *= +getComputedStyle(n).opacity;
      if (op < 0.5 || cs.display === 'none' || !e.textContent.trim() || e.children.length) return [];
      const out = [];
      if (r.right > 360.5 || r.left < -0.5) out.push('outside viewport');
      const cd = e.closest('.card'); if (cd) { const c = cd.getBoundingClientRect(); if (r.bottom > c.bottom + 0.5 || r.top < c.top - 0.5 || r.right > c.right + 0.5) out.push('spills out of its card'); }
      if (cs.whiteSpace === 'nowrap' && cs.textOverflow !== 'ellipsis' && e.scrollWidth > e.clientWidth + 1) out.push('text wider than its box');
      return out.map(m => m + ': ' + e.textContent.trim().slice(0, 40));
    }))).forEach(m => bad.add(m));
  }
  if (process.argv.includes('--probe-only')) { console.log(bad.size ? 'OVERFLOW:\n  ' + [...bad].join('\n  ') : 'overflow gate: clean'); await browser.close(); return; }
  if (bad.size) { console.error('OVERFLOW:\n  ' + [...bad].join('\n  ')); if (!process.env.ALLOW_OVERFLOW) { await browser.close(); process.exit(3); } }
  if (stills.length) { for (const t of stills) fs.writeFileSync(path.join(outDir, `${name}-still-${t}.jpg`), await frame(t)); await browser.close(); return; }
  const wav = path.join(outDir, `${name}.wav`), mp4 = path.join(outDir, `${name}.mp4`);
  synth(info.events, info.dur, wav, AUDIO_STYLE);
  const ff2 = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-i', wav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-r', String(FPS), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(info.dur * FPS);
  for (let i = 0; i < total; i++) { const b = await frame(i / FPS); if (!ff2.stdin.write(b)) await new Promise(r => ff2.stdin.once('drain', r)); }
  ff2.stdin.end(); await new Promise(r => ff2.on('close', r)); await browser.close();
  console.log('wrote', mp4);
})().catch(e => { console.error(e); process.exit(1); });
