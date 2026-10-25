/**
 * Classify a multi-show split section (child or parent) for scoring risk
 * (BRO-6000). Pure functions so a unit test can require() the real thing
 * (CLAUDE.md rule 15).
 *
 * The risk: a section cut from a joint article can open on a back-reference
 * whose antecedent sits in the removed section ("I don't recommend that
 * approach for the other production"). Models read that as a verdict on this
 * show. Two signals mark a review for a look: the opening sentence reads as a
 * back-reference, and the ensemble split with Claude (which read the whole
 * section) higher than the other legs.
 */
const fs = require('fs');
const path = require('path');
const { isSplitSection } = require('./split-excerpt-note');
const { listShowDirs } = require('./list-show-dirs');
const { isReviewTextFile } = require('./review-text-sidecars');

// A sentence that cannot stand at the start of a review: a contrast or
// continuation word, or a pointer to a show/choice that is not named.
const LEAD_WORD_RE = /^["“'‘(\s]*(though|although|while|whilst|but|and|so|still|yet|likewise|similarly|unlike|like|whereas|meanwhile|also|then|instead|however|that said|by contrast|in contrast|on the other hand)\b/i;
const POINTER_RE = /\b(the other (?:show|production|play|musical|piece|one|[a-z]+ production)|the (?:first|second|former|latter|previous|earlier) (?:show|production|play|musical|piece|one|half)|that (?:approach|tack|route|method|strategy|choice|trick|device|tactic)|this (?:approach|tack|method)|the same (?:approach|trick|device|tack))\b/i;

/** First sentence of the text, trimmed (cuts at the first . ! ? followed by a space and a capital or quote). */
function firstSentence(text) {
  const t = String(text || '').trim();
  const m = t.match(/^[\s\S]*?[.!?]["”’')]*(?=\s+["“‘']?[A-Z]|\s*$)/);
  return (m ? m[0] : t.slice(0, 300)).slice(0, 400);
}

/** @returns {{danglingLead:boolean, reasons:string[]}} */
function danglingLead(text) {
  const s = firstSentence(text);
  const reasons = [];
  if (LEAD_WORD_RE.test(s)) reasons.push('opens on a contrast/continuation word');
  if (POINTER_RE.test(s)) reasons.push('points at an unnamed show or choice');
  return { danglingLead: reasons.length > 0, reasons };
}

function leg(ens, key) {
  const v = ens && ens[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {object} file a review-texts record
 * @returns {null|{showId:string, score:number|null, claude:number|null, others:number[], claudeLead:number|null,
 *   danglingLead:boolean, reasons:string[], suspect:boolean, why:string[]}}
 *   null when the file is not a split section or carries no score.
 */
function classifySplitSection(file) {
  if (!isSplitSection(file)) return null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const score = num(file.assignedScore) != null ? file.assignedScore
    : (file.llmScore ? num(file.llmScore.score) : null);
  if (score == null) return null;
  const ens = file.ensembleData || {};
  const claude = leg(ens, 'claudeScore');
  const others = ['openaiScore', 'geminiScore', 'kimiScore'].map((k) => leg(ens, k)).filter((v) => v != null);
  const othersMean = others.length >= 2 ? others.reduce((a, b) => a + b, 0) / others.length : null;
  // Claude above the rest by 12+ while the published score sits below Claude's:
  // the majority branch pulled the score down, which is the BRO-6000 shape.
  const claudeLead = claude != null && othersMean != null ? Math.round((claude - othersMean) * 10) / 10 : null;
  const lead = danglingLead(file.fullText);
  const why = [];
  if (lead.danglingLead && score < 55) why.push('back-reference lead and a score under 55');
  if (claudeLead != null && claudeLead >= 12 && score < claude) why.push(`Claude ${claudeLead} above the other legs and the published score is below Claude's`);
  return {
    showId: file.showId,
    score,
    claude,
    others,
    claudeLead,
    danglingLead: lead.danglingLead,
    reasons: lead.reasons,
    suspect: why.length > 0,
    why,
  };
}

/**
 * Walk a review-texts folder and classify every split section that carries a
 * score. Files flagged duplicate / wrong show / wrong production / non-review
 * are skipped: they do not feed a published score.
 * @returns {{sections:number, rows:object[]}} rows hold every classified section (suspect or not)
 */
function scanReviewTexts(root) {
  const rows = [];
  let sections = 0;
  for (const dir of listShowDirs(root)) {
    const dirPath = path.join(root, dir);
    for (const f of fs.readdirSync(dirPath)) {
      if (!f.endsWith('.json') || !isReviewTextFile(f)) continue;
      let d;
      try { d = JSON.parse(fs.readFileSync(path.join(dirPath, f), 'utf8')); } catch { continue; }
      if (!d || typeof d !== 'object' || d.duplicateOf || d.wrongShow || d.wrongProduction || d.isNonReview) continue;
      const c = classifySplitSection(d);
      if (!c) continue;
      sections++;
      rows.push({ file: `${dir}/${f}`, outlet: d.outletId, ...c, lead: firstSentence(d.fullText).slice(0, 200) });
    }
  }
  return { sections, rows };
}

module.exports = { classifySplitSection, danglingLead, firstSentence, scanReviewTexts };
