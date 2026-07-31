/**
 * email-components.js
 *
 * Centralized HTML builders for emails. Every site-style primitive used
 * in a Node email script (digests, broadcasts, alerts) MUST come from
 * here — no inline hex colors, no hand-rolled pills.
 *
 * Source of truth:
 *   - src/lib/audience-grade-utils.ts → audienceGrade()
 *   - src/app/globals.css .score-{must-see,great,good,tepid,skip}
 *   - src/components/show-cards/ShowPills.tsx
 *
 * Drift guard: tests/email-components-parity.test.mjs reads those source
 * files at test time and asserts the constants in this file still match.
 * If you change a color here, change the source file too — the test
 * will fail otherwise.
 *
 * Enforcement: CI greps scripts/send-*.js for inline hex colors.
 * If you find yourself writing `style="...#ef4444..."` in a digest, add
 * a builder here instead.
 *
 * Exports:
 *   TOKENS                — surface/text/brand hex constants
 *   scoreBadge(score, market)  — 56×56 site ScoreBadge replica
 *   criticTier(score, market)  — { bg, fg, label, glow } for a critic score
 *   audienceGrade(score)       — { grade, label, color, textColor } (mirrors src/lib)
 *   audienceChip(audience)     — small Audience pill: "Audience: A+ · 87"
 *   formatPill(type)           — MUSICAL / PLAY / OPERA / EVENT outline pill
 *   productionPill(isRevival)  — REVIVAL / ORIGINAL muted-fill pill
 *   categoryBadge(market)      — OFF-BROADWAY / WEST END / Off-WE (Broadway returns '')
 *   statusPill(status)         — NOW PLAYING / CLOSED / IN PREVIEWS / UPCOMING
 *   sitePill(label, opts)      — generic small pill matching ShowPills typography
 *   esc(str)                   — HTML-escape
 */

// ---------------------------------------------------------------------------
// Tokens — see memory/design-system.md. Mirrors src/app/globals.css :root.
// ---------------------------------------------------------------------------

const { resolveShowFormat } = require('./show-format');

const TOKENS = {
  surface: '#0f0f14',
  surfaceRaised: '#1a1a24',
  surfaceOverlay: '#2a2a38',
  border: 'rgba(255,255,255,0.10)',
  borderSubtle: 'rgba(255,255,255,0.06)',
  text: '#f5e6d3',
  textMuted: '#a3a3b8',
  textDim: '#6b6b80',
  brand: '#d4a574',
  brandMuted: 'rgba(212,165,116,0.18)',
  open: '#10b981',
  warn: '#d97706',
};

// ---------------------------------------------------------------------------
// HTML escape
// ---------------------------------------------------------------------------

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Critic score tier — mirrors globals.css .score-{must-see,great,good,tepid,skip}
// ---------------------------------------------------------------------------

function criticTier(score, market) {
  if (score == null) return { bg: null, fg: '#9ca3af', label: 'TBD', glow: false };
  // Round before tiering — match the displayed Math.round(score) and the site's
  // ScoreBadge.getScoreTier (2026-06-30). Raw thresholds put a 64.69 in "Mixed"
  // while the badge shows 65 ("Worth Seeing").
  const s = Math.round(score);
  const goldThreshold = (market === 'west-end' || market === 'off-west-end') ? 85 : 83;
  if (s >= goldThreshold) return {
    bg: 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)',
    fg: '#1a1a1a',
    label: 'Critical Gold',
    glow: true,
  };
  if (s >= 75) return { bg: '#22c55e', fg: '#ffffff', label: 'Recommended', glow: false };
  if (s >= 65) return { bg: '#14b8a6', fg: '#ffffff', label: 'Worth Seeing', glow: false };
  if (s >= 55) return { bg: '#d97706', fg: '#1a1a1a', label: 'Mixed', glow: false };
  return { bg: '#ef4444', fg: '#ffffff', label: 'Critical Miss', glow: false };
}

// ---------------------------------------------------------------------------
// Audience grade — verbatim mirror of src/lib/audience-grade-utils.ts
// ---------------------------------------------------------------------------

function audienceGrade(score) {
  if (score == null) return { grade: '—', label: 'No Data', color: '#6b7280', textColor: '#ffffff' };
  if (score >= 90) return { grade: 'A+', label: 'Loving It', color: '#22c55e', textColor: '#ffffff' };
  if (score >= 88) return { grade: 'A',  label: 'Loving It', color: '#16a34a', textColor: '#ffffff' };
  if (score >= 83) return { grade: 'A-', label: 'Liking It', color: '#14b8a6', textColor: '#ffffff' };
  if (score >= 78) return { grade: 'B+', label: 'Liking It', color: '#0ea5e9', textColor: '#ffffff' };
  if (score >= 73) return { grade: 'B',  label: 'Shrugging', color: '#f59e0b', textColor: '#1a1a1a' };
  if (score >= 68) return { grade: 'B-', label: 'Shrugging', color: '#f97316', textColor: '#1a1a1a' };
  if (score >= 63) return { grade: 'C+', label: 'Disliking It', color: '#ef4444', textColor: '#ffffff' };
  if (score >= 58) return { grade: 'C',  label: 'Disliking It', color: '#dc2626', textColor: '#ffffff' };
  if (score >= 53) return { grade: 'C-', label: 'Disliking It', color: '#b91c1c', textColor: '#ffffff' };
  if (score >= 48) return { grade: 'D',  label: 'Loathing It', color: '#991b1b', textColor: '#ffffff' };
  return { grade: 'F', label: 'Loathing It', color: '#6b7280', textColor: '#ffffff' };
}

