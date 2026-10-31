/**
 * Social card renderer, design D4 (owner's pick, 2026-10-25): poster, the site's
 * score badge sitting on its bottom edge, tier label, title, venue, breakdown bar.
 *
 * Built exactly like the site: the card is laid out at phone size (432x540 CSS px,
 * the site's own pixel values for badge, poster, type and bar) and scaled 2.5x with
 * CSS zoom to 1080x1350, Instagram's 4:5 feed size. SITE_CSS below is copied from
 * src/app/globals.css; social-autopost.test.mjs fails if the two drift.
 *
 * Quality rules (the reason this replaced the retired Twitter card generator):
 *   - the poster is never stretched past its native size (art.js checks it)
 *   - Inter is embedded from public/fonts, so text never falls back to a system font
 *   - text that does not fit after shrinking fails the render instead of being clipped
 */

const fs = require('fs');
const path = require('path');
const { MARKETS } = require('./config');

const ROOT = path.resolve(__dirname, '..', '..');
const W = 1080;
const H = 1350;
const ZOOM = 2.5;
const ROW_POSTER_W = 40; // roundup rows: poster width in CSS px before ZOOM
const COMPARE_POSTER_W = 152; // CSS px before ZOOM; the poster's output width is COMPARE_POSTER_W * ZOOM

// The site's badge classes, verbatim from src/app/globals.css (rule bodies only;
// the gold shimmer animation is left out because a post is a still image).
const SITE_CSS = {
  'score-must-see': 'background: linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%); color: #1a1a1a; box-shadow: 0 0 24px rgba(218, 165, 32, 0.55), 0 0 12px rgba(255, 215, 0, 0.4), 0 4px 12px rgba(0, 0, 0, 0.3), inset 0 2px 0 rgba(255, 255, 255, 0.3); position: relative; overflow: hidden; border: 2px solid #C8960E;',
  'score-great': 'background-color: #22c55e; color: white; box-shadow: 0 2px 8px rgba(34, 197, 94, 0.3);',
  'score-good': 'background-color: #14b8a6; color: white; box-shadow: 0 2px 8px rgba(20, 184, 166, 0.3);',
  'score-tepid': 'background-color: #d97706; color: #1a1a1a; box-shadow: 0 2px 8px rgba(217, 119, 6, 0.3);',
  'score-skip': 'background-color: #ef4444; color: white; box-shadow: 0 2px 8px rgba(239, 68, 68, 0.3);',
};

// score-tiers.js id -> site badge class (ScoreBadge.tsx TIER_COLOR_CLASS) and
// tier text colour (ScoreBadge.tsx SCORE_TIERS[].color).
const TIER = {
  'must-see': { cls: 'score-must-see', color: '#FFD700', crown: true },
  recommended: { cls: 'score-great', color: '#22c55e' },
  'worth-seeing': { cls: 'score-good', color: '#14b8a6' },
  skippable: { cls: 'score-tepid', color: '#d97706' },
  'stay-away': { cls: 'score-skip', color: '#ef4444' },
};

// ScoreBreakdownBar.tsx segment colours (tailwind score-* tokens).
const BREAKDOWN = [
  { key: 'rave', label: 'Rave', color: '#FFD700' },
  { key: 'positive', label: 'Positive', color: '#22c55e' },
  { key: 'mixed', label: 'Mixed', color: '#d97706' },
  { key: 'negative', label: 'Negative', color: '#ef4444' },
];

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const fileCache = new Map();
function dataUriFor(rel, mime) {
  if (!fileCache.has(rel)) fileCache.set(rel, `data:${mime};base64,${fs.readFileSync(path.join(ROOT, rel)).toString('base64')}`);
  return fileCache.get(rel);
}

