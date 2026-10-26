// In-page helpers + compositions. Time-driven: update(t) sets every style from t, so frames are deterministic.
const W = 360, H = 640;
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const seg = (t, a, b) => clamp((t - a) / (b - a));
const eo = x => 1 - Math.pow(1 - x, 3);
const eob = x => { const c = 1.70158; return 1 + (c + 1) * Math.pow(x - 1, 3) + c * Math.pow(x - 1, 2); };
const lerp = (a, b, x) => a + (b - a) * x;
const $ = (cls, style = '', html = '', tag = 'div') => { const e = document.createElement(tag); e.className = cls; e.style.cssText = style; e.innerHTML = html; return e; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Tiers come from scripts/lib/score-tiers.js (injected by render.js as window.TIERS), never hand-written here.
const GOLD = window.TIERS.gold;
const TIER_CLASS = { 'must-see': 'score-must-see', 'recommended': 'score-great', 'worth-seeing': 'score-good', 'skippable': 'score-tepid', 'stay-away': 'score-skip' };
const TIER_COLOR = { 'must-see': '#FFD700', 'recommended': '#22c55e', 'worth-seeing': '#14b8a6', 'skippable': '#d97706', 'stay-away': '#ef4444' };
const tierId = s => window.TIERS.id[clamp(Math.round(s), 0, 100)];
const tierClass = s => TIER_CLASS[tierId(s)];
const tierLabel = s => window.TIERS.label[tierId(s)];
const tierColor = s => TIER_COLOR[tierId(s)];
const CROWN = '<svg width="15" height="7" viewBox="0 0 24 14"><path d="M2,13 L5,5 L9,8 L12,1 L15,8 L19,5 L22,13 Z" fill="#FFD700" opacity="0.85"/></svg>';
const logo = (size = 17) => `<span class="lockup" style="font-size:${size}px"><span style="color:#fafafa">Broadway</span> <span class="text-gradient">Scorecard</span></span>`;
// the "new" pill names the show's own market; an unknown market stops the render instead of defaulting to Broadway
const NEW_LABEL = { broadway: 'New on Broadway', 'off-broadway': 'New Off-Broadway', 'west-end': 'New in the West End', 'off-west-end': 'New Off-West End' };
const newLabel = cat => { if (!NEW_LABEL[cat]) throw new Error('no "new" label for market ' + cat); return NEW_LABEL[cat]; };
const pills = (show, isNew, cat) => `${isNew ? `<span class="pill pill-new">${newLabel(cat)}</span>` : '<span class="pill pill-open">Now playing</span>'}<span class="pill pill-${show.type === 'musical' ? 'musical' : 'play'}">${show.type === 'musical' ? 'Musical' : 'Play'}</span>`;

// Badge (ScoreBadge): value 0..score shown rounded; class follows the live value (gold only once it reaches 83).
function setBadge(wrap, v, { crown = true, size = 'lg' } = {}) {
  const r = Math.round(v);
  const b = wrap.querySelector('.score-badge'), cr = wrap.querySelector('.crown');
  b.className = `score-badge bw-${size} ${r <= 0 ? 'score-none' : tierClass(r)}`;
  b.textContent = r <= 0 ? '–' : r;
  if (cr) cr.style.display = crown && r >= GOLD ? 'block' : 'none';
}
const badgeEl = (size = 'lg', style = '') => { const w = $('', `position:relative;display:inline-block;${style}`); w.innerHTML = `<div class="crown" style="top:${size === 'lg' ? -6 : -4}px">${CROWN}</div><div class="score-badge bw-${size} score-none">–</div>`; return w; };

// Breakdown bar (ScoreBreakdownBar): tiers rave>=83, positive>=70, mixed>=55, negative<55; largest-remainder percentages.
const bTier = s => s >= GOLD ? 'rave' : s >= 70 ? 'positive' : s >= 55 ? 'mixed' : 'negative';
function pcts(c, total) {
  const tiers = ['rave', 'positive', 'mixed', 'negative'];
  const exact = tiers.map(t => c[t] / total * 100), fl = exact.map(Math.floor);
  let rem = 100 - fl.reduce((a, b) => a + b, 0);
  exact.map((v, i) => ({ f: v - Math.floor(v), i })).sort((a, b) => b.f - a.f || a.i - b.i).forEach(o => { if (rem > 0 && c[tiers[o.i]] > 0) { fl[o.i]++; rem--; } });
  return Object.fromEntries(tiers.map((t, i) => [t, fl[i]]));
}
const BAR_COL = { rave: 'linear-gradient(135deg,#DAA520,#FFD700 30%,#FFF0A0 50%,#FFD700 70%,#DAA520)', positive: '#22c55e', mixed: '#d97706', negative: '#ef4444' };
const BAR_LBL = { rave: 'Rave', positive: 'Positive', mixed: 'Mixed', negative: 'Negative' };
function barHtml(reviewScores, total = reviewScores.length, fromRight = false) {
  // While reviews are still landing, widths are shares of the final total, so the bar fills one segment at a time
  const c = { rave: 0, positive: 0, mixed: 0, negative: 0 }; let n = 0;
  reviewScores.forEach(s => { c[bTier(s)]++; n++; });
  if (!n) return `<div class="bar"></div><div class="legend"><span>&nbsp;</span></div>`;
  const p = n >= total ? pcts(c, n) : Object.fromEntries(Object.keys(c).map(t => [t, c[t] / total * 100])), T = ['rave', 'positive', 'mixed', 'negative'].filter(t => c[t] > 0);
  return `<div class="bar" style="${fromRight ? 'justify-content:flex-end' : ''}">${T.map(t => `<div style="width:${p[t]}%;background:${BAR_COL[t]}"></div>`).join('')}</div>
  <div class="legend">${T.map(t => `<span><i style="background:${t === 'rave' ? '#FFD700' : BAR_COL[t]}"></i>${c[t]} ${BAR_LBL[t]}</span>`).join('')}</div>`;
}
const fade = (el, o, y = 0) => { el.style.opacity = o; el.style.transform = `translateY(${y}px)`; };
const artImg = (uri, size, extra = '') => `<img src="${uri}" style="width:${size}px;height:${size}px;border-radius:1rem;object-fit:cover;display:block;${extra}">`;

const COMPS = {};
const plusDot = (x, y, txt) => $('abs', `left:${x}px;top:${y}px;width:36px;height:36px;border-radius:9999px;background:#2a2a38;border:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:center;font-size:${txt === '+' ? 20 : 12}px;font-weight:800;color:#d4a574;z-index:2`, txt);

/* ---------- A: score reveal ---------- */
COMPS.reveal = {
  dur: 22,
  beats: { count: 1.9, land: 4.55, quotesIn: 8.2, q: [8.5, 10.4, 12.3], vs: 15.0, aud: 16.3, gap: 18.1, end: 20 },
  build(root, d) {
    const s = d.show, sc = d.score, r = Math.round(sc);
    this.d = d;
    const g1 = this.g1 = $('abs', 'inset:0');
    g1.append($('abs card', 'left:105px;top:66px;width:150px;height:150px;padding:0;overflow:hidden;border-radius:1rem', artImg(d.art, 150, 'border-radius:0')));
    this.art = g1.firstChild;
    g1.append($('abs', 'left:0;right:0;top:226px;text-align:center;font-weight:800;font-size:22px;letter-spacing:-.02em', esc(s.title)));
    g1.append($('abs', 'left:0;right:0;top:258px;display:flex;gap:6px;justify-content:center', pills(s, d.isNew, d.category)));
    this.cap1 = $('abs cap', 'left:20px;right:20px;top:286px;font-size:14px;color:#d4d4d8', `${d.count} critics weighed in. One score.`);
    g1.append(this.cap1);
    this.bw = badgeEl('lg', 'position:absolute;left:140px;top:326px;transform-origin:50% 50%'); g1.append(this.bw);
    this.tl = $('abs', 'left:0;right:0;top:424px;text-align:center;font-weight:800;font-size:18px', ''); g1.append(this.tl);
    this.bc = $('abs card', 'left:24px;right:24px;top:452px;padding:10px 14px 8px', barHtml([])); g1.append(this.bc);
    const g2 = this.g2 = $('abs', 'inset:0');
    g2.append($('abs cap', 'left:0;right:0;top:76px;font-size:17px', 'What the critics said'));
    this.qc = d.quotes.map((q, i) => {
      const c = $('abs card', `left:20px;right:20px;top:${106 + i * 128}px;padding:12px 14px;height:118px`,
        `<div style="display:flex;align-items:center;gap:10px"><div style="flex:1;min-width:0"><div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#d4a574;white-space:nowrap">${esc(q.o)}</div><div style="font-size:12px;color:#9ca3af;margin-top:2px">${esc(q.cn)}</div></div><div class="score-badge bw-xs ${tierClass(q.s)}">${q.s}</div></div>
         <div style="font-size:13px;line-height:1.35;color:#e4e4e7;margin-top:8px;font-style:italic">&ldquo;${esc(q.q)}&rdquo;</div>`);
      g2.append(c); return c; });
    const g3 = this.g3 = $('abs', 'inset:0');
    g3.append($('abs cap', 'left:0;right:0;top:72px;font-size:17px', 'Critics + audience'));
    const mk = (x, label, val, sub) => { const c = $('abs card', `left:${x}px;width:150px;top:150px;height:220px;display:flex;flex-direction:column;align-items:center;padding-top:18px`, `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#d4a574">${label}</div>`); const w = badgeEl('lg', 'margin-top:36px'); c.append(w); c.append($('', 'margin-top:20px;font-size:12px;color:#9ca3af;text-align:center', sub)); c._w = w; c._v = val; return c; };
    this.ca = mk(20, 'Critics', sc, `${d.count} reviews`);
    // Audience is a letter grade (tile like BlendedTrioDisplay), never a number
    const ag = d.audienceGrade, aplus = ag.grade === 'A+';
    this.cb = $('abs card', 'left:190px;width:150px;top:150px;height:220px;display:flex;flex-direction:column;align-items:center;padding-top:18px',
      `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#d4a574">Audience</div>
       <div class="${aplus ? 'audience-top-grade' : ''}" style="margin-top:36px;width:80px;height:80px;border-radius:.75rem;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.3);${aplus ? '' : `background:${ag.color};color:${ag.textColor}`}">${ag.grade}</div>
       <div style="margin-top:20px;font-size:12px;color:#9ca3af;text-align:center">Audience grade</div>`);
    this.cb._grade = this.cb.children[1]; this.cb._w = null;
    g3.append(this.ca, this.cb, plusDot(162, 242, '+'));
    this.cap3 = $('abs cap', 'left:24px;right:24px;top:392px;font-size:17px;line-height:1.3', d.gapLine); g3.append(this.cap3);
    const g4 = this.g4 = $('abs', 'inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding-bottom:110px;text-align:center');
    g4.innerHTML = `<div>${logo(30)}</div><div style="margin-top:14px;font-size:17px;font-weight:600;color:#d4d4d8">Every review. One score.</div><div style="margin-top:22px;font-size:15px;font-weight:700;color:#d4a574">broadwayscorecard.com</div>`;
    root.append($('abs', 'left:0;right:0;top:34px;text-align:center;z-index:5', logo(14)), g1, g2, g3, g4);
    this.events = [];
    for (let i = 0; i < 16; i++) this.events.push({ t: 1.9 + i * 0.16, k: 'tick', p: i / 16 });
    this.events.push({ t: 4.55, k: r >= GOLD ? 'chime' : 'pop' });
    d.quotes.forEach((_, i) => this.events.push({ t: 8.9 + i * 1.9, k: 'pop' }));
    this.events.push({ t: 16.2, k: 'pop' }, { t: 17.2, k: 'pop' });
  },
  update(t) {
    const d = this.d, sc = d.score;
    this.g1.style.opacity = 1 - seg(t, 7.6, 8.1);
    this.g1.style.display = t > 8.2 ? 'none' : 'block';
    const a = eob(seg(t, 0.1, 0.9)); this.art.style.opacity = seg(t, 0.1, 0.6); this.art.style.transform = `scale(${lerp(0.85, 1, a)})`;
    fade(this.cap1, seg(t, 0.9, 1.5), (1 - seg(t, 0.9, 1.5)) * 8);
    const bt = seg(t, 1.9, 4.5), v = sc * eo(bt);
    this.bw.style.opacity = seg(t, 1.5, 1.9);
    setBadge(this.bw, bt === 0 ? 0 : v);
    const pop = t > 4.5 ? 1 + 0.22 * Math.sin(Math.PI * seg(t, 4.5, 5.0)) : 1; this.bw.style.transform = `scale(${1.3 * pop})`;
    const r = Math.round(sc); this.tl.innerHTML = `<span style="color:${tierColor(r)}">${tierLabel(r)}</span>`; fade(this.tl, seg(t, 4.6, 5.1), (1 - seg(t, 4.6, 5.1)) * 8);
    const k = Math.round(d.scores.length * eo(seg(t, 5.3, 6.9)));
    this.bc.innerHTML = barHtml(d.scores.slice(0, k), d.scores.length); fade(this.bc, seg(t, 5.2, 5.7), (1 - seg(t, 5.2, 5.7)) * 10);
    // quotes
    const g2in = seg(t, 8.2, 8.6), g2out = 1 - seg(t, 14.4, 14.9);
    this.g2.style.opacity = Math.min(g2in, g2out); this.g2.style.display = (t < 8.1 || t > 15) ? 'none' : 'block';
    this.qc.forEach((c, i) => { const x = seg(t, 8.5 + i * 1.9, 9.0 + i * 1.9); fade(c, x, (1 - eo(x)) * 24); });
    // vs
    const g3in = seg(t, 15.0, 15.5), g3out = 1 - seg(t, 19.4, 19.9);
    this.g3.style.opacity = Math.min(g3in, g3out); this.g3.style.display = (t < 14.9 || t > 20) ? 'none' : 'block';
    [this.ca, this.cb].forEach((c, i) => { const x = seg(t, 15.4 + i * 0.9, 17.0 + i * 0.9); if (c._w) setBadge(c._w, c._v * eo(x)); else c._grade.style.opacity = eo(x); fade(c, seg(t, 15.2 + i * 0.4, 15.7 + i * 0.4)); });
    fade(this.cap3, seg(t, 18.1, 18.6), (1 - seg(t, 18.1, 18.6)) * 8);
    const g4 = seg(t, 20, 20.6); this.g4.style.opacity = g4; this.g4.style.display = t < 19.9 ? 'none' : 'flex';
  },
};

/* ---------- B: every review in 30 seconds ---------- */
COMPS.every = {
  dur: 33,
  build(root, d) {
    this.d = d; const s = d.show;
    this.t0 = 1.6;
    this.times = d.times || d.reviews.map((_, i) => this.t0 + (i < 5 ? i * 0.95 : 4.75 + (i - 5) * 0.55));
    this.tEnd = d.tEnd != null ? d.tEnd : this.times[this.times.length - 1] + 1.3;
    const head = $('abs card', 'left:16px;right:16px;top:62px;height:76px;padding:10px;display:flex;gap:12px;align-items:center');
    head.innerHTML = `<div style="width:56px;height:56px;border-radius:.75rem;overflow:hidden;flex-shrink:0">${artImg(d.art, 56, 'border-radius:0')}</div><div style="min-width:0"><div style="font-weight:800;font-size:16px;line-height:1.15;letter-spacing:-.01em">${esc(s.title)}</div><div style="display:flex;gap:6px;margin-top:6px">${pills(s, d.isNew, d.category)}</div></div>`;
    this.cnt = $('abs', 'left:0;right:0;top:148px;text-align:center;font-size:13px;font-weight:600;color:#9ca3af');
    this.list = $('abs', 'left:16px;right:16px;top:176px;height:262px;overflow:hidden');
    this.rows = d.reviews.map(r => { const e = $('card', 'position:absolute;left:0;right:0;height:46px;padding:0 10px;display:flex;align-items:center;gap:10px',
      `<div style="flex:1;min-width:0"><div style="font-size:13px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.o)}</div><div style="font-size:11px;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.cn || '')}</div></div><div class="score-badge bw-xs ${tierClass(r.s)}" style="width:34px;height:34px;font-size:14px">${r.s}</div>`); this.list.append(e); return e; });
    this.bc = $('abs card', 'left:24px;right:24px;top:446px;padding:10px 14px 8px', '');
    this.res = $('abs', 'inset:0;display:flex;flex-direction:column;align-items:center;padding-top:196px');
    this.rb = badgeEl('lg', 'transform:scale(1.5);transform-origin:50% 0'); 
    this.rt = $('', 'margin-top:96px;font-size:20px;font-weight:800'); this.rs = $('', 'margin-top:6px;font-size:14px;color:#d4d4d8');
    this.res.append(this.rb, this.rt, this.rs);
    this.end = $('abs', 'inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding-bottom:110px;text-align:center', `<div>${logo(30)}</div><div style="margin-top:14px;font-size:17px;font-weight:600;color:#d4d4d8">Every review. One score.</div><div style="margin-top:22px;font-size:15px;font-weight:700;color:#d4a574">broadwayscorecard.com</div>`);
    const tag = $('abs cap', 'left:0;right:0;top:34px;font-size:13px;color:#9ca3af;letter-spacing:.08em;text-transform:uppercase;font-weight:700', `${logo(14)}`);
    root.append(tag, head, this.cnt, this.list, this.bc, this.res, this.end);
    this.events = this.times.map(t => ({ t, k: 'pop' })); this.cd = d.countDur || 2.2; // how long the result badge counts up
    this.events.push({ t: this.tEnd + 0.4 + this.cd, k: d.score >= GOLD ? 'chime' : 'pop' });
  },
  update(t) {
    const d = this.d, n = d.reviews.length;
    const shown = this.times.filter(x => t >= x).length;
    this.cnt.textContent = shown ? `${shown} of ${n} reviews` : `${n} critics. Watch them land.`;
    const listOut = 1 - seg(t, this.tEnd - 0.2, this.tEnd + 0.3);
    this.list.style.opacity = listOut; this.cnt.style.opacity = listOut;
    // rows stack from bottom; each new row slides in, older ones shift up (5 visible)
    const rowH = 52, bottom = 262 - 46;
    this.rows.forEach((e, i) => {
      const age = shown - 1 - i; const prog = clamp((t - this.times[i]) / 0.3);
      if (t < this.times[i]) { e.style.opacity = 0; return; }
      const slide = (shown - 1 === i) ? eo(prog) : 1;
      const y = bottom - (age + (shown - 1 === i ? 0 : 0)) * rowH + (shown - 1 === i ? (1 - slide) * 30 : 0);
      // smooth shift for the previous rows while the newest slides in
      const shift = age >= 1 ? 0 : 0;
      e.style.transform = `translateY(${y}px)`; e.style.top = '0';
      e.style.opacity = age > 4 ? 0 : (shown - 1 === i ? slide : 1 - Math.max(0, age - 3.2) * 0.8);
    });
    this.rows.forEach((e, i) => { const age = shown - 1 - i; if (age >= 1 && age <= 5) { const prog = clamp((t - this.times[shown - 1]) / 0.3); const y = bottom - (age - 1 + eo(prog)) * rowH; e.style.transform = `translateY(${y}px)`; } });
    this.bc.innerHTML = barHtml(d.reviews.slice(0, shown).map(r => r.s), d.reviews.length, d.order === 'asc');
    this.bc.style.opacity = seg(t, 1.2, 1.8);
    const rv = seg(t, this.tEnd + 0.3, this.tEnd + 0.9);
    this.res.style.opacity = rv; this.res.style.display = rv > 0 ? 'flex' : 'none';
    const L = this.tEnd + 0.4 + this.cd, bt = seg(t, this.tEnd + 0.4, L); setBadge(this.rb, d.score * eo(bt));
    const r = Math.round(d.score); this.rt.innerHTML = `<span style="color:${tierColor(r)}">${tierLabel(r)}</span>`; this.rt.style.opacity = seg(t, L, L + 0.5);
    this.rs.textContent = `Critic Score from ${n} reviews`; this.rs.style.opacity = this.rt.style.opacity;
    const e = seg(t, L + 2.6, L + 3.2); this.end.style.opacity = e; this.end.style.display = e > 0 ? 'flex' : 'none';
    if (e > 0) { this.res.style.opacity = 1 - e; this.bc.style.opacity = 1 - e; }
  },
};

/* ---------- C: weekly top 5 ---------- */
COMPS.top5 = {
  dur: 25,
  beats: { n: [1.6, 5.0, 8.4, 11.8, 15.2], end: 21.0 },
  build(root, d) {
    this.d = d;
    root.append($('abs', 'left:0;right:0;top:34px;text-align:center', logo(14)));
    root.append($('abs cap', 'left:0;right:0;top:66px;font-size:22px;font-weight:800;letter-spacing:-.02em', esc(d.title)));
    root.append($('abs', 'left:0;right:0;top:96px;text-align:center;font-size:13px;color:#9ca3af;font-weight:600', esc(d.sub)));
    this.start = [1.6, 5.0, 8.4, 11.8, 15.2]; // rank 5 first
    this.cards = d.shows.map((s, i) => { // i = rank-1
      const rk = i + 1, top3 = rk <= 3;
      const c = $('abs card', `left:14px;right:14px;top:${126 + i * 76}px;height:68px;padding:0 10px;display:flex;align-items:center;gap:10px;${rk === 1 ? 'border-color:rgba(255,215,0,.45);' : ''}`);
      c.innerHTML = `<div class="rank" style="${top3 ? 'background:#d4a574;color:#111827' : 'background:#2a2a38;color:#9ca3af;border:1px solid rgba(255,255,255,.1)'}">${rk}</div>
        <div style="width:48px;height:48px;border-radius:.5rem;overflow:hidden;flex-shrink:0">${artImg(s.art, 48, 'border-radius:0')}</div>
        <div style="flex:1;min-width:0"><div style="font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(s.title)}</div><div style="display:flex;align-items:center;gap:6px;margin-top:5px"><span class="pill pill-${s.type === 'musical' ? 'musical' : 'play'}" style="padding:3px 8px">${s.type === 'musical' ? 'Musical' : 'Play'}</span><span style="font-size:12px;color:#9ca3af">${s.rc} reviews</span></div></div>`;
      c._b = badgeEl('sm'); c.append(c._b); c._s = s; root.append(c); return c; });
    this.cap = $('abs cap', 'left:20px;right:20px;top:520px;display:none', '');
    this.end = $('abs', 'inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding-bottom:110px;text-align:center', `<div>${logo(30)}</div><div style="margin-top:14px;font-size:17px;font-weight:600;color:#d4d4d8">${esc(d.endLine)}</div><div style="margin-top:22px;font-size:15px;font-weight:700;color:#d4a574">broadwayscorecard.com</div>`);
    root.append(this.end);
    this.events = [];
    this.start.forEach(st => { for (let k = 0; k < 6; k++) this.events.push({ t: st + 0.4 + k * 0.12, k: 'tick', p: k / 6 }); });
    this.events.push({ t: this.start[4] + 1.6, k: 'chime' });
  },
  update(t) {
    this.cards.forEach((c, i) => {
      const rk = i + 1, st = this.start[5 - rk];
      const x = seg(t, st, st + 0.5); fade(c, x, (1 - eob(x)) * 40);
      c.style.transform = `translateX(${(1 - eo(x)) * 60}px)`;
      if (rk === 1 && t > st + 1.8) c.style.boxShadow = `0 0 ${10 + 8 * Math.sin((t - st) * 3)}px rgba(255,215,0,.35), 0 2px 8px -2px rgba(0,0,0,.5)`;
      setBadge(c._b, c._s.score * eo(seg(t, st + 0.4, st + 1.5)), { size: 'sm' });
    });
    const e = seg(t, 21.0, 21.6); this.end.style.opacity = e; this.end.style.display = e > 0 ? 'flex' : 'none';
    if (e > 0) this.cards.forEach(c => c.style.opacity = 1 - e);
  },
};

/* ---------- Voiced formats (verdict, versus): scenes cue off the voiceover's word times; captions are burned in ---------- */
function captions(root, words, top = 462) {
  // phrases of up to 3 words, broken at pauses; the word being spoken is highlighted
  const ph = []; let cur = [];
  words.forEach((w, i) => { const pv = words[i - 1]; if (cur.length && (cur.length >= 3 || pv.e || w.a - pv.b > 0.28)) { ph.push(cur); cur = []; } cur.push(w); });
  if (cur.length) ph.push(cur);
  const el = $('abs', `left:16px;right:16px;top:${top}px;text-align:center;font-size:25px;line-height:1.2;font-weight:800;letter-spacing:-.01em;text-shadow:0 2px 10px rgba(0,0,0,.85);z-index:20`);
  root.append(el);
  return t => {
    const p = ph.find((p, i) => t >= p[0].a - 0.05 && t < (ph[i + 1] ? ph[i + 1][0].a - 0.05 : p[p.length - 1].b + 0.5));
    if (!p) { el.innerHTML = ''; return; }
    el.innerHTML = p.map(w => { const on = t >= w.a && t < w.b + 0.08, seen = t >= w.a;
      return `<span style="display:inline-block;margin:0 6px;color:${on ? '#e8c39e' : '#fff'};opacity:${seen ? 1 : 0};transform:scale(${on ? 1.04 : 1})">${esc(w.w)}</span>`; }).join('');
  };
}
const quoteCard = (q, top, h) => $('abs card', `left:20px;right:20px;top:${top}px;padding:12px 14px;height:${h}px`,
  `<div style="display:flex;align-items:center;gap:10px"><div style="flex:1;min-width:0"><div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#d4a574;white-space:nowrap">${esc(q.o)}</div><div style="font-size:12px;color:#9ca3af;margin-top:2px">${esc(q.cn)}</div></div><div class="score-badge bw-xs ${tierClass(q.s)}">${q.s}</div></div>
   <div style="font-size:13px;line-height:1.35;color:#e4e4e7;margin-top:8px;font-style:italic">&ldquo;${esc(q.q)}&rdquo;</div>`);
const gradeTile = g => `<div class="${g.grade === 'A+' ? 'audience-top-grade' : ''}" style="width:80px;height:80px;border-radius:.75rem;display:flex;align-items:center;justify-content:center;font-size:34px;font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.05);${g.grade === 'A+' ? '' : `background:${g.color};color:${g.textColor}`}">${esc(g.grade)}</div>`;
const sideCard = (x, label, sub) => $('abs card', `left:${x}px;width:150px;top:0;height:200px;display:flex;flex-direction:column;align-items:center;padding-top:16px`,
  `<div style="font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#d4a574">${label}</div><div class="slot" style="margin-top:28px;height:80px;display:flex;align-items:center;justify-content:center"></div><div class="sub" style="margin-top:18px;font-size:14px;font-weight:800;text-align:center">${sub}</div>`);
// toggle via visibility so an element's own inline display (flex on the end card) survives
const show = (el, o) => { el.style.opacity = o; el.style.visibility = o > 0 ? 'visible' : 'hidden'; };

function voicedBuild(self, root, d, kicker) {
  self.d = d; self.dur = d.dur; const A = d.A, r = Math.round(d.score);
  self.head = $('abs', 'inset:0;z-index:5', `<div style="position:absolute;left:0;right:0;top:34px;text-align:center">${logo(14)}</div><div style="position:absolute;left:0;right:0;top:60px;text-align:center;font-size:12px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#d4a574">${kicker}</div>`);
  root.append(self.head);
  // intro
  const g1 = self.g1 = $('abs', 'inset:0');
  g1.append($('abs card', 'left:100px;top:96px;width:160px;height:160px;padding:0;overflow:hidden;border-radius:1rem', artImg(d.art, 160, 'border-radius:0')));
  self.art = g1.firstChild;
  g1.append($('abs', 'left:12px;right:12px;top:268px;text-align:center;font-weight:800;font-size:24px;line-height:1.15;letter-spacing:-.02em', esc(d.show.title)));
  g1.append($('abs', 'left:0;right:0;top:330px;display:flex;gap:6px;justify-content:center', pills(d.show, d.isNew, d.category)));
  self.cnt = $('abs cap', 'left:20px;right:20px;top:362px;font-size:15px;color:#d4d4d8', `${d.count} reviews in`); g1.append(self.cnt);
  // quotes
  const h = d.quotes.length === 3 ? 118 : 124, gap = d.quotes.length === 3 ? 8 : 10, q0 = d.quotes.length === 3 ? 88 : 92;
  self.qc = d.quotes.map((q, i) => quoteCard(q, q0 + i * (h + gap), h));
  self.g2 = $('abs', 'inset:0'); self.qc.forEach(c => self.g2.append(c));
  // scores
  const g3 = self.g3 = $('abs', 'inset:0');
  self.bc = $('abs card', 'left:20px;right:20px;top:92px;padding:10px 14px 8px', barHtml([])); g3.append(self.bc);
  self.pair = $('abs', 'left:0;right:0;top:170px;height:200px');
  self.ca = sideCard(20, 'Critics', `<span style="color:${tierColor(r)}">${tierLabel(r)}</span>`); self.cbw = badgeEl('lg'); self.ca.querySelector('.slot').append(self.cbw);
  self.cb = sideCard(190, 'Audience', 'Audience grade'); self.cb.querySelector('.slot').innerHTML = gradeTile(d.audienceGrade);
  self.pair.append(self.ca, self.cb); g3.append(self.pair);
  self.vs = plusDot(162, 248, d.kind === 'versus' ? 'VS' : '+');
  g3.append(self.vs);
  self.ask = $('abs cap', 'left:20px;right:20px;top:388px;font-size:15px;color:#d4d4d8', 'Who is right? Tell us in the comments.'); g3.append(self.ask);
  // end
  self.end = $('abs', 'inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;padding-bottom:110px;text-align:center', `<div>${logo(30)}</div><div style="margin-top:14px;font-size:17px;font-weight:600;color:#d4d4d8">Every review. One score.</div><div style="margin-top:22px;font-size:15px;font-weight:700;color:#d4a574">broadwayscorecard.com</div>`);
  root.append(g1, self.g2, g3, self.end);
  self.cap = captions(root, d.words);
  self.events = [];
  d.quotes.forEach(q => self.events.push({ t: q.t, k: 'pop' }));
  if (A.bar) self.events.push({ t: A.bar, k: 'pop' });
  const n = 14; for (let i = 0; i < n; i++) self.events.push({ t: A.count + (A.land - A.count) * i / n, k: 'tick', p: i / n });
  self.events.push({ t: A.land, k: r >= GOLD ? 'chime' : 'pop' }, { t: A.grade, k: 'pop' }, { t: A.end, k: 'pop' });
}
function voicedUpdate(self, t) {
  const d = self.d, A = d.A, q0 = d.quotes[0].t, sc = A.bar || A.count;
  const in1 = seg(t, 0.05, 0.5), out1 = 1 - seg(t, q0 - 0.35, q0 - 0.05);
  show(self.g1, Math.min(in1, out1));
  const a = eob(seg(t, 0.05, 0.8)); self.art.style.transform = `scale(${lerp(0.85, 1, a)})`;
  fade(self.cnt, seg(t, 0.9, 1.4));
  show(self.g2, Math.min(seg(t, q0 - 0.3, q0), 1 - seg(t, sc - 0.35, sc - 0.05)));
  self.qc.forEach((c, i) => { const x = seg(t, d.quotes[i].t - 0.1, d.quotes[i].t + 0.3); fade(c, x, (1 - eo(x)) * 24); });
  const end = seg(t, A.end - 0.1, A.end + 0.4);
  show(self.g3, Math.min(seg(t, sc - 0.3, sc), 1 - end));
  if (A.bar) { const k = Math.round(d.scores.length * eo(seg(t, A.bar, A.bar + 1.6))); self.bc.innerHTML = barHtml(d.scores.slice(0, k), d.scores.length); fade(self.bc, seg(t, A.bar - 0.2, A.bar + 0.2)); }
  else { self.bc.innerHTML = barHtml(d.scores); fade(self.bc, seg(t, A.count, A.count + 0.4)); }
  fade(self.ca, seg(t, A.count - 0.3, A.count + 0.1), (1 - seg(t, A.count - 0.3, A.count + 0.1)) * 12);
  const bt = seg(t, A.count, A.land); setBadge(self.cbw, bt === 0 ? 0 : d.score * eo(bt));
  const pop = t > A.land ? 1 + 0.2 * Math.sin(Math.PI * seg(t, A.land, A.land + 0.45)) : 1; self.cbw.style.transform = `scale(${pop})`;
  fade(self.ca.querySelector('.sub'), seg(t, A.label - 0.1, A.label + 0.3));
  fade(self.cb, seg(t, A.aud - 0.2, A.aud + 0.2), (1 - seg(t, A.aud - 0.2, A.aud + 0.2)) * 12);
  const g = self.cb.querySelector('.slot').firstChild, gx = seg(t, A.grade - 0.1, A.grade + 0.25);
  g.style.opacity = gx; g.style.transform = `scale(${lerp(0.6, 1, eob(gx))})`;
  fade(self.vs, seg(t, A.aud, A.aud + 0.3));
  if (A.who) fade(self.ask, seg(t, A.who, A.who + 0.4)); else self.ask.style.opacity = 0;
  show(self.end, end); show(self.head, 1 - end);
  self.cap(t);
}
COMPS.verdict = { build(root, d) { voicedBuild(this, root, d, d.kicker || 'Opening night verdict'); }, update(t) { voicedUpdate(this, t); } };
COMPS.versus = { build(root, d) { voicedBuild(this, root, d, 'Critics vs. audience'); }, update(t) { voicedUpdate(this, t); } };

// Voiced cuts of the silent formats: the base scene plays on a clock bent so each of its beats lands on the word
// the voice is saying (d.cues, real seconds, matched by name to the base's beats); captions run on real time.
function voicedCut(base, capTop) {
  return {
    build(root, d) {
      const B = this.B = Object.create(COMPS[base]); B.build(root, d);
      // an intro holds the base scene at its start under opening cards, then the reveal runs from the critic count
      const I = d.intro, P = [[I ? I.until : 0, 0]];
      if (I) { this.ov = $('abs', 'inset:0;z-index:6;background:#0f0f14;display:flex;flex-direction:column;align-items:center;padding:150px 28px 0;gap:22px;text-align:center');
        this.ov.innerHTML = `<div>${logo(26)}</div>`;
        this.cards = I.cards.map(c => { const e = $('', 'font-size:23px;font-weight:800;line-height:1.25;letter-spacing:-.01em;opacity:0', esc(c.text)); this.ov.append(e); return e; });
        root.append(this.ov); }
      Object.keys(d.cues || {}).forEach(k => { const b = [].concat(B.beats[k]), c = [].concat(d.cues[k]);
        if (B.beats[k] == null || c.length > b.length) throw new Error(`${base}: no beat for cue ${k}`);
        c.forEach((ct, i) => P.push([ct, b[i]])); });
      P.sort((a, b) => a[0] - b[0]);
      for (let i = 1; i < P.length; i++) if (P[i][1] <= P[i - 1][1] || P[i][0] <= P[i - 1][0]) throw new Error(`${base}: voice cues out of order at ${P[i][0].toFixed(2)}s`);
      this.P = P; this.dur = d.dur;
      this.events = (B.events || []).map(e => ({ ...e, t: this.map(e.t, 1, 0) })).filter(e => e.t < d.dur);
      this.cap = captions(root, d.words, capTop);
    },
    // piecewise-linear between pinned beats; after the last one the clock runs at normal speed
    map(t, from, to) { const P = this.P; let i = 0; while (i < P.length - 1 && t > P[i + 1][from]) i++;
      const a = P[i], b = P[i + 1]; return b ? a[to] + (t - a[from]) * (b[to] - a[to]) / (b[from] - a[from]) : a[to] + (t - a[from]); },
    update(t) { this.B.update(Math.max(0, this.map(t, 0, 1))); this.cap(t);
      const I = this.B.d && this.B.d.intro; if (!I) return;
      this.ov.style.opacity = 1 - seg(t, I.until, I.until + 0.35); this.ov.style.display = t > I.until + 0.4 ? 'none' : 'flex';
      I.cards.forEach((c, i) => { const e = this.cards[i], k = seg(t, c.t - 0.1, c.t + 0.25); e.style.opacity = k; e.style.transform = `translateY(${(1 - k) * 10}px)`; }); },
  };
}
COMPS['reveal-voiced'] = voicedCut('reveal', 516);
COMPS['every-voiced'] = voicedCut('every', 516);
COMPS['top5-voiced'] = voicedCut('top5', 516);