// ---------------------------------------------------------------------------
// Builders — produce HTML strings
// ---------------------------------------------------------------------------

// ScoreBadge (md size). Square, 56×56, rounded-xl, just the number.
function scoreBadge(score, market) {
  if (score == null) {
    return `<span style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:12px;background:rgba(255,255,255,0.04);border:1px solid ${TOKENS.border};color:#9ca3af;font-weight:700;font-size:14px;line-height:1;">TBD</span>`;
  }
  const t = criticTier(score, market);
  const extra = t.glow
    ? 'box-shadow:0 0 16px rgba(218,165,32,0.45),0 2px 8px rgba(0,0,0,0.25);border:2px solid #C8960E;'
    : 'box-shadow:0 2px 8px rgba(0,0,0,0.25);';
  return `<span style="display:inline-flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:12px;background:${t.bg};color:${t.fg};font-weight:800;font-size:22px;letter-spacing:-0.02em;line-height:1;${extra}">${score}</span>`;
}

// AudienceChip — small pill, "Audience: A+ · 87" format.
function audienceChip(audience) {
  if (!audience || audience.score == null) {
    return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:9999px;background:rgba(107,114,128,0.20);color:#9ca3af;font-size:10px;font-weight:700;line-height:1;letter-spacing:0.02em;"><span style="opacity:0.6;font-weight:600;">Audience:</span><span>—</span></span>`;
  }
  const g = audienceGrade(audience.score);
  return `<span style="display:inline-flex;align-items:center;gap:5px;padding:3px 8px;border-radius:9999px;background:${g.color}33;color:${g.color};font-size:10px;font-weight:700;line-height:1;letter-spacing:0.02em;"><span style="opacity:0.6;font-weight:600;">Audience:</span><span>${esc(g.grade)} · ${audience.score}</span></span>`;
}

// FormatPill — outline. musical/play/opera/special.
// Labels come from scripts/lib/show-format.js (mirror of src/lib/show-format.ts)
// so email and web never disagree. The previous local map defaulted every
// unknown type to PLAY, which shipped 43 `type: 'special'` shows — concerts,
// galas, immersive experiences — labelled as plays, in digest email as well as
// on the site.
function formatPill(type) {
  const fmt = resolveShowFormat(type);
  const cfg = { label: fmt.label, color: fmt.emailColor };
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-size:10px;line-height:1;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;border:1px solid ${cfg.color}80;color:${cfg.color};background:transparent;">${esc(cfg.label)}</span>`;
}

// ProductionPill — solid muted fill. revival/original.
function productionPill(isRevival) {
  const cfg = isRevival
    ? { label: 'REVIVAL', color: '#9ca3af', bg: 'rgba(107,114,128,0.20)' }
    : { label: 'ORIGINAL', color: '#fbbf24', bg: 'rgba(245,158,11,0.20)' };
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-size:10px;line-height:1;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${cfg.color};background:${cfg.bg};">${esc(cfg.label)}</span>`;
}

// CategoryBadge — off-broadway / west-end / off-WE. Broadway returns ''.
function categoryBadge(market) {
  const cfg = {
    'off-broadway': { label: 'OFF-BROADWAY', color: '#818cf8', border: 'rgba(99,102,241,0.30)', bg: 'rgba(99,102,241,0.15)' },
    'west-end':     { label: 'WEST END',     color: '#2dd4bf', border: 'rgba(20,184,166,0.30)', bg: 'rgba(20,184,166,0.15)' },
    'off-west-end': { label: 'Off-WE',       color: '#9ca3af', border: 'rgba(255,255,255,0.10)', bg: 'rgba(255,255,255,0.05)' },
  }[market];
  if (!cfg) return '';
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-size:10px;line-height:1;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${cfg.color};background:${cfg.bg};border:1px solid ${cfg.border};">${esc(cfg.label)}</span>`;
}

// StatusPill — show status (open / closed / previews / upcoming / announced).
function statusPill(status) {
  const cfg = {
    open:      { label: 'NOW PLAYING', color: '#34d399', bg: 'rgba(16,185,129,0.15)' },
    closed:    { label: 'CLOSED',      color: '#9ca3af', bg: 'rgba(107,114,128,0.15)' },
    previews:  { label: 'IN PREVIEWS', color: '#c084fc', bg: 'rgba(168,85,247,0.15)' },
    upcoming:  { label: 'UPCOMING',    color: '#60a5fa', bg: 'rgba(59,130,246,0.15)' },
    announced: { label: 'ANNOUNCED',   color: '#60a5fa', bg: 'rgba(59,130,246,0.15)' },
  }[status] || { label: String(status || '').toUpperCase(), color: '#9ca3af', bg: 'rgba(107,114,128,0.15)' };
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-size:10px;line-height:1;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${cfg.color};background:${cfg.bg};">${esc(cfg.label)}</span>`;
}

// Generic small pill with the site's metrics — for action chips like
// "Needs help", "Broadcast ready". Pass color from TOKENS so the gate
// stays clean.
function sitePill(label, { color = TOKENS.textMuted, bg = TOKENS.surfaceOverlay, border = null } = {}) {
  const borderStyle = border ? `border:1px solid ${border};` : '';
  return `<span style="display:inline-flex;align-items:center;padding:3px 10px;border-radius:9999px;font-size:10px;line-height:1;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${color};background:${bg};${borderStyle}">${esc(label)}</span>`;
}

module.exports = {
  TOKENS,
  esc,
  criticTier,
  audienceGrade,
  scoreBadge,
  audienceChip,
  formatPill,
  productionPill,
  categoryBadge,
  statusPill,
  sitePill,
};
