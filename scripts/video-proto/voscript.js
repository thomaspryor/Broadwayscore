// Voiceover scripts (BRO-6250), written from the show's data so any show gets one.
// usage: node voscript.js <verdict|reveal|every|top5> <show-id | top5 list key> <outDir> [name]
// Writes <outDir>/<name>.plan.json: the text-to-speech prompt plus the quotes it reads. render.js reads the plan,
// re-checks every quote and number against the data, and cues each scene off the word the voice is saying.
const fs = require('fs'), path = require('path');
const { getScoreTierId, SCORE_TIER_LABELS } = require('../lib/score-tiers.js');
const { slim, meta, topList, breakdown, audienceGradeOf, gapLine } = require('./showdata.js');

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

const quoteLine = p => `${p.against ? '[dryly] But ' : ''}${p.say} said, "${p.ex.replace(/[.!?]+$/, '')}."`;
const tierLabel = (s, cat) => SCORE_TIER_LABELS[getScoreTierId(s, cat)];

async function plan(fmt, key, cache) {
  if (fmt === 'top5') {
    const L = topList(key), shows = L.ids.map(id => ({ id, title: meta(id).title, score: Math.round(slim(id).cs) }));
    const spokenTitle = L.title.replace(/\d+/g, d => W(+d));
    const parts = shows.slice().reverse().map((s, i) => `${i === 4 ? 'And number one' : 'Number ' + W(5 - i)}: ${s.title}${/[!?]$/.test(s.title) ? '' : ','} ${i === 4 ? 'with ' : ''}${W(s.score)}${i === 4 ? '!' : '.'}`);
    return { fmt, key, prompt: `[excited] ${spokenTitle}, ranked by Critic Score. ${parts.join(' ')} ${L.endLine} Find them all on Broadway Scorecard.` };
  }
  const m = meta(key), p = slim(key), rv = p.rv.filter(r => Number.isFinite(r.s));
  const aud = audienceGradeOf(p); if (!aud) throw new Error(key + ': no audience grade');
  const au = p.au.score, score = Math.round(p.cs), label = tierLabel(score, m.category), c = breakdown(rv, m.category), N = rv.length, G = gradeSaid(aud.grade);
  if (!WHERE[m.category]) throw new Error('no wording for market ' + m.category);
  if (fmt === 'every') {
    const items = [['rave', 'raves'], ['positive', 'positive'], ['mixed', 'mixed'], ['negative', 'negative']].filter(([k]) => c[k] > 0);
    const lines = items.map(([k, many], i) => {
      const n = c[k], said = n === 1 ? (k === 'rave' ? 'one rave' : `one ${k} review`) : `${W(n)} ${many}`;
      if (i === 0) return k === 'rave' ? `Here come the raves. ${cap(W(n))} of them!` : `First, ${said}.`;
      return `${i === items.length - 1 ? 'And' : 'Then'} ${said}.`;
    });
    return { fmt, key, prompt: `[excited] Every review of ${m.title}, in thirty seconds. ${cap(W(N))} critics. ${lines.join(' ')} That makes the Critic Score ${W(score)}. ${label}. Every review is on Broadway Scorecard.` };
  }
  const picks = await Promise.all(pickReviews(rv).map(async r => ({ o: r.o, s: r.s, against: !!r.against, say: sayOutlet(r.o), ex: await excerpt(r.q, cache) })));
  const quotes = picks.map(quoteLine).join(' ');
  const audLine = au - p.cs > 3 ? `And audiences like it even more, with ${article(aud.grade)} ${G}.` : au - p.cs < -3 ? `[dryly] Audiences are cooler on it, with ${article(aud.grade)} ${G}.` : `And audiences agree, with ${article(aud.grade)} ${G}.`;
  if (fmt === 'verdict') {
    const open = m.category === 'broadway' || m.category === 'west-end'
      ? `${m.category === 'broadway' ? 'Opening night' : 'Press night'} verdict! ${m.title} just opened ${WHERE[m.category]}, and ${W(N)} critics have weighed in.`
      : `The reviews are in! ${cap(W(N))} critics have weighed in on ${m.title}, ${WHERE[m.category]}.`;
    const items = [['rave', 'raves'], ['positive', 'positive'], ['mixed', 'mixed'], ['negative', 'negative']].filter(([k]) => c[k] > 0)
      .map(([k, many]) => c[k] === 1 && k === 'rave' ? 'one rave' : `${W(c[k])} ${many}`);
    const tally = items.length > 1 ? items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1] : items[0];
    return { fmt, key, quotes: picks, prompt: `[excited] ${open} ${quotes} ${cap(tally)}. The Critic Score is ${W(score)}. ${label}. ${audLine} Every review is on Broadway Scorecard.` };
  }
  if (fmt === 'reveal') {
    return { fmt, key, quotes: picks, prompt: `[excited] ${cap(W(N))} critics weighed in on ${m.title}. One score. ${cap(W(score))}! ${label}. Here's what they said. ${quotes} Critics give it ${W(score)}. Audiences give it ${article(aud.grade)} ${G}. ${gapLine(au, p.cs)} Every review, one score, on Broadway Scorecard.` };
  }
  throw new Error('unknown format ' + fmt);
}

if (require.main === module) (async () => {
  const [fmt, key, outDir, name = fmt] = process.argv.slice(2);
  if (!fmt || !key || !outDir) throw new Error('usage: node voscript.js <verdict|reveal|every|top5> <show-id|list> <outDir> [name]');
  const cf = path.join(outDir, 'excerpts.json'), cache = fs.existsSync(cf) ? JSON.parse(fs.readFileSync(cf, 'utf8')) : {};
  const P = await plan(fmt, key, cache);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(cf, JSON.stringify(cache, null, 1));
  fs.writeFileSync(path.join(outDir, name + '.plan.json'), JSON.stringify(P, null, 1));
  console.log(P.prompt);
})().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { plan, W };
