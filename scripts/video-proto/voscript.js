// Voiceover scripts (BRO-6250), written from the show's data so any show gets one.
// usage: node voscript.js <verdict|reveal|every|top5> <show-id | top5 list key> <outDir> [name]
// Writes <outDir>/<name>.plan.json: the text-to-speech prompt plus the quotes it reads. render.js reads the plan,
// re-checks every quote and number against the data, and cues each scene off the word the voice is saying.
const fs = require('fs'), path = require('path');
const { getScoreTierId, SCORE_TIER_LABELS } = require('../lib/score-tiers.js');
const { slim, meta, topList, breakdown, audienceGradeOf } = require('./showdata.js');

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
// numbers are spelled out for the voice so it never reads "67" as "six seven"
const W = n => n < 20 ? ONES[n] : n === 100 ? 'one hundred' : TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : '');
const cap = s => s[0].toUpperCase() + s.slice(1);
const gradeSaid = g => g.replace('+', '-plus').replace(/-$/, '-minus').replace(/^([A-F])-(?!plus|minus)/, '$1-minus');
const article = g => /^[AEF]/.test(g) ? 'an' : 'a';
const WHERE = { broadway: 'on Broadway', 'off-broadway': 'Off-Broadway', 'west-end': 'in the West End', 'off-west-end': 'Off-West End' };
// outlets the voice should name with "The" even though the data stores them without it
const SAY_THE = /^(New York Post|Chicago Tribune|Los Angeles Times|Washington Post|Boston Globe|Guardian|Independent|Stage|Telegraph|Times)$/;
const sayOutlet = o => (SAY_THE.test(o) ? 'The ' : '') + o;

// Quote picks: the best-scored positive review from a top-tier outlet, a second positive one, and when the
// critics split, the lowest-scored top-tier pan. Lower tiers fill in only when the top tiers have no candidate.
function pickReviews(rv) {
  const withQ = rv.filter(r => r.q && r.q.trim()), byTier = (a, b) => a.t - b.t;
  const pos = withQ.filter(r => r.s >= 70).sort((a, b) => byTier(a, b) || b.s - a.s);
  const neg = withQ.filter(r => r.s < 55 && r.t <= 2).sort((a, b) => byTier(a, b) || a.s - b.s);
  const picks = pos.slice(0, 1);
  const second = pos.find(r => r.o !== picks[0].o && r.t <= 2); if (second) picks.push(second);
  if (neg[0]) picks.push({ ...neg[0], against: true });
  else { const third = pos.find(r => !picks.some(p => p.o === r.o)); if (third) picks.push(third); }
  if (picks.length < 2) throw new Error('fewer than 2 quotable reviews');
  return picks;
}

// The excerpt the voice reads must be the critic's own words: a short span copied out of the stored quote.
// Short quotes are read whole; long ones get a span picked by a model, then checked to be verbatim here.
const norm1 = s => s.replace(/[’‘]/g, "'").replace(/[“”]/g, '"'); // 1:1 so indices match the original
const words = s => s.trim().split(/\s+/).length;
async function excerpt(q, cache) {
  const full = q.trim().replace(/\.\.\.$|…$/, '').trim();
  if (words(full) <= 16) return full;
  if (cache[q]) return cache[q];
  if (!process.env.OPENAI_API_KEY) throw new Error('long quote needs OPENAI_API_KEY to pick a short excerpt: ' + q.slice(0, 60));
  const body = { model: process.env.EXCERPT_MODEL || 'gpt-5.4-mini', response_format: { type: 'json_object' }, messages: [{ role: 'user', content:
    `A theatre critic wrote this line:\n\n${q}\n\nCopy out ONE contiguous span of it, 5 to 14 words, that carries the critic's opinion of the show and reads naturally when spoken aloud on its own. Copy it character for character: do not change, add or drop any word or punctuation inside the span. Reply as JSON: {"span": "..."}` }] };
  const res = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY }, body: JSON.stringify(body) });
  const j = await res.json(); if (j.error) throw new Error('excerpt model: ' + j.error.message);
  let span = JSON.parse(j.choices[0].message.content).span.trim().replace(/[.,;:]$/, '');
  const i = norm1(q).indexOf(norm1(span));
  if (i < 0 || words(span) < 4 || words(span) > 16) throw new Error(`excerpt is not a verbatim 4-16 word span of the quote: "${span}"`);
  span = q.slice(i, i + span.length);
  return (cache[q] = span);
}

