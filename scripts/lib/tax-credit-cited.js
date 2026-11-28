'use strict';

// Is the NY State theater tax credit cited as received for this show?
// (BRO-4989 shadow option taxCreditCitedOnly.)
//
// The live model adds the credit (up to $3M) for every show in the program
// window. Reported "% recouped" figures usually leave it out until it is
// paid, so the model ran 15-21 points high on 2020+ shows. The shadow
// option counts it only when a source says it was received or that it is
// part of the reported position ("with the help of a New York state tax
// credit"). "Eligible", "expected", "if ... is received", future tense
// ("will get part way there", Little Bear Ridge Road, NYT) and negations
// ("has not yet received", "no tax credit", "received? unknown") do not count.

const FIELDS = ['taxCreditReceivedSource', 'notes', 'estimatedRecoupmentSource', 'recoupedSource'];

// One clause around the phrase "tax credit"; sentences split on . ; and |
const CLAUSE_RE = /[^.;|]*tax\s*credit[^.;|]*/gi;
const RECEIVED_RE = /\b(received|receiving|was paid|been paid|paid out|helped by|with the help of|thanks to)\b/i;
const HEDGE_RE = /\b(if|will|shall|eligible|expected|would|could|may|might|pending|applied for|qualif(?:y|ied|ies))\b/i;
const NEGATION_RE = /\b(no|not|never|without|unknown|unclear|unconfirmed)\b|n't\b|\?/i;

/**
 * @param {object} commercial record
 * @returns {{ cited: boolean, quote: string|null }}
 */
function taxCreditCited(commercial) {
  const c = commercial || {};
  if (typeof c.taxCreditReceivedSource === 'string' && c.taxCreditReceivedSource.trim()) {
    return { cited: true, quote: c.taxCreditReceivedSource.trim() };
  }
  for (const f of FIELDS) {
    const text = typeof c[f] === 'string' ? c[f] : '';
    for (const clause of text.match(CLAUSE_RE) || []) {
      if (RECEIVED_RE.test(clause) && !HEDGE_RE.test(clause) && !NEGATION_RE.test(clause)) return { cited: true, quote: clause.trim() };
    }
  }
  return { cited: false, quote: null };
}

module.exports = { taxCreditCited };
