// Script template for every compare video (BRO-6412, owner rule 2026-10-27): the video is built to inform AND spark
// discussion, so it opens on the puzzle (same show, two places, scores N points apart, direction and gap computed
// from the data, never typed), gives both scores and the plain caveat, offers neutral possibilities without claiming
// any as fact, and ends on an open question on screen and in the voice. render.js refuses a compare plan whose
// script or caption differs from this output, and scripts/test-compare-script.js pins the rules.
const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const words = n => { if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('compare-script: cannot say ' + n);
  if (n === 100) return 'one hundred'; if (n < 20) return ONES[n]; return TENS[Math.floor(n / 10)] + (n % 10 ? '-' + ONES[n % 10] : ''); };
const cap = s => s[0].toUpperCase() + s.slice(1);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// sides: [{ title, place, city, label, score, count, soFar, year }], the first side is the one "also reviewed" elsewhere.
function composeCompare(sides) {
  if (!Array.isArray(sides) || sides.length !== 2) throw new Error('compare-script: needs exactly two productions');
  const [A, B] = sides;
  if (A.title !== B.title) throw new Error(`compare-script: not the same show ("${A.title}" vs "${B.title}")`);
  sides.forEach(s => { ['place', 'city', 'label', 'score', 'count', 'year'].forEach(k => { if (s[k] == null) throw new Error(`compare-script: ${s.label || s.place} is missing ${k}`); }); });
  const gap = Math.abs(A.score - B.score), tie = gap === 0, hi = tie ? null : (A.score > B.score ? A : B);
  const years = Math.abs(A.year - B.year);
  // the hook: the puzzle, direction and gap straight from the scores
  const hook = tie ? 'Same show, two cities, and the critics gave it the same score.'
    : `Same show, two cities, and ${hi.place}'s critics scored it ${words(gap)} ${gap === 1 ? 'point' : 'points'} higher.`;
  const screenHook = { gap, l1: 'Same show. Two cities.', l2: tie ? 'Same score.' : `${hi.place} scored it ${plural(gap, 'point')} higher.` };
  const alsoIn = `That's ${A.title}, which was also reviewed in ${A.place}.`;
  const scoreA = `${cap(words(A.score))}, from ${words(A.count)} reviews${A.soFar ? ' so far' : ''}.`;
  const scoreB = `Now ${B.place}: ${words(B.score)}, from ${words(B.count)} reviews${B.soFar ? ' so far' : ''}.`;
  const caveat = `${years ? cap(words(years)) + ' ' + (years === 1 ? 'year' : 'years') + ' apart' : 'Same year'}, different critics, and the cast and production may differ, so it's not a perfect comparison.`;
  // possibilities are worded as maybes, never as the answer
  const poss = `Maybe the production changed, or maybe ${A.city} and ${B.city} critics just see it differently.`;
  const question = tie ? 'Why do you think the critics agreed? Tell us below.' : 'Why do you think the critics split? Tell us below.';
  const prompt = ['[curious]', hook, alsoIn, scoreA, scoreB, caveat, poss, question].join(' ');
  const cA = `${A.label}: Critic Score ${A.score} from ${A.count} critics${A.soFar ? ' so far' : ''}.`, cB = `${B.label}: ${B.score} from ${B.count} critics${B.soFar ? ' so far' : ''}.`;
  const caption = [tie ? `Same show, two cities, same score: ${A.title}, also reviewed in ${A.place}.` : `Same show, two cities. ${hi.place}'s critics scored ${A.title} ${plural(gap, 'point')} higher.`,
    cA, cB, caveat, poss, question, 'See every review at broadwayscorecard.com'].join(' ').replace(/ See every/, '\n\nSee every');
  const keep = { prompt: ['was also reviewed in ' + A.place, words(A.score), words(A.count), B.place, words(B.score), words(B.count), caveat.split(',')[0], 'Maybe the production changed', question.split('?')[0]],
    caption: [String(A.score), String(A.count), String(B.score), String(B.count), 'like-for-like', question] };
  return { gap, tie, hi: hi && hi.label, years, hook, screenHook, caveat, poss, possCard: poss, question, prompt, caption, keep, cue: { end: 'Why do you think' } };
}
module.exports = { composeCompare, words };
