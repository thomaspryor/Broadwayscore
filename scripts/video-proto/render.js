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
  if (n === 'verdict' || n === 'versus') return voiced(n);
  throw new Error('unknown composition ' + n);
}

// Voiced formats: timeline is driven by the voiceover's word timings (VO_DIR/<comp>.mp3 + <comp>.words.json from Whisper).
// Every number the voice says is checked against the data, so a stale script cannot ship.
const VO_OFF = 0.6;
function voiced(n) {
  const VO = process.env.VO_DIR; if (!VO) throw new Error('set VO_DIR to the folder with ' + n + '.mp3 and ' + n + '.words.json');
  const wj = JSON.parse(fs.readFileSync(path.join(VO, n + '.words.json'), 'utf8'));
  const words = wj.words.map(w => ({ w: w.word, a: +(w.start + VO_OFF).toFixed(3), b: +(w.end + VO_OFF).toFixed(3) }));
  // Whisper's word list drops '+'/'-' from letter grades ("B+" comes back as "B"); restore them from the full transcript
  const marks = [...wj.text.matchAll(/\b([A-F])([+-])(?![\w])/g)];
  words.filter(w => /^[A-F]$/.test(w.w)).forEach((w, i) => { if (marks[i] && marks[i][1] === w.w) w.w += marks[i][2]; });
  words.forEach((w, i) => { const nx = words[i + 1], pv = words[i - 1];
    if (/^critics?$/i.test(w.w) && nx && /^score$/i.test(nx.w)) w.w = 'Critic';
    if (/^score$/i.test(w.w) && pv && pv.w === 'Critic') w.w = 'Score';
    if (/^seeing$/i.test(w.w) && pv && /^worth$/i.test(pv.w)) w.w = 'Seeing'; });
  // mark sentence ends from the transcript's punctuation so a caption never runs across two sentences
  { let pos = 0; const low = wj.text.toLowerCase();
    wj.words.forEach((w, i) => { const j = low.indexOf(w.word.toLowerCase(), pos); if (j < 0) return; pos = j + w.word.length;
      if (/^[+-]?[.!?]/.test(wj.text.slice(pos, pos + 2))) words[i].e = 1; }); }
  const norm = s => String(s).toLowerCase().replace(/[^a-z0-9+]/g, '');
  const at = phrase => { const tk = phrase.split(' ').map(norm);
    for (let i = 0; i < words.length; i++) if (tk.every((t, k) => words[i + k] && norm(words[i + k].w) === t)) return words[i].a;
    throw new Error(`${n}: the voiceover never says "${phrase}" (script and data disagree)`); };
  const id = n === 'verdict' ? (process.env.VERDICT_ID || 'the-imaginary-invalid-2026') : (process.env.VERSUS_ID || 'other-desert-cities-2026');
  const x = showInfo(id), rv = x.p.rv.filter(r => Number.isFinite(r.s));
  const c = { rave: 0, positive: 0, mixed: 0, negative: 0 }; rv.forEach(r => c[r.s >= getGoldThreshold(x.category) ? 'rave' : r.s >= 70 ? 'positive' : r.s >= 55 ? 'mixed' : 'negative']++);
  const aud = x.p.au && Number.isFinite(x.p.au.score) && totalAudienceReviews(x.p.au) >= MIN_AUDIENCE_REVIEWS ? getAudienceGrade(x.p.au.score) : null;
  if (!aud) throw new Error(id + ': no audience grade');
  const score = Math.round(x.score), label = SCORE_TIER_LABELS[getScoreTierId(score, x.category)];
  // numbers and labels the voice says must match the data
  at(`${score}`); at(label); at(aud.grade); at(`${rv.length}`) ;
  if (n === 'verdict') { at(`${c.rave + c.positive} positive`); at(`${c.mixed} mixed`); at(`${c.negative} negative`); }
  const Q = n === 'verdict'
    ? [['The Wall Street Journal', 'the daffy splendidness of the Roundabout Theatre Company production', 'the wall street journal'], ['Deadline', null, 'deadline'], ['New York Post', null, 'the new york post']]
    : [['Variety', 'An exquisite portrait of 21st-century Americana', 'variety'], ['The Hollywood Reporter', null, 'the hollywood reporter']];
  const quotes = Q.map(([o, ex, say]) => { const r = rv.find(r => r.o === o); if (!r) throw new Error(id + ': no review from ' + o);
    if (ex && !r.q.includes(ex)) throw new Error(`${o} excerpt is not in the quote`);
    const q = ex ? (r.q.startsWith(ex) ? '' : '…') + ex + '…' : r.q; return { o, cn: r.cn, s: r.s, q, t: at(say) }; });
  const A = n === 'verdict'
    ? { bar: at(`${c.rave + c.positive} positive`), count: at('the critic score'), land: at(`${score}`), label: at(label), aud: at('and audiences'), grade: at(aud.grade), end: at('every review') }
    : { count: at(`across ${rv.length} reviews`), land: at(`${score}`), label: at(label), aud: at('but audiences'), grade: at(aud.grade), who: at('so whos right') };
  const last = words[words.length - 1].b;
  if (!A.end) A.end = last + 0.3;
  return { kind: n, show: { title: x.title, type: x.type }, isNew: x.isNew, category: x.category, art: x.art, score: x.score, count: rv.length, scores: rv.map(r => r.s),
    counts: c, label, audienceGrade: aud, quotes, A, words, dur: +(Math.max(last, A.end) + 2.4).toFixed(2), vo: path.join(VO, n + '.mp3') };
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
  if (d.vo) { // music bed under the voice: bed at -16 dB, voice delayed by VO_OFF
    const mix = path.join(outDir, `${name}-mix.wav`);
    require('child_process').execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, '-i', d.vo, '-filter_complex',
      `[0:a]volume=${process.env.BED_VOL || 0.16}[m];[1:a]adelay=${VO_OFF * 1000}|${VO_OFF * 1000},volume=1.0[v];[m][v]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9[o]`, '-map', '[o]', '-ar', '44100', mix]);
    fs.renameSync(mix, wav);
  }
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
