// Framing rule for every voiced video script (BRO-6449, extends BRO-6417 / owner 2026-10-27): videos are built to
// spark discussion, so the voiceover ends on an open question and the caption asks it too. Duo and versus also
// open on the puzzle (a question or a guess within the first three sentences). Compare has its own generator
// (compare-script.js) and is not checked here; "how" is a how-it-works explainer with no discussion hook.
// render.js calls assertFraming() before spending a render; voscript.js writes scripts that pass it.
const RULE_FMTS = new Set(['verdict', 'reveal', 'every', 'top5', 'duo', 'versus']);
const PUZZLE_FMTS = new Set(['duo', 'versus']);
// Published before the rule existed: their voiceover is paid and already out, so they are not re-scripted (do not re-render them).
const LEGACY = new Set(['duo:explainer-guess', 'duo:explainer-trailer']);
const NUMBER = /\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred)\b/gi;
const sentences = t => String(t || '').replace(/\[[a-z ]+\]/gi, ' ').split(/\n+/).flatMap(par => par.replace(/\s+/g, ' ').trim().match(/[^.!?]+[.!?]+["'\u201d\u2019)\]]*(?=\s|$)|[^.!?]+$/g) || []); // a paragraph break ends a sentence
const QEND = /\?["'\u201d\u2019)\]]*$/; // a question may close inside a quote
const { foldDiacritics } = require('../lib/title-match'); // fold first so a title's accents are not shredded (task #781)
const stem = s => foldDiacritics(s).toLowerCase().replace(NUMBER, '#').replace(/#([\s-]+#)+/g, '#').replace(/[^a-z#]+/g, ' ').trim(); // spoken "eighty-six" and captioned "86" count as the same words

// returns a list of problems, empty when the script follows the rule
function checkFraming(plan, { needCaption = true } = {}) {
  const fmt = plan && plan.fmt;
  if (!RULE_FMTS.has(fmt) || LEGACY.has(`${fmt}:${plan.key}`)) return [];
  const problems = [], voice = sentences(plan.prompt).map(s => s.trim()).filter(Boolean);
  const last = voice[voice.length - 1] || '';
  if (!QEND.test(last)) problems.push(`${fmt}: the voiceover must end on an open question, it ends "${last.slice(-60)}"`);
  else if (needCaption && !sentences(plan.caption).some(s => QEND.test(s.trim()) && stem(s) === stem(last))) problems.push(`${fmt}: the caption must ask the same closing question: "${last}"`);
  if (PUZZLE_FMTS.has(fmt) && !voice.slice(0, 3).some(s => QEND.test(s) || /\bguess\b/i.test(s))) problems.push(`${fmt}: the voiceover must open on the puzzle (a question or a guess in the first three sentences)`);
  return problems;
}
function assertFraming(plan, opts) { const p = checkFraming(plan, opts); if (p.length) throw new Error(`script framing rule (BRO-6449): ${p.join('; ')}`); }
module.exports = { checkFraming, assertFraming, RULE_FMTS, LEGACY };
