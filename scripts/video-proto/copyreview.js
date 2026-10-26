#!/usr/bin/env node
// Two-model copy check for a video plan (BRO-6250). GPT and Gemini each read the voiceover script and the caption
// and say whether it sounds like a person wrote it. A rewrite either one suggests is applied only when it keeps
// every number, label, grade, outlet, quote and timing phrase; then both review again. render.js refuses a plan
// whose current wording has not passed, so failed copy never reaches a video.
// usage: node copyreview.js <plan.json>   (exit 0 = pass, 1 = blocked)
const fs = require('fs'), crypto = require('crypto');

// covers everything render reads from the plan, so nothing can change after review (a tamper check, not a signature)
const reviewHash = P => { const { review, ...rest } = P; return crypto.createHash('sha1').update(JSON.stringify(rest)).digest('hex').slice(0, 12); };

// AI tells we never ship, from the owner's external-copy rules
const BANNED = [[/[—–]/, 'em or en dash'], [/\bnot (just|only)\b[^.]*\bbut\b/i, '"not just X but Y"'], [/\bit'?s not\b[^.]*,\s*it'?s\b/i, '"it\'s not X, it\'s Y"'],
  [/\b(delve|robust|leverage|unlock|tapestry|realm|deep dive|landscape of|journey of|navigate the)\b/i, 'AI vocabulary'],
  [/(^|\. )(Moreover|Furthermore|Additionally)\b/, 'filler opener'], [/\b(truly|genuinely|worth noting|serves as)\b/i, 'hollow phrase'],
  [/\bThe \w+\? (A|An|Devastating)\b/, 'dramatic fragment']];
const lint = t => BANNED.filter(([re]) => re.test(t)).map(([, why]) => why);

// everything a rewrite must keep word for word: voice tags, plus the plan's own list of facts and timing phrases
function mustKeep(P, field = 'prompt') {
  const keep = field === 'prompt' ? (P.prompt.match(/\[[a-z ]+\]/g) || []) : [];
  return [...new Set([...keep, ...((P.keep && P.keep[field]) || [])])];
}
const NUM = /\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|\d+|[A-F](-plus|-minus|\+|-)?)(?![\w+])/gi;
// numbers and grades in the order they are said; a swap changes the sequence
const nums = t => (t.match(NUM) || []).map(x => x.toLowerCase()).filter(x => !/^[a-f]$/.test(x)).join(' ');
const low = s => ' ' + s.toLowerCase().replace(/[\u2019']/g, '').replace(/[^a-z0-9+\- ]/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
// first phrase in `keep` that is missing from `text`, or said out of order (render listens forward only)
function outOfOrder(text, keep, ordered) {
  const t = low(text); let at = 0;
  for (const k of keep) { const i = t.indexOf(low(k), ordered ? at : 0); if (i < 0) return (t.includes(low(k)) ? 'out of order: ' : 'dropped: ') + k; if (ordered) at = i + low(k).length - 1; }
  return null;
}
function keepsFacts(P, field, text, orig = P[field]) {
  if (!text || typeof text !== 'string') return 'empty';
  if (nums(text) !== nums(orig)) return `numbers changed (${nums(orig)} vs ${nums(text)})`;
  const facts = (P.keep && P.keep[field]) || [], tags = mustKeep(P, field).filter(k => !facts.includes(k));
  const miss = outOfOrder(text, tags, false) || outOfOrder(text, facts, field === 'prompt'); if (miss) return miss;
  if (field === 'caption') { const tags = orig.split('\n\n').slice(1).join('\n\n'); if (tags && !text.endsWith(tags)) return 'hashtags changed'; if (!text.includes('broadwayscorecard.com')) return 'dropped the site'; }
  const bad = lint(text); return bad.length ? 'has ' + bad.join(', ') : null;
}

const RUBRIC = `You review short social video copy for Broadway Scorecard, a site that averages theater critics' reviews into one Critic Score.
You get a VOICEOVER script (read aloud by a text-to-speech voice in a 20 to 30 second vertical video; bracketed tags like [excited] are voice directions) and the post CAPTION.
These videos are lists on purpose (a tally of reviews, a countdown, three quotes), so a repeated list shape is the format and is fine. The sign-off pointing to Broadway Scorecard is required and is fine. So is the one-line pitch of what it does for the viewer (see the great shows, skip the duds): the owner wrote that line on purpose. These patterns are fixed and fine: "Number five: Show, eighty-six." in a countdown; "Outlet said, quote." before each critic quote; the score said on its own with a cheer ("Sixty-eight!"); score labels such as "Worth Seeing" or "Recommended", which are product names and capitalized on purpose.
Judge one thing: does it sound like a real person talking or writing, natural and warm, the way a theater fan would tell a friend? Fail it for: stiff or robotic phrasing, the same sentence shape over and over, filler, hype words, ad-speak, awkward lines that sound odd out loud, and AI tells (em dashes, "it's not X, it's Y", "not just X but Y", dramatic one-word questions, words like delve, robust, unlock, truly).
Facts are fixed and checked elsewhere: never question numbers, scores, grades, labels (like "Worth Seeing" or "Recommended"), outlet names or critic quotes.
Pass it unless a specific line would make a listener think a bot wrote it, or it has an AI tell. Small polish preferences are a pass. Every issue must quote the exact line it is about.
If it fails, give a rewrite of ONLY the field that needs it, changing only the lines you quoted and leaving every other word as it is. A rewrite must keep every number, score, grade, label, outlet name, quoted critic line and bracketed tag exactly, keep the same order of information, keep the same length or shorter, and keep these phrases word for word: %KEEP%. A caption rewrite must keep the hashtags line and "broadwayscorecard.com".
Say how bad it is: "major" if a viewer would likely notice it sounds machine-written or wrong, "minor" if it is a polish point.
Reply with JSON only: {"pass": true|false, "severity": "none"|"minor"|"major", "issues": ["short reason", ...], "rewrite_prompt": string|null, "rewrite_caption": string|null}`;

async function ask(model, P) {
  const text = RUBRIC.replace('%KEEP%', mustKeep(P).map(k => JSON.stringify(k)).join(', ')) + `\n\nVOICEOVER:\n${P.prompt}\n\nCAPTION:\n${P.caption || '(none)'}`;
  if (model === 'gpt') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: JSON.stringify({ model: process.env.REVIEW_GPT || 'gpt-5.4-mini', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: text }] }) });
    const j = await r.json(); if (j.error) throw new Error('gpt: ' + j.error.message); return JSON.parse(j.choices[0].message.content);
  }
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${process.env.REVIEW_GEMINI || 'gemini-2.5-flash'}:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.2 } }) });
  const j = await r.json(); if (j.error) throw new Error('gemini: ' + j.error.message); return JSON.parse(j.candidates[0].content.parts[0].text);
}

