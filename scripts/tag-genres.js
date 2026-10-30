#!/usr/bin/env node
/**
 * Genre tagger for the app's quiz onboarding (BRO-6579).
 *
 * Writes src/config/genre-tags.json ({ [showId]: string[] }), which
 * generate-mobile-data.js reads into `gn`. Genres live here (tracked source),
 * NOT in the derived mobile-shows.json, which is regenerated every ~30 min.
 *
 * Rules first (existing `tg` tags), then an LLM pass over shows that have a
 * synopsis. Only open/previews/upcoming shows are tagged unless --all.
 *
 *   node scripts/tag-genres.js --dry           # coverage only
 *   node scripts/tag-genres.js --limit=40      # LLM pass for 40 shows
 *   node scripts/tag-genres.js --all           # include closed shows
 */
const fs = require('fs');
const path = require('path');

const GENRES = ['comedy', 'drama', 'thriller', 'romance', 'classic-musical', 'jukebox', 'family', 'concert', 'opera', 'dance'];
const OUT = path.join(__dirname, '..', 'src', 'config', 'genre-tags.json');
const MOBILE = path.join(__dirname, '..', 'public', 'data', 'mobile-shows.json');

const RULES = {
  comedy: ['comedy', 'farce'],
  drama: ['drama'],
  thriller: ['thriller', 'horror'],
  romance: ['romantic'],
  'classic-musical': ['classic'],
  jukebox: ['jukebox', 'pop', 'rock', 'hip-hop'],
  family: ['family', 'disney'],
  dance: ['dance'],
};

function ruleGenres(show) {
  const tags = new Set((show.tg || []).map(t => String(t).toLowerCase()));
  const out = [];
  for (const [g, from] of Object.entries(RULES)) if (from.some(t => tags.has(t))) out.push(g);
  return out.filter(g => g !== 'classic-musical' || show.ty === 'musical');
}

async function llm(batch) {
  const prompt = `Tag each Broadway/West End show with 1-3 genres from this fixed list: ${GENRES.join(', ')}.
classic-musical = golden-age or long-established book musicals; jukebox = musicals built from an existing pop/rock catalog or biographical band/artist songbook (NOT original scores in a pop style); concert = concerts, one-person music events, cabaret; family = made for or suited to children (Disney, kids' stories); not merely popular.
Use only what the title and synopsis support. If nothing fits, return an empty list. Return JSON: {"<id>": ["genre", ...]} for every id.

${batch.map(s => `${s.id} | ${s.t} | ${s.ty || ''} | ${(s.syn || '').slice(0, 280)}`).join('\n')}`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: 'gpt-5.4-mini', response_format: { type: 'json_object' }, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return JSON.parse(j.choices[0].message.content);
}

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry');
  const all = args.includes('--all');
  const limit = Number((args.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || Infinity;
  const shows = JSON.parse(fs.readFileSync(MOBILE, 'utf8')).shows;
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
  const live = s => all || ['open', 'previews', 'upcoming'].includes(s.st);
  const pool = shows.filter(s => live(s) && s.syn);
  const untagged = pool.filter(s => !(s.id in existing));
  const todo = untagged.slice(0, limit);
  console.log(`live+synopsis: ${pool.length}, already tagged: ${pool.length - untagged.length}, this run: ${todo.length}`);
  if (dry) {
    const withRules = shows.filter(s => live(s) && ruleGenres(s).length).length;
    console.log(`rule-only coverage among live shows: ${withRules}/${shows.filter(live).length}`);
    return;
  }
  for (let i = 0; i < todo.length; i += 25) {
    const batch = todo.slice(i, i + 25);
    const got = await llm(batch);
    for (const s of batch) {
      const fromLlm = (got[s.id] || []).filter(g => GENRES.includes(g));
      existing[s.id] = [...new Set([...ruleGenres(s), ...fromLlm])].slice(0, 3);
    }
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(existing) + '\n'); // checkpoint
    console.log(`tagged ${Math.min(i + 25, todo.length)}/${todo.length}`);
  }
}
main().catch(e => { console.error(e); process.exit(1); });
