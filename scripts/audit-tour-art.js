#!/usr/bin/env node
/**
 * Picks the Seen-grid art for each touring title in the quiz onboarding (BRO-6914 item 4).
 *
 * Candidates per tour: the tour's own poster, then every Broadway / West End production of the
 * same title. Gemini vision flags market- or date-specific text ("ON BROADWAY", "final
 * performance", "now playing at...", anniversary badges). The first candidate that is clean wins;
 * a tour with no clean candidate is recorded as null so the quiz leaves it out rather than show
 * wrong art. Writes src/config/onboarding-tour-art.json ({ [tourId]: posterPath | null }).
 *
 *   node scripts/audit-tour-art.js [--dry] [--tour=ID] [--redo]
 */
const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');
if (hasHelpFlag(process.argv.slice(2))) { console.log('Usage: node scripts/audit-tour-art.js [--dry] [--tour=ID] [--redo]'); process.exit(0); }
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GEMINI_FLASH } = require('./lib/models');
const { foldDiacritics } = require('./lib/title-match');

const root = path.join(__dirname, '..');
const OUT = path.join(root, 'src', 'config', 'onboarding-tour-art.json');
const args = process.argv.slice(2);
const only = (args.find(a => a.startsWith('--tour=')) || '').split('=')[1];
const norm = t => foldDiacritics(String(t || '')).toLowerCase().replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, ' ').trim();
const rawShows = JSON.parse(fs.readFileSync(path.join(root, 'data', 'shows.json'), 'utf8'));
const all = rawShows.shows || rawShows;
const mobile = JSON.parse(fs.readFileSync(path.join(root, 'public', 'data', 'mobile-shows.json'), 'utf8')).shows;
const tours = all.filter(s => s.category === 'tour' && /-tour-\d{4}$/.test(s.id));
const prior = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : {};
const strip = p => (p || '').split('?')[0];

function candidates(tour) {
  const k = norm(tour.title);
  const list = [];
  if (tour.images && tour.images.poster) list.push({ src: tour.images.poster, who: tour.id });
  const prods = mobile.filter(s => norm(s.t) === k && s.img && s.img.po)
    .sort((a, b) => (a.cat === 'west-end' ? -1 : 0) - (b.cat === 'west-end' ? -1 : 0) || (a.od < b.od ? 1 : -1));
  for (const s of prods) list.push({ src: strip(s.img.po), who: s.id });
  const seen = new Set();
  return list.filter(c => !seen.has(c.src) && seen.add(c.src));
}

const PROMPT = `This is a theatre show poster used in a quiz that lists shows a person has seen on a US touring or local stage.
Reply JSON only: {"ok": boolean, "text": string[], "reason": string}.
ok=false if the art contains ANY of: the words "Broadway" or "On Broadway" or "West End" or "Now playing"; a venue/theatre name or address; a specific date, "final performance", "closing", "limited engagement", "last chance" or "now booking"; an anniversary/year badge (e.g. "15"); review pull-quotes or star ratings; ticket-selling calls to action. 
ok=true if it is clean key art: title logo, tagline-free art, or credits only. Also set ok=false if the image is blurred-padding around a smaller picture or is not a portrait poster.
"text" lists the readable words you saw besides the show title.`;

async function judge(model, file) {
  const buf = fs.readFileSync(file);
  for (let i = 0; i < 3; i++) {
    try {
      const r = await model.generateContent([PROMPT, { inlineData: { data: buf.toString('base64'), mimeType: /\.webp$/i.test(file) ? 'image/webp' : /\.png$/i.test(file) ? 'image/png' : 'image/jpeg' } }]);
      return JSON.parse(r.response.text().replace(/^```json\s*|```\s*$/g, ''));
    } catch (e) { if (i === 2) throw e; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
  }
}

async function main() {
  const model = new GoogleGenerativeAI(process.env.GEMINI_API_KEY).getGenerativeModel({ model: GEMINI_FLASH, generationConfig: { responseMimeType: 'application/json', thinkingConfig: { thinkingBudget: 0 } } });
  const out = { ...prior };
  const report = [];
  for (const t of tours) {
    if (only && t.id !== only) continue;
    if (!only && t.id in prior && !args.includes('--redo')) continue;
    const cands = candidates(t);
    let pick = null; const tried = [];
    for (const c of cands) {
      const file = path.join(root, 'public', c.src);
      if (!fs.existsSync(file)) continue;
      const v = await judge(model, file);
      tried.push(`${c.who}:${v.ok ? 'clean' : 'dirty'}(${(v.text || []).slice(0, 4).join('/')})`);
      if (v.ok) { pick = c.src; break; }
    }
    out[t.id] = pick;
    report.push(`${t.id} -> ${pick || 'NONE'} | ${tried.join('; ')}`);
    console.log(report[report.length - 1]);
    if (!args.includes('--dry')) fs.writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n'); // checkpoint
  }
}
main().catch(e => { console.error(e); process.exit(1); });