// Wording rotates per show so a feed of these never reads the same twice. Each slot lists interchangeable lines;
// a line may carry {placeholders}. Lines that the renderer times scenes against keep the phrase named in CUE_OF,
// and the plan records which phrase it used so render.js listens for that one.
let HIST = null, HIST_FILE = null;
const seedOf = s => [...s].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7);
function pick(slot, opts, key) {
  const used = (HIST[slot] = HIST[slot] || []), avoid = used.slice(-Math.min(2, opts.length - 1));
  const free = opts.map((_, i) => i).filter(i => !avoid.includes(i)), i = free[seedOf(key + '|' + slot) % free.length];
  used.push(i); HIST[slot] = used.slice(-6); return opts[i];
}
const fill = (t, v) => t.replace(/\{(\w+)\}/g, (_, k) => { if (v[k] == null) throw new Error('no value for {' + k + '}'); return v[k]; });
const LINES = {
  verdictOpenBig: ['{kicker}! {T} just opened {where}, and {n} critics have weighed in.', 'The {night} reviews for {T} are in. {N} critics have weighed in.', '{T} is now open {where}. Here is what {n} critics thought.'],
  verdictOpenSmall: ['The reviews are in! {N} critics have weighed in on {T}, {where}.', '{N} critics have now reviewed {T}, {where}.', '{T} opened {where}, and {n} critics have weighed in.'],
  tally: ['{Tally}.', 'All in, {tally}.', 'Overall, {tally}.'],
  verdictScore: [['The Critic Score is {s}.', 'critic score'], ['That puts the Critic Score at {s}.', 'critic score'], ['That gives it a Critic Score of {s}.', 'critic score']],
  audMore: ['And audiences like it even more, with {a} {G}.', 'Audiences are even warmer, with {a} {G}.', 'Audiences like it even more and give it {a} {G}.'],
  audLess: ['[dryly] Audiences are cooler on it, with {a} {G}.', '[dryly] Audiences are less sold, with {a} {G}.', '[dryly] Audiences are a bit cooler, with {a} {G}.'],
  audSame: ['And audiences agree, with {a} {G}.', 'Audiences are right there too, with {a} {G}.', 'And audiences land in the same place, with {a} {G}.'],
  signoff: ['Every review is on Broadway Scorecard.', 'Read every review on Broadway Scorecard.', 'You can read every review on Broadway Scorecard.'],
  revealOpen: ['{N} critics weighed in on {T}.', '{N} critics have reviewed {T}.', 'What did {n} critics make of {T}?'],
  revealCount: [['One score.', 'one score'], ['Here it is in one number.', 'one number'], ['Put it all together, and you get one score.', 'one score']],
  revealQuotes: [["Here's what they said.", 'what they said'], ['In their own words.', 'in their own words'], ["Here's how they put it.", 'how they put it']],
  revealVs: [['Critics give it {s}.', 'critics give it'], ['The critics land on {s}.', 'the critics land on'], ['The critics say {s}.', 'the critics say']],
  revealAud: [['Audiences give it {a} {G}.', 'audiences give it'], ['Audiences grade it {a} {G}.', 'audiences grade it'], ['And audiences say {a} {G}.', 'audiences say']],
  revealEnd: ['Every review, one score, on Broadway Scorecard.', 'See every review on Broadway Scorecard.', 'Every review is on Broadway Scorecard.'],
  everyOpen: ['Every review of {T}, in thirty seconds. {N} critics.', '{N} critics reviewed {T}. Here is every one of them in thirty seconds.', 'All {n} critics on {T}, in thirty seconds.'],
  everyRaves: ['Here come the raves. {Cn} of them!', 'Starting with the raves. {Cn} of them.', 'First up, {cn} raves.'],
  everyFirst: ['First, {said}.', 'We start with {said}.', 'Up first, {said}.'],
  everyThen: ['Then {said}.', 'Next, {said}.', 'After that, {said}.'],
  everyLast: ['And {said}.', 'And finally, {said}.', 'Last, {said}.'],
  everyScore: [['That makes the Critic Score {s}.', 'critic score'], ['Put together, that is a Critic Score of {s}.', 'critic score'], ['So the Critic Score is {s}.', 'critic score']],
  gapMore: ['They like it even more than the critics do.', 'So audiences are the bigger fans here.', 'The crowd is even happier than the critics.'],
  gapLess: ['Critics like it more than audiences do.', 'So the critics are the bigger fans here.', 'Critics are warmer on this one than audiences.'],
  gapSame: ['Critics and audiences agree.', 'Critics and audiences are on the same page.', 'So both sides land in the same place.'],
  top5Lead: ['{L}, ranked by Critic Score.', '{L}, by Critic Score.', 'These are the {l}, ranked by Critic Score.'],
  top5End: ['Find them all on Broadway Scorecard.', 'All five are on Broadway Scorecard.', 'Every score is on Broadway Scorecard.'],
  capVerdict: ['{T} just opened {where} and {n} critics have weighed in. Critic Score: {s}, {label}. {Aud} Every review is at broadwayscorecard.com', 'The {night} reviews for {T} are in: {n} critics, Critic Score {s}, {label}. {Aud} Every review is at broadwayscorecard.com', '{n} critics have reviewed {T} so far. The Critic Score is {s}, {label}. {Aud} Read them all at broadwayscorecard.com'],
  capReveal: ['{n} critics weighed in on {T}. One score: {s}, {label}. Audiences give it {a} {g}. Every review is at broadwayscorecard.com', '{n} reviews of {T}, one number: {s}, {label}. Audiences give it {a} {g}. Every review is at broadwayscorecard.com', '{T}: {n} critics, one Critic Score of {s} ({label}). Audiences give it {a} {g}. Every review is at broadwayscorecard.com'],
  capEvery: ['All {n} reviews of {T}: {tally}. Critic Score: {s}, {label}. Every review is at broadwayscorecard.com', '{n} critics on {T}, sorted: {tally}. That adds up to a Critic Score of {s}, {label}. Every review is at broadwayscorecard.com', 'Every review of {T} in one place: {tally}. Critic Score {s}, {label}. Read them at broadwayscorecard.com'],
  capTop5: ['{L}, ranked by Critic Score. Every score is at broadwayscorecard.com', '{L}, by Critic Score. Do you agree with number one? Every score is at broadwayscorecard.com', '{L}, ranked by what critics said. The full list is at broadwayscorecard.com'],
};
const line = (slot, key, v) => { const o = pick(slot, LINES[slot], key); return Array.isArray(o) ? [fill(o[0], v), o[1]] : [fill(o, v), null]; };
const tagFor = t => '#' + t.replace(/^The /, '').replace(/[^A-Za-z0-9]/g, '');
const hashtags = (m) => [m.category === 'broadway' ? '#Broadway' : m.category.startsWith('off-broadway') ? '#OffBroadway' : '#WestEnd', tagFor(m.title), '#Theater', m.category.includes('west') ? '#London' : '#NYC'].join(' ');