function interFontCss() {
  const dir = path.join(ROOT, 'public', 'fonts');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const latin = files.find(f => /^Inter-latin-var\..*\.woff2$/.test(f));
  const ext = files.find(f => /^Inter-latin-ext-var\..*\.woff2$/.test(f));
  if (!latin) throw new Error('Inter font missing from public/fonts; refusing to render with a fallback font');
  const face = (f, range) => `@font-face{font-family:'InterCard';src:url(${dataUriFor(`public/fonts/${f}`, 'font/woff2')}) format('woff2');font-weight:100 900;font-display:block;${range ? `unicode-range:${range};` : ''}}`;
  return face(latin) + (ext ? face(ext, 'U+0100-024F,U+0259,U+1E00-1EFF,U+2020,U+20A0-20AB,U+20AD-20CF,U+2113,U+2C60-2C7F,U+A720-A7FF') : '');
}

/**
 * Build the card HTML. Pure apart from reading the font and logo files; exported for tests.
 * card: { market, title, venue, score, tierId, tierLabel, breakdown: {rave,positive,mixed,negative},
 *         poster: { dataUri } | null, label? (the line above the poster; default "The reviews are in") }
 */
function buildCardHtml(card) {
  const m = MARKETS[card.market] || MARKETS.broadway;
  const tier = TIER[card.tierId] || TIER['worth-seeing'];
  const logo = dataUriFor(`public/brand-kit/logos/${m.logo}`, 'image/png');
  const b = card.breakdown || {};
  const total = BREAKDOWN.reduce((n, x) => n + (b[x.key] || 0), 0) || 1;
  const segments = BREAKDOWN.filter(x => b[x.key] > 0)
    .map(x => `<div style="width:${(100 * b[x.key] / total).toFixed(3)}%;height:100%;background:${x.color}"></div>`).join('');
  // The site's legend lists only non-zero buckets (ScoreBreakdownBar.tsx).
  const shown = BREAKDOWN.filter(x => b[x.key] > 0);
  const legend = shown
    .map(x => `<span style="display:flex;align-items:center;gap:6px"><span style="width:8px;height:8px;border-radius:2px;background:${x.color}"></span><span style="color:#9ca3af">${b[x.key]} ${x.label}</span></span>`).join('');
  const crown = tier.crown
    ? '<svg style="position:absolute;left:50%;transform:translateX(-50%);top:-6px;z-index:10" width="15" height="7" viewBox="0 0 24 14" aria-hidden="true"><path d="M2,13 L5,5 L9,8 L12,1 L15,8 L19,5 L22,13 Z" fill="#FFD700" opacity="0.85"/></svg>'
    : '';
  const poster = card.poster && card.poster.dataUri
    ? `<img src="${card.poster.dataUri}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
    : `<div style="width:100%;height:100%;box-sizing:border-box;padding:20px 16px 52px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;background:#1a1a24">
         <span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:${m.brand}">${esc(m.label)}</span>
         <span data-fit data-max="30" data-min="16" data-lines="6" style="font-weight:800;letter-spacing:-.025em;line-height:1.1;color:#ffffff;width:100%">${esc(card.title)}</span>
       </div>`;

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${interFontCss()}
*{margin:0;padding:0}
html,body{width:${W}px;height:${H}px;background:#0f0f14;overflow:hidden}
body{font-family:'InterCard',sans-serif;color:#ffffff;-webkit-font-smoothing:antialiased}
${Object.entries(SITE_CSS).map(([k, v]) => `.${k}{${v}}`).join('\n')}
</style></head><body>
<div data-frame style="zoom:${ZOOM};width:432px;height:540px;box-sizing:border-box;padding:22px 24px 16px;display:flex;flex-direction:column;align-items:center;overflow:hidden">
  <img src="${logo}" alt="${esc(m.label)} Scorecard" style="height:21px;width:auto;display:block">
  <span style="margin-top:6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:${m.brand}">${esc(card.label || 'The reviews are in')}</span>
  <div data-poster style="margin-top:14px;width:184px;height:276px;flex-shrink:0;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.1);box-shadow:0 25px 50px -12px rgba(0,0,0,.25)">${poster}</div>
  <div style="margin-top:-40px;position:relative;z-index:2">${crown}
    <div class="${tier.cls}" style="width:80px;height:80px;box-sizing:border-box;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:30px;line-height:36px;font-weight:700">${esc(card.score)}</div>
  </div>
  <span style="margin-top:10px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:${tier.color}">${esc(card.tierLabel)}</span>
  <h1 data-fit data-max="24" data-min="16" data-lines="2" style="margin-top:6px;width:100%;line-height:1.25;font-weight:800;letter-spacing:-.025em;text-align:center">${esc(card.title)}</h1>
  <p data-fit data-max="14" data-min="12" data-lines="1" style="margin-top:2px;width:100%;line-height:20px;color:#d1d5db;text-align:center">${esc(card.venue || '')}</p>
  <div style="margin-top:12px;width:300px;display:flex;flex-direction:column;gap:8px">
    <div style="height:8px;border-radius:9999px;overflow:hidden;display:flex;background:#2a2a38">${segments}</div>
    <div style="display:flex;align-items:center;justify-content:${shown.length > 1 ? 'space-between' : 'center'};font-size:12px;white-space:nowrap">${legend}</div>
  </div>
</div>
</body></html>`;
}

