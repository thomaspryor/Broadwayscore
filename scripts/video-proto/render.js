// Prototype (BRO-6250): Playwright frames -> ffmpeg MP4, 1080x1920 @30fps. No posting, no network except art fetch.
// usage: node render.js <reveal|every|top5> [outDir] [--stills 2,6,12]
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
let chromium; try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require(path.join(process.env.PW_GLOBAL || '/opt/node22/lib/node_modules', 'playwright'))); }
const { getGoldThreshold, getScoreTierId, SCORE_TIER_LABELS } = require('../lib/score-tiers.js');
const { getAudienceGrade, totalAudienceReviews, MIN_AUDIENCE_REVIEWS } = require('../lib/audience-grade.js');
const FPS = 30;
const name = process.argv[2], outDir = process.argv[3] || __dirname;
const stills = (process.argv.find(a => a.startsWith('--stills=')) || '').slice(9).split(',').filter(Boolean).map(Number);

const { ROOT, slim, showInfo, topList, bucket, breakdown, audienceGradeOf, gapLine } = require('./showdata.js');

function data(n, key) {
  if (n === 'reveal') {
    const x = showInfo(key || process.env.REVEAL_ID || 'maybe-happy-ending-2024'), rv = x.p.rv.filter(r => Number.isFinite(r.s));
    const quotes = rv.filter(r => r.t === 1 && r.q && r.q.length <= 110).sort((a, b) => b.s - a.s).slice(0, 3);
    const aud = x.p.au && Number.isFinite(x.p.au.score) ? x.p.au.score : null, gap = aud == null ? null : aud - x.score;
    if (aud == null || totalAudienceReviews(x.p.au) < MIN_AUDIENCE_REVIEWS) throw new Error(`${x.id}: no audience grade (needs a score and ${MIN_AUDIENCE_REVIEWS}+ audience reviews, same as the site); pick another show`);
    const audienceGrade = getAudienceGrade(aud);
    const gold = getGoldThreshold(x.category);
    if (Math.abs(x.score - (gold - 0.5)) < 1 && !process.env.ALLOW_BOUNDARY) throw new Error(`${x.id}: score ${x.score} is within 1 point of the Gold line (${gold}); one new review could flip the tier, skipping`);
    return { show: { title: x.title, type: x.type }, isNew: x.isNew, category: x.category, art: x.art, score: x.score, count: x.rc, scores: rv.map(r => r.s).sort((a, b) => b - a), quotes,
      audienceGrade, gapLine: gap == null ? null : gap > 3 ? 'Audiences love it even more.' : gap < -3 ? 'Critics like it more than audiences do.' : 'Critics and audiences agree.' };
  }
  if (n === 'every') {
    const x = showInfo(key || process.env.EVERY_ID || 'school-girls-or-the-african-mean-girls-play-2026');
    // reviews land in score order (ORDER=desc, the default, or asc) so the breakdown bar fills one segment at a time
    const order = process.env.ORDER === 'asc' ? 'asc' : 'desc', dir = order === 'asc' ? 1 : -1;
    const rv = x.p.rv.filter(r => Number.isFinite(r.s)).sort((a, b) => dir * (a.s - b.s) || a.t - b.t);
    return { order, show: { title: x.title, type: x.type }, isNew: x.isNew, category: x.category, art: x.art, score: x.score, reviews: rv.map(r => ({ o: r.o, cn: r.cn, s: r.s })) };
  }
  if (n === 'top5') {
    const L = topList(key || process.env.LIST || 'now');
    const shows = L.ids.map(showInfo);
    for (let i = 1; i < shows.length; i++) if (shows[i].score > shows[i - 1].score) throw new Error('top5 not sorted by score');
    return { title: L.title, sub: L.sub, endLine: L.endLine, shows: shows.map(s => ({ title: s.title, type: s.type, score: s.score, rc: s.rc, art: s.art })) };
  }
  if (n === 'versus') return voiced(n);
  if (n === 'verdict' || n.endsWith('-voiced')) return voicedFromPlan(n);
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

// Voiced from a plan (voscript.js writes VO_DIR/<VO_NAME>.plan.json; the voice and Whisper timings sit beside it).
// The plan is the script, the data is the truth: every quote must be the critic's own words from that review, and
// every number on screen must be heard in the voiceover, or the render stops.
const NUMW = Object.fromEntries(['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'].map((w, i) => [w, i])
  .concat(['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'].map((w, i) => [w, 20 + i * 10]), [['hundred', 100]]));
// one matching key per spoken word: digits for numbers (Whisper writes "67" or "sixty-seven"), "b+" for grades
const key = s => { const l = String(s).toLowerCase().replace(/[’']/g, '').replace(/^critics\b/, 'critic');
  const g = /^([a-f])(?:-?(plus|minus)|([+-]))$/.exec(l.replace(/[.,!?:;]+$/, '')); if (g) return g[1] + (g[2] ? (g[2] === 'plus' ? '+' : '-') : g[3]);
  const w = l.replace(/[^a-z0-9-]/g, ''), [a, b] = w.split('-');
  if (b && NUMW[a] >= 20 && NUMW[b] < 10) return String(NUMW[a] + NUMW[b]);
  return a in NUMW ? String(NUMW[a]) : w.replace(/-/g, ''); };
const { reviewHash } = require('./copyreview.js');
function loadVoice(n) {
  const VO = process.env.VO_DIR, base = process.env.VO_NAME || n;
  if (!VO) throw new Error(`set VO_DIR (and VO_NAME) to the folder with ${base}.plan.json, .mp3 and .words.json`);
  const plan = JSON.parse(fs.readFileSync(path.join(VO, base + '.plan.json'), 'utf8'));
  if (!plan.review || !plan.review.pass || plan.review.of !== reviewHash(plan)) throw new Error(`${base}: copy has not passed the two-model review (node copyreview.js ${base}.plan.json)`);
  const wj = JSON.parse(fs.readFileSync(path.join(VO, base + '.words.json'), 'utf8'));
  const words = wj.words.map(w => ({ w: w.word, a: +(w.start + VO_OFF).toFixed(3), b: +(w.end + VO_OFF).toFixed(3) }));
  const marks = [...wj.text.matchAll(/\b([A-F])([+-])(?![\w])/g)];
  words.filter(w => /^[A-F]$/.test(w.w)).forEach((w, i) => { if (marks[i] && marks[i][1] === w.w) w.w += marks[i][2]; });
  words.forEach((w, i) => { const pv = words[i - 1];
    if (/^critics?$/i.test(w.w) && words[i + 1] && /^score$/i.test(words[i + 1].w)) w.w = 'Critic';
    if (/^score$/i.test(w.w) && pv && pv.w === 'Critic') w.w = 'Score'; });
  { let pos = 0; const low = wj.text.toLowerCase();
    wj.words.forEach((w, i) => { const j = low.indexOf(w.word.toLowerCase(), pos); if (j < 0) return; pos = j + w.word.length;
      if (/^[+-]?[.!?]/.test(wj.text.slice(pos, pos + 2))) words[i].e = 1; }); }
  // tokens for matching: "sixty seven", "B plus", "one hundred" spoken as two words count as one
  const tk = []; words.forEach((w, i) => { const k = key(w.w), pv = tk[tk.length - 1];
    if (pv && /^\d+$/.test(k) && ((+pv.k >= 20 && +pv.k % 10 === 0 && +k < 10 && +k > 0) || (k === '100' && pv.k === '1'))) { pv.k = String(k === '100' ? 100 : +pv.k + +k); return; }
    if (pv && /^[a-f]$/.test(pv.k) && /^(plus|minus)$/.test(k)) { pv.k += k === 'plus' ? '+' : '-'; return; }
    tk.push({ k, a: w.a }); });
  let cur = 0;
  // at(phrase): when the voice starts saying it, searching forward from the last cue so scenes stay in script order
  const at = (phrase, { from } = {}) => { const want = phrase.split(/\s+/).map(key).filter(Boolean), start = from == null ? cur : from;
    for (let i = 0; i < tk.length; i++) if (tk[i].a >= start - 1e-6 && want.every((t, k) => tk[i + k] && tk[i + k].k === t)) { if (from == null) cur = tk[i].a; return tk[i].a; }
    throw new Error(`${base}: the voiceover never says "${phrase}"${start ? ' after ' + start.toFixed(1) + 's' : ''} (script and data disagree)`); };
  return { plan, words, at, last: words[words.length - 1].b, vo: path.join(VO, base + '.mp3') };
}
const norm1 = s => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"');
const outletCue = o => o.replace(/^The /, '');
// the quote cards show exactly the span the voice reads, with an ellipsis where the critic's sentence goes on
function planQuotes(V, rv) {
  return V.plan.quotes.map(q => { const r = rv.find(r => r.o === q.o && r.s === q.s);
    if (!r) throw new Error(`plan quotes ${q.o} (${q.s}) but no such review in the data`);
    const full = norm1(r.q.trim()), ex = norm1(q.ex), i = full.indexOf(ex);
    if (i < 0) throw new Error(`plan excerpt for ${q.o} is not in the review's quote: "${q.ex}"`);
    const tail = full.slice(i + ex.length).replace(/^[\s.…]+$/, '');
    return { o: r.o, cn: r.cn, s: r.s, q: (i > 0 ? '…' : '') + q.ex + (tail ? '…' : ''), t: V.at(outletCue(q.say)) }; });
}
const TALLY = [['rave', 'raves', 'rave'], ['positive', 'positive', 'positive'], ['mixed', 'mixed', 'mixed'], ['negative', 'negative', 'negative']];
function voicedFromPlan(n) {
  const V = loadVoice(n), at = V.at, fmt = n.replace(/-voiced$/, ''), cue = V.plan.cue || {};
  if (V.plan.fmt !== fmt) throw new Error(`${n} needs a ${fmt} plan, got ${V.plan.fmt}`);
  const dur = +(V.last + 2.2).toFixed(2), base = { words: V.words, vo: V.vo, dur };
  if (fmt === 'top5') {
    const d = data('top5', V.plan.key), cues = { n: [] };
    at(d.title.split(' ').slice(0, 2).join(' '));
    d.shows.slice().reverse().forEach((s, i) => { cues.n.push(at(`number ${5 - i}`)); at(`${Math.round(s.score)}`); });
    cues.end = at(d.endLine.split(' ').slice(0, 2).join(' '));
    return { ...d, ...base, cues };
  }
  const x = showInfo(V.plan.key), rv = x.p.rv.filter(r => Number.isFinite(r.s)), c = breakdown(rv, x.category);
  const aud = audienceGradeOf(x.p); if (!aud) throw new Error(x.id + ': no audience grade');
  const score = Math.round(x.score), label = SCORE_TIER_LABELS[getScoreTierId(score, x.category)], N = rv.length;
  const tally = () => TALLY.filter(([k]) => c[k] > 0).map(([k, many, one]) => at(`${c[k]} ${c[k] === 1 ? one : many}`));
  if (fmt === 'every') {
    const d = data('every', x.id); at(`${N} critics`);
    // rows of each kind land while the voice names that kind, never faster than ROW_MIN apart
    const ROW_MIN = 0.18, kinds = TALLY.filter(([k]) => c[k] > 0).map(([k, many, one]) => ({ k, t: at(k === 'rave' ? (c.rave === 1 ? 'rave' : 'raves') : k) }));
    const scoreCue = at(cue.score || 'the critic score'), land = at(`${score}`); at(label);
    const times = []; let tPrev = -1;
    kinds.forEach((g, gi) => { const rows = d.reviews.filter(r => bucket(r.s, x.category) === g.k);
      const span = (kinds[gi + 1] ? kinds[gi + 1].t : scoreCue - 0.4) - g.t, step = Math.max(ROW_MIN, span / rows.length);
      rows.forEach((_, i) => { const t = Math.max(g.t + i * step, tPrev + ROW_MIN); times.push(+t.toFixed(3)); tPrev = t; }); });
    if (d.order !== 'desc') throw new Error('voiced every needs ORDER=desc so rows land in the order the voice names them');
    // the list clears just after the last row and the result badge counts up to land on the spoken score
    const tEnd = Math.min(land - 2.6, tPrev + 0.5), countDur = +(land - tEnd - 0.4).toFixed(2);
    if (countDur < 1) throw new Error(`every-voiced: rows still landing at ${tPrev.toFixed(1)}s but the score is said at ${land.toFixed(1)}s`);
    return { ...d, ...base, dur: Math.max(dur, +(land + 5.2).toFixed(2)), times, tEnd, countDur };
  }
  if (fmt === 'verdict') {
    at(`${N} critics`);
    const quotes = planQuotes(V, rv), bar = tally()[0];
    const A = { bar, count: at(cue.score || 'the critic score'), land: at(`${score}`), label: at(label), aud: at(cue.aud || 'audiences'), grade: at(aud.grade), end: at('every review') };
    const kicker = x.category === 'broadway' ? 'Opening night verdict' : x.category === 'west-end' ? 'Press night verdict' : 'The reviews are in';
    return { kind: 'verdict', kicker, show: { title: x.title, type: x.type }, isNew: x.isNew, category: x.category, art: x.art, score: x.score, count: N, scores: rv.map(r => r.s),
      counts: c, label, audienceGrade: aud, quotes, A, ...base, dur: +(Math.max(V.last, A.end) + 2.4).toFixed(2) };
  }
  if (fmt === 'reveal') {
    const d = data('reveal', x.id), cues = {};
    at(`${N} critics`); cues.count = at(cue.count || 'one score'); cues.land = at(`${score}`); at(label);
    cues.quotesIn = at(cue.quotesIn || 'what they said'); const quotes = planQuotes(V, rv); cues.q = quotes.map(q => q.t);
    cues.vs = at(`${cue.vs || 'critics give it'} ${score}`); cues.aud = at(cue.aud || 'audiences give it'); at(aud.grade);
    const gapLine = V.plan.gapLine || d.gapLine; cues.gap = at(gapLine.split(' ').slice(0, 2).join(' ')); cues.end = at('every review');
    return { ...d, ...base, gapLine, quotes, cues };
  }
  throw new Error('no voiced cut for ' + fmt);
}

const { synth } = require('./audio.js');
const AUDIO_STYLE = process.env.AUDIO_STYLE || (process.env.MUSIC ? 'sfx' : 'groove');
// Every path that writes a soundtrack goes through here: optional library music, then the voiceover over the bed.
// A voiced comp must come out clearly louder than its bed alone, or the voice never made it into the mix.
const meanDb = f => +/mean_volume: (-?[\d.]+) dB/.exec(require('child_process').spawnSync('ffmpeg', ['-i', f, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' }).stderr)[1];
// MUSIC=rotate spreads videos across the owner's picks plus an effects-only slot. The pick hangs on the
// format and show, so re-rendering a video never changes its track. Tracks live in MUSIC_DIR (Incompetech, CC BY 4.0: credit in the caption).
const ROTATION = ['Sidewalk Shade.mp3', 'I Got a Stick Arr Bryan Teoh.mp3', 'Happy Alley.mp3', 'Cheery Monday.mp3', null];
function musicFor(d) {
  if (process.env.MUSIC !== 'rotate') return process.env.MUSIC || null;
  const key = `${name}:${(d.show && d.show.title) || d.title || ''}`;
  const pick = ROTATION[[...key].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % ROTATION.length];
  if (!pick) return null;
  const f = path.join(process.env.MUSIC_DIR || '', pick);
  if (!fs.existsSync(f)) throw new Error(`MUSIC=rotate picked ${pick} but it is not in MUSIC_DIR (${process.env.MUSIC_DIR || 'unset'})`);
  return f;
}
function finishAudio(wav, dur, d, outDir) {
  const track = musicFor(d);
  console.log(`music: ${track ? path.basename(track) : 'none (effects only)'}`);
  if (track) mixMusic(wav, dur, track);
  if (!d.vo) return;
  // the bed sits BED_DUCK dB (default 14) under the voice's average loudness, whatever the source track's level
  const mix = path.join(outDir, `${name}-mix.wav`), voiceDb = meanDb(d.vo), bedDb = voiceDb - +(process.env.BED_DUCK || 14), bedVol = Math.pow(10, (bedDb - meanDb(wav)) / 20);
  require('child_process').execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, '-i', d.vo, '-filter_complex',
    `[0:a]volume=${bedVol.toFixed(4)}[m];[1:a]adelay=${VO_OFF * 1000}|${VO_OFF * 1000},volume=${process.env.VO_GAIN || 1}[v];[m][v]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9[o]`, '-map', '[o]', '-ar', '44100', mix]);
  if (!(voiceDb > -40)) throw new Error(`${name}: voiceover file is near silent (${voiceDb} dB)`);
  // power check: the mix minus the bed must carry most of the voice's energy, or the voice never made it in
  const P = db => Math.pow(10, db / 10), out = meanDb(mix);
  if (P(out) - P(bedDb) < 0.5 * P(voiceDb)) throw new Error(`${name}: voiceover missing from the mix (mix ${out} dB, bed ${bedDb.toFixed(1)} dB, voice ${voiceDb} dB)`);
  console.log(`voice check: mix ${out} dB, voice ${voiceDb} dB, bed ${bedDb.toFixed(1)} dB`);
  fs.renameSync(mix, wav);
}
function mixMusic(wav, dur, track) {
  const out = wav.replace(/\.wav$/, '-m.wav'), ss = process.env.MUSIC_START || '0', vol = process.env.MUSIC_VOL || '0.55';
  require('child_process').execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', wav, '-ss', ss, '-i', track, '-filter_complex',
    `[1:a]atrim=0:${dur},asetpts=N/SR/TB,afade=t=in:d=0.3,afade=t=out:st=${Math.max(0, dur - 2)}:d=2,volume=${vol}[m];[0:a][m]amix=inputs=2:duration=first:normalize=0,alimiter=limit=0.9[o]`, '-map', '[o]', '-ar', '44100', out]);
  fs.renameSync(out, wav);
}

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
    finishAudio(wav, info.dur, d, outDir);
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
  finishAudio(wav, info.dur, d, outDir);
  const ff2 = spawn('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(FPS), '-i', '-', '-i', wav, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'medium', '-r', String(FPS), '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', '-shortest', mp4], { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(info.dur * FPS);
  for (let i = 0; i < total; i++) { const b = await frame(i / FPS); if (!ff2.stdin.write(b)) await new Promise(r => ff2.stdin.once('drain', r)); }
  ff2.stdin.end(); await new Promise(r => ff2.on('close', r)); await browser.close();
  console.log('wrote', mp4);
})().catch(e => { console.error(e); process.exit(1); });