const quoteLine = p => `${p.against ? '[dryly] But ' : ''}${p.say} said, "${p.ex.replace(/[.!?]+$/, '')}."`;
const tierLabel = (s, cat) => SCORE_TIER_LABELS[getScoreTierId(s, cat)];

async function plan(fmt, key, cache) {
  // VO_SALT picks a different set of lines, for a retry after the copy review blocks one
  const K = fmt + '|' + key + '|' + (process.env.VO_DATE || new Date().toISOString().slice(0, 10)) + (process.env.VO_SALT || '');
  if (fmt === 'top5') {
    const L = topList(key), shows = L.ids.map(id => ({ id, title: meta(id).title, score: Math.round(slim(id).cs) }));
    const spokenTitle = L.title.replace(/\d+/g, d => W(+d));
    const parts = shows.slice().reverse().map((s, i) => `${i === 4 ? 'And number one' : 'Number ' + W(5 - i)}: ${s.title}${/[!?]$/.test(s.title) ? '' : ','} ${i === 4 ? 'with ' : ''}${W(s.score)}${i === 4 ? '!' : '.'}`);
    const v = { L: spokenTitle, l: spokenTitle[0].toLowerCase() + spokenTitle.slice(1) };
    const caption = line('capTop5', K, { L: L.title, l: L.title }) [0] + '\n\n#Broadway #Theater #NYC';
    return { fmt, key, caption, prompt: `[excited] ${line('top5Lead', K, v)[0]} ${parts.join(' ')} ${L.endLine} ${line('top5End', K, v)[0]}` };
  }
  const m = meta(key), p = slim(key), rv = p.rv.filter(r => Number.isFinite(r.s));
  const aud = audienceGradeOf(p); if (!aud) throw new Error(key + ': no audience grade');
  const au = p.au.score, score = Math.round(p.cs), label = tierLabel(score, m.category), c = breakdown(rv, m.category), N = rv.length, G = gradeSaid(aud.grade);
  if (!WHERE[m.category]) throw new Error('no wording for market ' + m.category);
  if (fmt === 'every') {
    const items = [['rave', 'raves'], ['positive', 'positive'], ['mixed', 'mixed'], ['negative', 'negative']].filter(([k]) => c[k] > 0);
    const lines = items.map(([k, many], i) => {
      const n = c[k], said = n === 1 ? (k === 'rave' ? 'one rave' : `one ${k} review`) : `${W(n)} ${many}`;
      if (i === 0) return k === 'rave' && n > 1 ? line('everyRaves', K, { Cn: cap(W(n)), cn: W(n) })[0] : cap(line('everyFirst', K, { said })[0]);
      return line(i === items.length - 1 ? 'everyLast' : 'everyThen', K, { said })[0];
    });
    const [sc, scoreLead] = line('everyScore', K, { s: W(score) });
    const tallyCap = items.map(([k]) => `${c[k]} ${k === 'rave' ? (c[k] === 1 ? 'rave' : 'raves') : k}`).join(', ');
    const caption = line('capEvery', K, { n: N, T: m.title, tally: tallyCap, s: score, label }) [0] + '\n\n' + hashtags(m);
    return { fmt, key, caption, cue: { score: scoreLead }, prompt: `[excited] ${line('everyOpen', K, { T: m.title, N: cap(W(N)), n: W(N) })[0]} ${lines.join(' ')} ${sc} ${label}. ${line('signoff', K, {})[0]}` };
  }
  const picks = await Promise.all(pickReviews(rv).map(async r => ({ o: r.o, s: r.s, against: !!r.against, say: sayOutlet(r.o), ex: await excerpt(r.q, cache) })));
  const quotes = picks.map(quoteLine).join(' ');
  const dir = au - p.cs > 3 ? 'audMore' : au - p.cs < -3 ? 'audLess' : 'audSame', av = { a: article(aud.grade), G };
  const audCap = { audMore: `Audiences like it more and give it ${av.a} ${aud.grade}.`, audLess: `Audiences are cooler, with ${av.a} ${aud.grade}.`, audSame: `Audiences agree and give it ${av.a} ${aud.grade}.` }[dir];
  if (fmt === 'verdict') {
    const big = m.category === 'broadway' || m.category === 'west-end', night = m.category === 'west-end' ? 'press night' : 'opening night';
    const ov = { kicker: cap(night) + ' verdict', night, T: m.title, where: WHERE[m.category], n: W(N), N: cap(W(N)) };
    const open = line(big ? 'verdictOpenBig' : 'verdictOpenSmall', K, ov)[0];
    const items = [['rave', 'raves'], ['positive', 'positive'], ['mixed', 'mixed'], ['negative', 'negative']].filter(([k]) => c[k] > 0)
      .map(([k, many]) => c[k] === 1 && k === 'rave' ? 'one rave' : `${W(c[k])} ${many}`);
    const tally = items.length > 1 ? items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1] : items[0];
    const [sc, scoreLead] = line('verdictScore', K, { s: W(score) });
    const caption = line('capVerdict', K, { T: m.title, where: WHERE[m.category], night, n: N, s: score, label, Aud: audCap }) [0].replace(/^./, ch => ch.toUpperCase()) + '\n\n' + hashtags(m);
    return { fmt, key, quotes: picks, caption, cue: { score: scoreLead, aud: 'audiences' }, prompt: `[excited] ${open} ${quotes} ${line('tally', K, { Tally: cap(tally), tally })[0]} ${sc} ${label}. ${line(dir, K, av)[0]} ${line('signoff', K, {})[0]}` };
  }
  if (fmt === 'reveal') {
    const [cnt, count] = line('revealCount', K, {}), [qi, quotesIn] = line('revealQuotes', K, {});
    const [vs, vsLead] = line('revealVs', K, { s: W(score) }), [al, audLead] = line('revealAud', K, av);
    const gap = line({ audMore: 'gapMore', audLess: 'gapLess', audSame: 'gapSame' }[dir], K, {})[0];
    const caption = line('capReveal', K, { n: N, T: m.title, s: score, label, a: av.a, g: aud.grade }) [0] + '\n\n' + hashtags(m);
    return { fmt, key, quotes: picks, caption, gapLine: gap, cue: { count, quotesIn, vs: vsLead, aud: audLead }, prompt: `[excited] ${cap(line('revealOpen', K, { N: cap(W(N)), n: W(N), T: m.title })[0])} ${cnt} ${cap(W(score))}! ${label}. ${qi} ${quotes} ${vs} ${al} ${gap} ${line('revealEnd', K, {})[0]}` };
  }
  throw new Error('unknown format ' + fmt);
}