// Runs in the page: shrink each [data-fit] box until it fits its width and line
// budget (lines counted from the text's line boxes), shrink the poster if a long
// title needs the room, then check nothing spills out of the 432x540 frame.
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
    while ((tooWide() || lineCount() > lines) && size > min) { size -= 1; el.style.fontSize = size + 'px'; }
    if (tooWide()) bad.push({ text: el.textContent.trim().slice(0, 60), reason: 'width', size });
    else if (lineCount() > lines) bad.push({ text: el.textContent.trim().slice(0, 60), reason: 'lines', size });
  }
  const frame = document.querySelector('[data-frame]');
  // A two-line title needs ~30px more: shrink the poster(s) (keeping 2:3), not the type.
  const posters = [...document.querySelectorAll('[data-poster]')];
  const start = posters.length ? +(posters[0].dataset.w || 184) : 0;
  let pw = start;
  while (posters.length && frame.scrollHeight > frame.clientHeight + 1 && pw > start - 36) {
    pw -= 4;
    for (const poster of posters) { poster.style.width = pw + 'px'; poster.style.height = Math.round(pw * 1.5) + 'px'; }
  }
  if (frame.scrollHeight > frame.clientHeight + 1) bad.push({ reason: 'frame overflow', scrollHeight: frame.scrollHeight, clientHeight: frame.clientHeight });
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

