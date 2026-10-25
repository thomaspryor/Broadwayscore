/**
 * Social card renderer: 1080x1350 CSS (4:5, Instagram's tallest feed ratio and
 * fine on Facebook, Threads, Bluesky and X), screenshotted at 2x = 2160x2700 PNG.
 *
 * Quality rules (the reason this replaced scripts/social-image-generator.js):
 *   - artwork is never stretched past its native pixel size (art.js picks it)
 *   - Inter is embedded from public/fonts, so text never falls back to a system font
 *   - every [data-fit] text box shrinks until it fits; renderCard() throws if any
 *     box still overflows, so a clipped title is never posted
 */

const fs = require('fs');
const path = require('path');
const { MARKETS } = require('./config');

const ROOT = path.resolve(__dirname, '..', '..');
const W = 1080;
const H = 1350;
const SCALE = 2;

// Site badge palette (src/app/globals.css .score-*), keyed by score-tiers.js ids.
const TIER_STYLE = {
  'must-see': { bg: 'linear-gradient(135deg,#DAA520 0%,#FFD700 30%,#FFF0A0 50%,#FFD700 70%,#DAA520 100%)', fg: '#1a1a1a', text: '#FFD700', glow: 'rgba(255,215,0,0.45)' },
  recommended: { bg: '#22c55e', fg: '#ffffff', text: '#4ade80', glow: 'rgba(34,197,94,0.40)' },
  'worth-seeing': { bg: '#14b8a6', fg: '#ffffff', text: '#2dd4bf', glow: 'rgba(20,184,166,0.40)' },
  skippable: { bg: '#d97706', fg: '#1a1a1a', text: '#f59e0b', glow: 'rgba(217,119,6,0.40)' },
  'stay-away': { bg: '#ef4444', fg: '#ffffff', text: '#f87171', glow: 'rgba(239,68,68,0.40)' },
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let fontCss = null;
function interFontCss() {
  if (fontCss != null) return fontCss;
  const dir = path.join(ROOT, 'public', 'fonts');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const latin = files.find(f => /^Inter-latin-var\..*\.woff2$/.test(f));
  const ext = files.find(f => /^Inter-latin-ext-var\..*\.woff2$/.test(f));
  if (!latin) throw new Error('Inter font missing from public/fonts; refusing to render with a fallback font');
  const face = (f, range) => `@font-face{font-family:'InterCard';src:url(data:font/woff2;base64,${fs.readFileSync(path.join(dir, f)).toString('base64')}) format('woff2');font-weight:100 900;font-display:block;${range ? `unicode-range:${range};` : ''}}`;
  fontCss = face(latin) + (ext ? face(ext, 'U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF') : '');
  return fontCss;
}

function logoHtml(market) {
  const m = MARKETS[market] || MARKETS.broadway;
  const london = market === 'west-end' || market === 'off-west-end';
  const prefix = london ? 'West End' : 'Broadway';
  const grad = london ? 'linear-gradient(90deg,#f472b6,#ec4899)' : 'linear-gradient(90deg,#e8c39e,#d4a574,#c08a52)';
  return `<div class="logo"><span class="lp">${prefix}</span><span class="ls" style="background:${grad};-webkit-background-clip:text;background-clip:text;color:transparent">Scorecard</span><span class="ld">${esc(m.domain)}</span></div>`;
}

/**
 * Build the card HTML. Pure (no I/O beyond the cached font), exported for tests.
 * card: { event: 'score'|'opening', market, title, venue, score, tierId, tierLabel,
 *         reviewCount, kicker, art: { layout, dataUri, width, height } }
 */
function buildCardHtml(card) {
  const m = MARKETS[card.market] || MARKETS.broadway;
  const art = card.art || { layout: 'type' };
  const tier = TIER_STYLE[card.tierId] || TIER_STYLE['worth-seeing'];
  const isScore = card.event === 'score';
  const bandH = art.layout === 'keyart' ? H - W : 300;

  let stage = '';
  if (art.layout === 'keyart') {
    stage = `<img class="keyart" src="${art.dataUri}" alt="">`;
  } else if (art.layout === 'inset') {
    // Native size or smaller: scale = min(1, box/size). Never above 1.
    const boxW = 900, boxH = H - bandH - 300;
    const s = Math.min(1, boxW / art.width, boxH / art.height);
    const w = Math.round(art.width * s), h = Math.round(art.height * s);
    stage = `<div class="blur" style="background-image:url(${art.dataUri})"></div><div class="veil"></div>
      <img class="inset" src="${art.dataUri}" style="width:${w}px;height:${h}px;top:${Math.round((H - bandH - 240 - h) / 2) + 40}px" alt="">
      <div class="stagetitle" data-fit data-max="76" data-min="40" data-lines="2">${esc(card.title)}</div>`;
  } else {
    stage = `<div class="spot" style="background:radial-gradient(ellipse 70% 55% at 50% 30%, ${m.brand}55, transparent 70%),radial-gradient(ellipse 90% 60% at 50% 110%, ${tier.glow}, transparent 70%)"></div>
      <div class="typekicker" style="color:${m.brand}">${esc(m.label)}</div>
      <div class="typetitle" data-fit data-max="150" data-min="64" data-lines="4">${esc(card.title)}</div>
      <div class="typevenue">${esc(card.venue || '')}</div>`;
  }

  const kicker = esc(card.kicker || (isScore ? `Critic Score · ${m.label}` : `Opening Tonight · ${m.label}`));
  const badge = isScore
    ? `<div class="badge" style="background:${tier.bg};color:${tier.fg};box-shadow:0 0 40px ${tier.glow},0 10px 28px rgba(0,0,0,.5)">${esc(card.score)}</div>`
    : `<div class="curtain" style="border-color:${m.brand};color:${m.brand}"><div class="cday">${esc(card.dayLabel || 'Tonight')}</div><div class="cdate">${esc(card.dateLabel || '')}</div></div>`;
  const line3 = isScore
    ? `<span style="color:${tier.text}">${esc(card.tierLabel)}</span><span class="dot">·</span>${esc(card.reviewCount)} critics' reviews`
    : `${esc(card.venue || '')}`;
  const titleInBand = art.layout === 'keyart';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${interFontCss()}
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:${W}px;height:${H}px;background:#0f0f14;overflow:hidden}
body{font-family:'InterCard',sans-serif;color:#f5f5f7;-webkit-font-smoothing:antialiased;position:relative}
.keyart{position:absolute;left:0;top:0;width:${W}px;height:${W}px;object-fit:cover}
.blur{position:absolute;inset:-80px;background-size:cover;background-position:center;filter:blur(60px) saturate(1.2);transform:scale(1.1)}
.veil{position:absolute;inset:0;background:linear-gradient(180deg,rgba(15,15,20,.35),rgba(15,15,20,.75) 70%,#0f0f14)}
.inset{position:absolute;left:50%;transform:translateX(-50%);border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.6);object-fit:cover}
.stagetitle{position:absolute;left:70px;right:70px;bottom:${bandH + 40}px;text-align:center;font-weight:800;letter-spacing:-.02em;line-height:1.05;text-shadow:0 4px 24px rgba(0,0,0,.6)}
.spot{position:absolute;inset:0}
.typekicker{position:absolute;top:120px;left:0;right:0;text-align:center;font-weight:700;font-size:30px;letter-spacing:.32em;text-transform:uppercase}
.typetitle{position:absolute;top:200px;left:80px;right:80px;height:${H - bandH - 360}px;display:flex;align-items:center;justify-content:center;text-align:center;font-weight:900;letter-spacing:-.03em;line-height:1.0}
.typevenue{position:absolute;bottom:${bandH + 60}px;left:0;right:0;text-align:center;font-size:34px;color:#a1a1aa;font-weight:500}
.band{position:absolute;left:0;right:0;bottom:0;height:${bandH}px;background:#0f0f14;border-top:3px solid ${m.brand}}
.badge{position:absolute;left:48px;top:25px;width:220px;height:220px;border-radius:44px;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:132px;letter-spacing:-.04em;font-variant-numeric:tabular-nums}
.curtain{position:absolute;left:48px;top:25px;width:220px;height:220px;border-radius:44px;border:4px solid;background:#16161f;display:flex;flex-direction:column;align-items:center;justify-content:center}
.cday{font-weight:800;font-size:42px;letter-spacing:-.01em}
.cdate{font-weight:600;font-size:30px;color:#e4e4e7;margin-top:6px}
.txt{position:absolute;left:304px;right:44px;top:${titleInBand ? 30 : 44}px}
.kicker{font-weight:700;font-size:24px;letter-spacing:.22em;text-transform:uppercase;color:${m.brand};white-space:nowrap}
.btitle{margin-top:10px;font-weight:800;letter-spacing:-.02em;line-height:1.08;color:#fafafa}
.line3{margin-top:12px;font-weight:700;font-size:34px;color:#d4d4d8;white-space:nowrap}
.line3 .dot{color:#52525b;margin:0 14px}
.logo{position:absolute;left:304px;bottom:24px;display:flex;align-items:baseline;gap:8px;font-weight:800;font-size:30px;letter-spacing:-.01em}
.logo .lp{color:#fafafa}.logo .ld{margin-left:14px;font-weight:600;font-size:22px;color:#71717a;letter-spacing:0}
</style></head><body>
${stage}
<div class="band">
  ${badge}
  <div class="txt">
    <div class="kicker" data-fit data-max="24" data-min="18" data-lines="1">${kicker}</div>
    ${titleInBand ? `<div class="btitle" data-fit data-max="50" data-min="30" data-lines="1">${esc(card.title)}</div>` : ''}
    <div class="line3" data-fit data-max="34" data-min="22" data-lines="1">${line3}</div>
  </div>
  ${logoHtml(card.market)}
</div>
</body></html>`;
}

// Runs in the page: shrink each [data-fit] box until it fits its width and line budget.
// Lines are counted from the text range's line boxes, which works for flex and block boxes alike.
const FIT_SCRIPT = `(() => {
  const bad = [];
  for (const el of document.querySelectorAll('[data-fit]')) {
    const max = +el.dataset.max, min = +el.dataset.min, lines = +el.dataset.lines;
    if (lines === 1) el.style.whiteSpace = 'nowrap';
    const range = document.createRange();
    range.selectNodeContents(el);
    const lineCount = () => new Set([...range.getClientRects()].filter(r => r.width > 0).map(r => Math.round(r.top))).size;
    const tooWide = () => el.scrollWidth > el.clientWidth + 1;
    let size = max;
    el.style.fontSize = size + 'px';
    while ((tooWide() || lineCount() > lines) && size > min) { size -= 2; el.style.fontSize = size + 'px'; }
    if (tooWide()) bad.push({ text: el.textContent.slice(0, 60), reason: 'width', size });
    else if (lineCount() > lines) bad.push({ text: el.textContent.slice(0, 60), reason: 'lines', lines: lineCount(), size });
  }
  return bad;
})()`;

let browserPromise = null;
async function getBrowser() {
  // SOCIAL_CHROMIUM_PATH: a preinstalled Chromium when the pinned Playwright build is absent.
  if (!browserPromise) browserPromise = require('playwright').chromium.launch(process.env.SOCIAL_CHROMIUM_PATH ? { executablePath: process.env.SOCIAL_CHROMIUM_PATH } : {});
  return browserPromise;
}
async function closeBrowser() {
  if (browserPromise) { const b = await browserPromise; browserPromise = null; await b.close(); }
}

/** Render a card to PNG. Throws if any text box overflows after fitting. */
async function renderCard(card, outPath) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: SCALE });
  try {
    await page.setContent(buildCardHtml(card), { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const fontOk = await page.evaluate(() => document.fonts.check("800 40px 'InterCard'"));
    if (!fontOk) throw new Error('Inter did not load in the card page');
    const overflow = await page.evaluate(FIT_SCRIPT);
    if (overflow.length) throw new Error(`card text overflows: ${JSON.stringify(overflow)}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
    return { path: outPath, width: W * SCALE, height: H * SCALE };
  } finally {
    await page.close();
  }
}

module.exports = { buildCardHtml, renderCard, closeBrowser, TIER_STYLE, W, H, SCALE };
