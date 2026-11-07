// Builds a compare plan from show ids: scores and counts come from showdata, the script and caption from
// compare-script.js. render.js calls assertTemplate() so a hand-edited compare script cannot be rendered.
// CLI: node compare-plan.js <key> <idA>:<label>:<place>:<city> <idB>:<label>:<place>:<city> [--soFar=B] > plans/<key>.plan.json
const { composeCompare } = require('./compare-script');
const yearOf = m => +String(m.openingDate || m.previewsStartDate || '').slice(0, 4) || null;

function sidesFor(shows) {
  const { showInfo, meta } = require('./showdata');
  return shows.map(s => { const x = showInfo(s.id), m = meta(s.id), rv = x.p.rv.filter(r => Number.isFinite(r.s));
    return { title: x.title, place: s.place, city: s.city, label: s.label, score: Math.round(x.score), count: rv.length, soFar: !!s.soFar, year: yearOf(m) || +(/\d{4}/.exec(s.label) || [])[0] }; });
}
function buildPlan({ key, shows, tags }) {
  const c = composeCompare(sidesFor(shows));
  return { fmt: 'compare', key, shows, caveat: c.caveat, screen: { ...c.screenHook, poss: c.poss, question: c.question }, cue: c.cue,
    prompt: c.prompt, caption: c.caption + (tags ? '\n\n' + tags : ''), keep: c.keep };
}
function assertTemplate(plan) {
  const want = buildPlan(plan);
  for (const k of ['prompt', 'caveat']) if (plan[k] !== want[k]) throw new Error(`compare plan ${plan.key}: ${k} is not the template output (run compare-plan.js, do not hand-edit)\n  have: ${plan[k]}\n  want: ${want[k]}`);
  if (!plan.caption.startsWith(want.caption)) throw new Error(`compare plan ${plan.key}: caption is not the template output`);
  return want;
}
module.exports = { buildPlan, assertTemplate, sidesFor };
if (require.main === module) {
  const [key, ...rest] = process.argv.slice(2).filter(a => !a.startsWith('--')), soFar = (process.argv.find(a => a.startsWith('--soFar=')) || '').slice(8);
  const tags = (process.argv.find(a => a.startsWith('--tags=')) || '').slice(7);
  const shows = rest.map((r, i) => { const [id, label, place, city] = r.split(':'); return { id, label, place, city, ...(soFar === 'AB'[i] ? { soFar: true } : {}) }; });
  console.log(JSON.stringify(buildPlan({ key, shows, tags }), null, 1));
}
