// Prototype (BRO-6250): fetch each show's key art and keep it only if it is a real, sharp poster.
// Owner rule 2026-10-26: never post without a poster image, so no typographic stand-ins and no upscaled thumbnails.
// First choice is the original square key art (data/image-sources.json thumbnail, Contentful params stripped);
// then scripts/social-autopost/art.js resolvePoster (original portrait poster, TodayTix, site copy).
// Either way the image must be at least MIN_POSTER_WIDTH wide and pass the Gemini vision check.
// Passing shows are recorded in art/verified.json; showdata.js refuses to render a show missing from it.
const fs = require('fs'), path = require('path');
const { resolvePoster, artVerdict, originalUrl, minPosterWidth, MIN_POSTER_WIDTH } = require('../social-autopost/art.js');
const { loadImageSources } = require('../lib/image-sources-store');
const ROOT = path.resolve(__dirname, '../..'), DIR = path.join(__dirname, 'art'), MANIFEST = path.join(DIR, 'verified.json');
const shows = (j => j.shows || j)(JSON.parse(fs.readFileSync(path.join(ROOT, 'data/shows.json'), 'utf8')));

async function checkArt(show, png) {
  const verify = require('../lib/verify-image');
  return artVerdict(await verify.verifyImage(png, show.title, {
    market: show.category, venue: show.venue, openingDate: show.openingDate,
    creatives: verify.creativesForVerify(show), mimeType: 'image/png',
  }));
}

async function squareArt(show, sources) {
  const url = originalUrl((sources[show.id] || {}).thumbnail);
  if (!url) return { reason: 'no square key art on file' };
  const res = await fetch(url, { headers: { 'User-Agent': 'BroadwayScorecard-video-proto/1.0' }, signal: AbortSignal.timeout(20000) }).catch(() => null);
  if (!res || !res.ok) return { reason: `square art not fetched (${res ? res.status : 'network'})` };
  const sharp = require('sharp'), buf = Buffer.from(await res.arrayBuffer());
  const m = await sharp(buf).metadata().catch(() => ({}));
  if (!(m.width >= MIN_POSTER_WIDTH) || Math.abs(m.width / m.height - 1) > 0.1) return { reason: `square art ${m.width}x${m.height} too small or not square` };
  const png = await sharp(buf).rotate().png().toBuffer();
  const v = await checkArt(show, png);
  if (!v.ok) return { reason: `square art not confirmed (${v.reason})` };
  return { png, width: m.width, height: m.height, source: url };
}

(async () => {
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  // --poster: portrait posters for a compare video, picked as the compare card picks them (Mezzanine art from the show's own city allowed)
  const POSTER = process.argv.includes('--poster'), sources = loadImageSources(), ids = process.argv.slice(2).filter(a => !a.startsWith('--'));
  if (!ids.length) throw new Error('usage: node fetch-art.js <show-id>...');
  fs.mkdirSync(DIR, { recursive: true });
  for (const id of ids) {
    const show = shows.find(s => s.id === id);
    if (!show) { console.log(id, 'UNKNOWN SHOW'); continue; }
    let got = POSTER ? {} : await squareArt(show, sources), why = got.reason || '';
    if (!got.png) {
      const r = await resolvePoster(show, POSTER ? { sources, shows, mezzanine: true, minWidth: minPosterWidth(380) } : { sources });
      got = r.poster ? { png: Buffer.from(r.dataUri.split(',')[1], 'base64'), width: r.width, height: r.height, source: r.source } : {};
      why += r.poster ? '' : ` | poster: ${r.reason}`;
    }
    if (got.png) {
      fs.writeFileSync(path.join(DIR, id + '.img'), got.png);
      manifest[id] = { source: got.source, width: got.width, height: got.height, checked: new Date().toISOString() };
      console.log(id, 'OK', `${got.width}x${got.height}`, got.source.slice(-60));
    } else {
      fs.rmSync(path.join(DIR, id + '.img'), { force: true });
      delete manifest[id];
      console.log(id, 'HELD: no usable poster.', why);
    }
  }
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 1) + '\n');
})();
