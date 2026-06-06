#!/usr/bin/env node
/**
 * Eval suite for classify + score prompts.
 *
 * Runs both prompts against a labelled test set (known-bad, known-good) and
 * reports per-case outcome + aggregate accuracy. Used after prompt changes to
 * confirm false positives are caught and legit reviews still pass.
 *
 * Usage: node scripts/video-reviews/eval-prompts.js
 */

const fs = require('fs');
const path = require('path');
const { CLAUDE_SONNET } = require('../lib/models');

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
if (!ANTHROPIC_API_KEY) { console.error('Missing ANTHROPIC_API_KEY'); process.exit(1); }

const ROOT = path.join(__dirname, '../..');
const TRANSCRIPTS = path.join(ROOT, 'data/video-reviews-transcripts');

// Labelled corpus — each case documents what the correct answer is.
// EXPECTED_CLASSIFY: "review" = pass to scoring | "other"/"roundup"/"commentary" = reject at classify
// EXPECTED_SCORE: true = scoreable | false = should reject at scoring gate
// (Only runs SCORE eval if classify said "review".)
const CASES = [
  // Known-bad — must reject somewhere
  { show: 'wicked-2003', creator: 'broadwayben', label: 'movie-review', expectClass: ['other'], expectScore: false, note: 'Wicked 2024 movie, not 2003 stage show' },
  { show: 'wicked-2003', creator: 'mickeyjotheatre', label: 'movie-review', expectClass: ['other'], expectScore: false, note: 'Wicked 2024 movie' },
  { show: 'wicked-2003', creator: 'theatreislife', label: 'movie-review', expectClass: ['other'], expectScore: false, note: 'Wicked 2024 movie' },
  // cabaret-2024/broadwayben — select-best-reviews picked a different video than
  // the original Eva Noblezada casting announcement Ben flagged. Current transcript
  // is a legit first-hand Eddie Redmayne MC critique. Re-labelled as known-good.
  { show: 'cabaret-2024', creator: 'broadwayben', label: 'legit-review', expectClass: ['review'], expectScore: true, note: 'Eddie Redmayne MC discourse (attended)' },
  { show: 'moulin-rouge-2019', creator: 'broadwayben', label: 'reply-to-comments', expectClass: ['other'], expectScore: false, note: 'Reply to Megan Thee Stallion haters' },
  { show: 'every-brilliant-thing-off-broadway-2026', creator: 'theatreislife', label: 'roundup', expectClass: ['roundup', 'other'], expectScore: false, note: 'Fringe roundup list' },

  // Known-good — must accept
  { show: 'beaches-2026', creator: 'ashleyhufford', label: 'legit-review', expectClass: ['review'], expectScore: true },
  { show: 'becky-shaw-2026', creator: 'ashleyhufford', label: 'legit-review', expectClass: ['review'], expectScore: true },
  { show: 'burnout-paradise-off-broadway-2026', creator: 'broadwayben', label: 'legit-review', expectClass: ['review'], expectScore: true },
  { show: 'masquerade-off-broadway-2025', creator: 'tyvid5', label: 'legit-review', expectClass: ['review'], expectScore: true },
  { show: 'cats-the-jellicle-ball-2026', creator: 'theatreislife', label: 'legit-review', expectClass: ['review'], expectScore: true },
  { show: 'the-outsiders-2024', creator: 'tylernabinger', label: 'legit-review', expectClass: ['review'], expectScore: true },
  // maybe-happy-ending/broadwaybob — select-best-reviews picked a different
  // video from the same creator (attended the Belasco Theater). Transcript opens
  // "I'm in New York for my birthday weekend... last night by seeing the show".
  { show: 'maybe-happy-ending-2024', creator: 'broadwaybob', label: 'legit-review', expectClass: ['review'], expectScore: true, note: 'Bob attended at Belasco' },
  { show: 'stereophonic-2024', creator: 'tylernabinger', label: 'legit-review', expectClass: ['review'], expectScore: true },
];

// Read prompts from the real scripts so the eval tracks whatever's there.
const CLASSIFY_SRC = fs.readFileSync(path.join(__dirname, 'classify-reviews.js'), 'utf8');
const SCORE_SRC = fs.readFileSync(path.join(__dirname, 'score-video-reviews.js'), 'utf8');

const CLASSIFY_PROMPT_MATCH = CLASSIFY_SRC.match(/content:\s*`([\s\S]+?)`\s*\n?\s*}]/);
if (!CLASSIFY_PROMPT_MATCH) { console.error('Could not extract classify prompt'); process.exit(1); }
const CLASSIFY_PROMPT_TEMPLATE = CLASSIFY_PROMPT_MATCH[1];

const SCORE_PROMPT_MATCH = SCORE_SRC.match(/const PROMPT = `([\s\S]+?)`;/);
if (!SCORE_PROMPT_MATCH) { console.error('Could not extract score prompt'); process.exit(1); }
const SCORE_PROMPT = SCORE_PROMPT_MATCH[1];