async function review(P, log = console.log) {
  for (let round = 1; round <= 2; round++) {
    const bad = lint(P.prompt + '\n' + (P.caption || ''));
    const verdicts = await Promise.all(['gpt', 'gemini'].map(async m => ({ m, ...(await ask(m, P)) })));
    verdicts.forEach(v => log(`  round ${round} ${v.m}: ${v.pass ? 'pass' : 'FAIL ' + (v.severity || '')}${v.issues && v.issues.length ? ' (' + v.issues.join('; ') + ')' : ''}`));
    // one model's polish note does not block; a major problem, or both models objecting, does
    const blocks = bad.length || verdicts.some(v => !v.pass && v.severity === 'major') || verdicts.every(v => !v.pass);
    if (!blocks) return { pass: true, notes: verdicts.flatMap(v => v.pass ? [] : (v.issues || []).map(i => v.m + ': ' + i)), of: reviewHash(P), rounds: round, by: verdicts.map(v => v.m), at: new Date().toISOString() };
    if (bad.length) log('  rule check: ' + bad.join(', '));
    if (round === 2) return { pass: false, of: reviewHash(P), issues: [...bad, ...verdicts.flatMap(v => v.pass ? [] : (v.issues || []).map(i => v.m + ': ' + i))] };
    let changed = false; const done = new Set();
    for (const v of verdicts.filter(v => !v.pass)) for (const field of ['prompt', 'caption']) { if (done.has(field)) continue;
      const t = v['rewrite_' + field]; if (!t || t === P[field]) continue;
      const why = keepsFacts(P, field, t);
      if (why) { log(`  ${v.m} ${field} rewrite rejected: ${why}`); continue; }
      log(`  applied ${v.m} ${field} rewrite`); P[field] = t; changed = true; done.add(field);
    }
    if (!changed && !bad.length) return { pass: false, of: reviewHash(P), issues: verdicts.flatMap(v => v.pass ? [] : (v.issues || []).map(i => v.m + ': ' + i)) };
  }
}

if (require.main === module) (async () => {
  const f = process.argv[2]; if (!f) throw new Error('usage: node copyreview.js <plan.json>');
  if (!process.env.OPENAI_API_KEY || !process.env.GEMINI_API_KEY) throw new Error('copy review needs OPENAI_API_KEY and GEMINI_API_KEY');
  const P = JSON.parse(fs.readFileSync(f, 'utf8'));
  P.review = await review(P);
  fs.writeFileSync(f, JSON.stringify(P, null, 1));
  console.log(P.review.pass ? 'PASS' : 'BLOCKED: ' + P.review.issues.join(' | '));
  console.log('VOICEOVER: ' + P.prompt + '\nCAPTION: ' + P.caption);
  process.exit(P.review.pass ? 0 : 1);
})().catch(e => { console.error(e.message); process.exit(1); });

module.exports = { review, reviewHash, lint, keepsFacts };
