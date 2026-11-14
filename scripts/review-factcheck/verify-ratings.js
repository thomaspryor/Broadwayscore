#!/usr/bin/env node
'use strict';
/**
 * BRO-5081 review fact-check, step 3b: find printed star ratings on the real
 * page. Stored texts (Theatre Record scans, archive extractions) often lose the
 * star glyphs, so a checker that only reads our text can miss them. For each
 * sampled review this fetches the review URL plus any page a checker cited for
 * its score and lists every rating expression with its surrounding words, and
 * whether the show's title sits next to it (multi-show columns such as the
 * Observer's "The week in theatre" print one rating per show).
 *
 * Usage: node scripts/review-factcheck/verify-ratings.js [--only=..]  -> $FACTCHECK_CACHE/ratings.json
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const args = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split('=')));
const CACHE = process.env.FACTCHECK_CACHE || path.join(os.tmpdir(), 'review-factcheck');
const ONLY = args.only ? new Set(args.only.split(',')) : null;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const curl = url => new Promise(res => execFile('curl', ['-sSL', '--max-time', '30', '-A', UA, '-w', '\n__HTTP__%{http_code}', url], { maxBuffer: 30 << 20, encoding: 'utf8' }, (e, out) => {
  const m = String(out || '').match(/\n__HTTP__(\d+)$/);
  res({ status: m ? Number(m[1]) : 0, html: m ? out.slice(0, m.index) : '' });
}));

/** Rating expressions in visible text and aria-labels, with context. Pure. */
function findRatings(html, title) {
  const aria = [...String(html).matchAll(/aria-label=["']([^"']*\b(\d(?:\.5)?)\s*(?:out of|\/)\s*(5|4)\b[^"']*)["']/gi)].map(m => ({ rating: `${m[2]}/${m[3]}`, context: m[1].slice(0, 120), via: 'aria' }));
  const text = String(html).replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ');
  const out = [...aria];
  for (const m of text.matchAll(/(★+(?:½|☆)*|\b\d(?:\.5)?\s*(?:out of|\/)\s*(?:5|4)\s*stars?\b|\b(?:one|two|three|four|five|\d)[- ]stars?\b)/gi)) {
    const ctx = text.slice(Math.max(0, m.index - 90), m.index + m[0].length + 30);
    out.push({ rating: m[0].trim(), context: ctx, via: 'text' });
  }
  const t = String(title || '').toLowerCase().replace(/^the\s+/, '').slice(0, 25);
  for (const r of out) r.nearTitle = !!t && r.context.toLowerCase().includes(t);
  return out;
}

async function main() {
  const sample = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/audit/review-factcheck/sample.json'), 'utf8')).sample.filter(s => !ONLY || ONLY.has(s.sampleId));
  const outPath = path.join(CACHE, 'ratings.json');
  const result = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : {};
  const queue = [...sample];
  await Promise.all(Array.from({ length: 6 }, async () => {
    while (queue.length) {
      const item = queue.shift();
      if (result[item.sampleId] && !ONLY) continue;
      const urls = new Set([item.url].filter(Boolean));
      for (const m of ['gemini', 'openai']) {
        const p = path.join(CACHE, 'checks', m, item.sampleId + '.json');
        if (!fs.existsSync(p)) continue;
        const sc = ((JSON.parse(fs.readFileSync(p, 'utf8')).parsed || {}).score) || {};
        if (/^https?:\/\//.test(sc.citation || '') && !/vertexaisearch/.test(sc.citation)) urls.add(sc.citation);
      }
      const pages = [];
      for (const u of urls) {
        const r = await curl(u);
        pages.push({ url: u, status: r.status, ratings: r.status === 200 ? findRatings(r.html, item.showTitle) : [] });
      }
      result[item.sampleId] = { pages };
      process.stderr.write(`${item.sampleId} ${pages.map(p => p.status + ':' + p.ratings.length).join(' ')}\n`);
    }
  }));
  fs.writeFileSync(outPath, JSON.stringify(result));
  console.log(JSON.stringify({ out: outPath, n: Object.keys(result).length }));
}
if (require.main === module) main();
module.exports = { findRatings };