if (require.main === module) (async () => {
  const [fmt, key, outDir, name = fmt] = process.argv.slice(2);
  if (!fmt || !key || !outDir) throw new Error('usage: node voscript.js <verdict|reveal|every|top5> <show-id|list> <outDir> [name]');
  const cf = path.join(outDir, 'excerpts.json'), cache = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, 'utf8')) : {};
  HIST_FILE = process.env.VO_HISTORY || path.join(outDir, 'phrase-history.json');
  HIST = fs.existsSync(HIST_FILE) ? JSON.parse(fs.readFileSync(HIST_FILE, 'utf8')) : {};
  // with VO_REVIEW=1 the two-model copy review runs here, and a blocked script is redrawn with other lines (3 tries)
  let P, tries = process.env.VO_REVIEW ? 3 : 1;
  const base = JSON.stringify(HIST);
  for (let t = 0; t < tries; t++) {
    HIST = JSON.parse(base); if (t) process.env.VO_SALT = (process.env.VO_SALT || '') + '#' + t;
    P = await plan(fmt, key, cache);
    if (!process.env.VO_REVIEW) break;
    console.error(`copy review, try ${t + 1}:`);
    P.review = await require('./copyreview.js').review(P, m => console.error(m));
    if (P.review.pass) break;
  }
  // every phrase the renderer will listen for has to be in the script, or the render fails after paying for the voice
  const flat = t => ' ' + t.toLowerCase().replace(/[^a-z0-9']+/g, ' ') + ' ';
  Object.values(P.cue || {}).forEach(c => { if (!flat(P.prompt).includes(flat(c))) throw new Error(`script lost its timing phrase "${c}"`); });
  fs.mkdirSync(outDir, { recursive: true });
  if (!process.env.VO_DRY) fs.writeFileSync(HIST_FILE, JSON.stringify(HIST, null, 1));
  fs.writeFileSync(cf, JSON.stringify(cache, null, 1));
  fs.writeFileSync(path.join(outDir, name + '.plan.json'), JSON.stringify(P, null, 1));
  console.log(P.prompt);
  if (P.review && !P.review.pass) { console.error('BLOCKED by copy review: ' + P.review.issues.join(' | ')); process.exit(1); }
})().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { plan, W, LINES, setHistory: h => { HIST = h; } };