/** Render card HTML to a 1080x1350 PNG. Throws if any text still overflows after fitting. */
async function renderHtml(html, outPath) {
  const browser = await getBrowser();
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  try {
    await page.setContent(html, { waitUntil: 'load' });
    await page.evaluate(() => document.fonts.ready);
    const fontOk = await page.evaluate(() => document.fonts.check("800 40px 'InterCard'"));
    if (!fontOk) throw new Error('Inter did not load in the card page');
    const overflow = await page.evaluate(FIT_SCRIPT);
    if (overflow.length) throw new Error(`card text overflows: ${JSON.stringify(overflow)}`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    await page.screenshot({ path: outPath, type: 'png', clip: { x: 0, y: 0, width: W, height: H } });
    return { path: outPath, width: W, height: H };
  } finally {
    await page.close();
  }
}

/** Render a score card (design D4). */
async function renderCard(card, outPath) {
  return renderHtml(buildCardHtml(card), outPath);
}

/**
 * Compare card (BRO-6368): one title, two productions side by side, oldest on the
 * left, each with its poster, the site's badge for its own market, its label
 * ("London 2024") and review count. Same frame, fonts, badge classes and fitting
 * as the score card.
 * card: { title, market (wordmark: the newer production's market), delta,
 *         sides: [{ market, label, score, tierId, reviewCount, soFar, poster: {dataUri} | null }, ...] }
 */
function buildCompareHtml(card) {
  const m = MARKETS[card.market] || MARKETS.broadway;
  const logo = dataUriFor(`public/brand-kit/logos/${m.logo}`, 'image/png');
  const side = s => {
    const sm = MARKETS[s.market] || MARKETS.broadway;
    const tier = TIER[s.tierId] || TIER['worth-seeing'];
    const crown = tier.crown
      ? '<svg style="position:absolute;left:50%;transform:translateX(-50%);top:-7px;z-index:10" width="17" height="8" viewBox="0 0 24 14" aria-hidden="true"><path d="M2,13 L5,5 L9,8 L12,1 L15,8 L19,5 L22,13 Z" fill="#FFD700" opacity="0.85"/></svg>'
      : '';
    const poster = s.poster && s.poster.dataUri
      ? `<img src="${s.poster.dataUri}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
      : `<div style="width:100%;height:100%;box-sizing:border-box;padding:16px 12px 40px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;text-align:center;background:#1a1a24">
           <span data-fit data-max="22" data-min="12" data-lines="6" style="font-weight:800;letter-spacing:-.025em;line-height:1.1;color:#ffffff;width:100%">${esc(card.title)}</span>
         </div>`;
    return `<div style="width:156px;display:flex;flex-direction:column;align-items:center">
      <div data-poster data-w="${COMPARE_POSTER_W}" style="width:${COMPARE_POSTER_W}px;height:${COMPARE_POSTER_W * 1.5}px;flex-shrink:0;border-radius:12px;overflow:hidden;border:1px solid rgba(255,255,255,.1);box-shadow:0 25px 50px -12px rgba(0,0,0,.25)">${poster}</div>
      <div style="margin-top:-34px;position:relative;z-index:2">${crown}
        <div class="${tier.cls}" style="width:64px;height:64px;box-sizing:border-box;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:26px;line-height:32px;font-weight:700">${esc(s.score)}</div>
      </div>
      <span data-fit data-max="13" data-min="10" data-lines="1" style="margin-top:9px;width:100%;text-align:center;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.1em;color:${sm.brand}">${esc(s.label)}</span>
      <span style="margin-top:3px;font-size:12px;color:#9ca3af;white-space:nowrap">${esc(s.reviewCount)} critics${s.soFar ? ' so far' : ''}</span>
    </div>`;
  };
  const delta = Number.isFinite(card.delta)
    ? (card.delta === 0 ? 'The same score in both cities' : `${card.delta} point${card.delta === 1 ? '' : 's'} apart`)
    : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
${interFontCss()}
*{margin:0;padding:0}
html,body{width:${W}px;height:${H}px;background:#0f0f14;overflow:hidden}
body{font-family:'InterCard',sans-serif;color:#ffffff;-webkit-font-smoothing:antialiased}
${Object.entries(SITE_CSS).map(([k, v]) => `.${k}{${v}}`).join('\n')}
</style></head><body>
<div data-frame style="zoom:${ZOOM};width:432px;height:540px;box-sizing:border-box;padding:22px 24px;display:flex;flex-direction:column;align-items:center;justify-content:center;overflow:hidden">
  <img src="${logo}" alt="${esc(m.label)} Scorecard" style="height:21px;width:auto;display:block">
  <span style="margin-top:6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:${m.brand}">Reviewed in two cities</span>
  <h1 data-fit data-max="24" data-min="16" data-lines="2" style="margin-top:8px;width:100%;line-height:1.25;font-weight:800;letter-spacing:-.025em;text-align:center">${esc(card.title)}</h1>
  <div style="margin-top:14px;display:flex;gap:28px;justify-content:center">${card.sides.map(side).join('')}</div>
  ${delta ? `<span style="margin-top:12px;font-size:13px;font-weight:600;color:#d1d5db">${esc(delta)}</span>` : ''}
</div>
</body></html>`;
}

/** Render a compare card to a 1080x1350 PNG. */
async function renderCompareCard(card, outPath) {
  return renderHtml(buildCompareHtml(card), outPath);
}

/**
 * Weekly roundup card (BRO-6413): one row per opening, best score first, each with its
 * poster, title, venue and the site's badge. At most MAX_ROWS rows. Same frame, fonts,
 * badge classes and fitting as the score card.
 * card: { market (wordmark), range ("Oct 22 to Oct 28"), rows: [{ title, venue, score, tierId, poster: {dataUri} }] }
 */
const MAX_ROWS = 6;
function buildRoundupHtml(card) {
  if (!card.rows.length || card.rows.length > MAX_ROWS) throw new Error(`roundup card takes 1 to ${MAX_ROWS} rows, got ${card.rows.length}`);
  const m = MARKETS[card.market] || MARKETS.broadway;
  const logo = dataUriFor(`public/brand-kit/logos/${m.logo}`, 'image/png');
  const row = r => {
    const tier = TIER[r.tierId] || TIER['worth-seeing'];
    const poster = r.poster && r.poster.dataUri
      ? `<img src="${r.poster.dataUri}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`
      : '';
    return `<div data-row style="height:${ROW_POSTER_W * 1.5 + 6}px;box-sizing:border-box;padding:3px 10px 3px 3px;display:flex;align-items:center;gap:10px;border-radius:12px;background:#171720;border:1px solid rgba(255,255,255,.08)">
      <div style="width:${ROW_POSTER_W}px;height:${ROW_POSTER_W * 1.5}px;flex-shrink:0;border-radius:8px;overflow:hidden;background:#1a1a24">${poster}</div>
      <div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px">
        <span data-fit data-max="15" data-min="11" data-lines="2" style="line-height:1.2;font-weight:800;letter-spacing:-.02em;width:100%">${esc(r.title)}</span>
        <span data-fit data-max="11" data-min="10" data-lines="1" style="width:100%;line-height:14px;color:#9ca3af">${esc(r.venue || '')}</span>
      </div>
      <div class="${tier.cls}" style="width:44px;height:44px;flex-shrink:0;box-sizing:border-box;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:19px;line-height:24px;font-weight:700">${esc(r.score)}</div>
    </div>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${interFontCss()}
*{margin:0;padding:0}
html,body{width:${W}px;height:${H}px;background:#0f0f14;overflow:hidden}
body{font-family:'InterCard',sans-serif;color:#ffffff;-webkit-font-smoothing:antialiased}
${Object.entries(SITE_CSS).map(([k, v]) => `.${k}{${v}}`).join('\n')}
</style></head><body>
<div data-frame style="zoom:${ZOOM};width:432px;height:540px;box-sizing:border-box;padding:22px 24px 16px;display:flex;flex-direction:column;align-items:center;overflow:hidden">
  <img src="${logo}" alt="${esc(m.label)} Scorecard" style="height:21px;width:auto;display:block">
  <span style="margin-top:6px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:${m.brand}">New openings</span>
  <span style="margin-top:2px;font-size:12px;color:#9ca3af">${esc(card.range)}</span>
  <div style="margin-top:12px;width:100%;flex:1;display:flex;flex-direction:column;justify-content:center;gap:6px">${card.rows.map(row).join('')}</div>
</div>
</body></html>`;
}

/** Render a roundup card to a 1080x1350 PNG. */
async function renderRoundupCard(card, outPath) {
  return renderHtml(buildRoundupHtml(card), outPath);
}

module.exports = { buildCardHtml, buildCompareHtml, buildRoundupHtml, renderCard, renderCompareCard, renderRoundupCard, closeBrowser, SITE_CSS, TIER, W, H, MAX_ROWS, COMPARE_POSTER_PX: COMPARE_POSTER_W * ZOOM, ROW_POSTER_PX: ROW_POSTER_W * ZOOM };