function getShowList() {
  const shows = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows;
  const cutoff = new Date('2023-06-01');
  return shows
    .filter(s => {
      if (!s?.title || s.id.includes('west-end')) return false;
      if (s.status === 'open' || s.status === 'previews') return true;
      if (s.status === 'closed' && s.openingDate && new Date(s.openingDate) >= cutoff) return true;
      return false;
    })
    .map(s => `${s.title} (${s.id})`).join(', ');
}

const CLASSIFY_MODEL = process.env.CLASSIFY_MODEL || CLAUDE_SONNET;
const SCORE_MODEL = process.env.SCORE_MODEL || CLAUDE_SONNET;

async function callClaude(prompt, model) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] })
  });
  if (!resp.ok) throw new Error(`API ${resp.status}: ${(await resp.text()).substring(0, 200)}`);
  const data = await resp.json();
  return data.content[0].text;
}

async function classifyOne(transcript, showList) {
  const item = `[1] Creator: ${transcript.creatorId} | Title: "${transcript.title || ''}" | ${transcript.wordCount}w\nTranscript (first 400 chars): ${(transcript.transcript || '').substring(0, 400)}`;
  const prompt = CLASSIFY_PROMPT_TEMPLATE
    .replace('${showNames}', showList)
    .replace('${items}', item);
  const text = await callClaude(prompt, CLASSIFY_MODEL);
  // Find the outermost JSON array. Walk to first '[' followed (after optional
  // whitespace) by '{'. Tolerates markdown fences and stray "[foo]" tokens.
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '[') continue;
    let j = i + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] === '{') { start = i; break; }
  }
  if (start === -1) throw new Error('No JSON array in classify response: ' + text.substring(0, 200));
  // Walk forward tracking bracket depth to find the matching close.
  let depth = 0, inStr = false, esc = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (c === '\\') { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
  }
  if (end === -1) throw new Error('Unclosed JSON in classify response');
  return JSON.parse(text.substring(start, end))[0];
}

async function scoreOne(transcript, showTitle, creatorName) {
  const user = `Score this video review of "${showTitle}" by ${creatorName} (${transcript.platform}):\n\n---\n${transcript.transcript}\n---`;
  const text = await callClaude(SCORE_PROMPT + '\n\n' + user, SCORE_MODEL);
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('No JSON in score response');
  return JSON.parse(jsonMatch[0]);
}

async function main() {
  console.log(`Classify model: ${CLASSIFY_MODEL}`);
  console.log(`Score model:    ${SCORE_MODEL}\n`);
  const showList = getShowList();
  const results = [];

  for (const c of CASES) {
    const file = path.join(TRANSCRIPTS, c.show, c.creator + '.json');
    if (!fs.existsSync(file)) {
      console.log(`  SKIP ${c.show}/${c.creator}: file missing`);
      continue;
    }
    const transcript = JSON.parse(fs.readFileSync(file, 'utf8'));
    const showRow = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')).shows.find(s => s.id === c.show);
    const showTitle = showRow?.title || c.show;

    process.stdout.write(`  [${c.label}] ${c.show}/${c.creator} ... `);

    try {
      const cls = await classifyOne(transcript, showList);
      let classifyPass = c.expectClass.includes(cls.type);
      let scoreResult = null;
      let scorePass = true;

      // Only run score if classify said review (matches pipeline flow)
      if (cls.type === 'review' && cls.showId) {
        scoreResult = await scoreOne(transcript, showTitle, c.creator);
        scorePass = scoreResult.scoreable === c.expectScore;
      } else {
        // classify rejected; if expected to reject, pass
        scorePass = c.expectScore === false;
      }

      const overallPass = (classifyPass && scorePass) || (!c.expectScore && cls.type !== 'review');
      console.log(overallPass ? 'PASS' : 'FAIL', `(class=${cls.type}${scoreResult ? ', score=' + scoreResult.scoreable : ''})`);
      results.push({ ...c, classify: cls, score: scoreResult, pass: overallPass });
    } catch (e) {
      console.log('ERROR', e.message);
      results.push({ ...c, error: e.message, pass: false });
    }
  }

  console.log('\n=== Summary ===');
  const bad = results.filter(r => r.label !== 'legit-review');
  const good = results.filter(r => r.label === 'legit-review');
  const badPass = bad.filter(r => r.pass).length;
  const goodPass = good.filter(r => r.pass).length;
  console.log(`Known-bad correctly rejected: ${badPass}/${bad.length}`);
  console.log(`Known-good correctly accepted: ${goodPass}/${good.length}`);

  const failures = results.filter(r => !r.pass);
  if (failures.length) {
    console.log('\n=== FAILURES ===');
    for (const f of failures) {
      console.log(`  ${f.label} ${f.show}/${f.creator}:`);
      console.log(`    expected class in ${JSON.stringify(f.expectClass)}, got: ${f.classify?.type || 'error'}`);
      console.log(`    expected scoreable=${f.expectScore}, got: ${f.score?.scoreable ?? 'not-scored'}`);
      if (f.classify?.reason) console.log(`    classify reason: ${f.classify.reason}`);
      if (f.score?.rejection) console.log(`    score rejection: ${f.score.rejection}`);
      if (f.error) console.log(`    error: ${f.error}`);
    }
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
