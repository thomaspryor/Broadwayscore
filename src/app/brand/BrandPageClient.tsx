'use client';

import { useState } from 'react';

type Swatch = {
  name: string;
  hex: string;
  usage?: string;
  textOn?: 'light' | 'dark';
};

function Swatch({ swatch }: { swatch: Swatch }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(swatch.hex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Clipboard can fail in iframes; fail silently.
    }
  };

  const textColor = swatch.textOn === 'light' ? 'text-gray-900' : 'text-white';

  return (
    <button
      type="button"
      onClick={copy}
      className="group relative text-left rounded-card overflow-hidden border border-white/5 hover:border-white/20 transition-all hover:scale-[1.02] focus-ring"
      aria-label={`Copy ${swatch.hex}`}
    >
      <div
        className={`h-24 flex items-end p-3 ${textColor}`}
        style={{ background: swatch.hex }}
      >
        <div className="w-full flex items-center justify-between">
          <span className="text-xs font-mono uppercase tracking-wide opacity-80">{swatch.hex}</span>
          <span className="text-[10px] font-semibold uppercase opacity-0 group-hover:opacity-100 transition-opacity">
            {copied ? 'Copied!' : 'Copy'}
          </span>
        </div>
      </div>
      <div className="p-3 bg-surface-raised">
        <div className="font-semibold text-white text-sm">{swatch.name}</div>
        {swatch.usage && (
          <div className="text-xs text-gray-400 mt-0.5">{swatch.usage}</div>
        )}
      </div>
    </button>
  );
}

function Section({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="text-2xl font-bold text-white mb-1">{title}</h2>
      {description && <p className="text-gray-400 mb-5 text-sm">{description}</p>}
      {children}
    </section>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Silent fail
    }
  };

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="text-xs text-brand hover:text-brand-light transition-colors font-medium"
        >
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
      <pre className="bg-surface-raised border border-white/5 rounded-card p-4 overflow-x-auto text-xs text-gray-300 font-mono leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

const surfaceSwatches: Swatch[] = [
  { name: 'Surface', hex: '#0f0f14', usage: 'Page background', textOn: 'dark' },
  { name: 'Surface Raised', hex: '#1a1a24', usage: 'Cards, panels', textOn: 'dark' },
  { name: 'Surface Overlay', hex: '#2a2a38', usage: 'Hover, popovers', textOn: 'dark' },
  { name: 'Surface Elevated', hex: '#32323f', usage: 'Modals, dropdowns', textOn: 'dark' },
];

const brandSwatches: Swatch[] = [
  { name: 'Brand Gold', hex: '#d4a574', usage: 'Primary — buttons, links, logo', textOn: 'light' },
  { name: 'Brand Gold Hover', hex: '#c4956a', usage: 'Hover state', textOn: 'light' },
  { name: 'Brand Gold Light', hex: '#e4b584', usage: 'Light emphasis', textOn: 'light' },
  { name: 'West End Pink', hex: '#f472b6', usage: 'WE market accent', textOn: 'light' },
];

const scoreSwatches: Swatch[] = [
  { name: 'Must See (83-100)', hex: '#FFD700', usage: 'Critical Gold', textOn: 'light' },
  { name: 'Recommended (75-82)', hex: '#22c55e', usage: 'Green', textOn: 'dark' },
  { name: 'Worth Seeing (65-74)', hex: '#14b8a6', usage: 'Teal', textOn: 'dark' },
  { name: 'Skippable (55-64)', hex: '#d97706', usage: 'Amber/Orange', textOn: 'light' },
  { name: 'Stay Away (0-54)', hex: '#ef4444', usage: 'Red', textOn: 'light' },
];

const textSwatches: Swatch[] = [
  { name: 'Text Primary', hex: '#ffffff', usage: 'Headings, key labels', textOn: 'light' },
  { name: 'Text Secondary', hex: '#d1d5db', usage: 'Body copy', textOn: 'light' },
  { name: 'Text Muted', hex: '#9ca3af', usage: 'Captions, meta', textOn: 'light' },
  { name: 'Text Faint', hex: '#6b7280', usage: 'Placeholder, hints', textOn: 'light' },
];

const tailwindSnippet = `// Use these Tailwind tokens instead of raw hex:
// Surfaces
className="bg-surface"          // Page
className="bg-surface-raised"   // Cards
className="bg-surface-overlay"  // Hover

// Brand
className="bg-brand hover:bg-brand-hover text-white"

// Scores (CSS badge classes, from globals.css)
className="score-badge score-must-see"   // 83-100
className="score-badge score-great"      // 75-82
className="score-badge score-good"       // 65-74
className="score-badge score-tepid"      // 55-64
className="score-badge score-skip"       // 0-54`;

const cssSnippet = `/* Paste into any non-Tailwind stylesheet */
:root {
  --bwsc-surface: #0f0f14;
  --bwsc-surface-raised: #1a1a24;
  --bwsc-surface-overlay: #2a2a38;
  --bwsc-brand-gold: #d4a574;
  --bwsc-brand-gold-hover: #c4956a;
  --bwsc-text-primary: #ffffff;
  --bwsc-text-muted: #9ca3af;
  --bwsc-score-must-see: #FFD700;
  --bwsc-score-great: #22c55e;
  --bwsc-score-good: #14b8a6;
  --bwsc-score-tepid: #d97706;
  --bwsc-score-skip: #ef4444;
  --bwsc-font: 'Inter', system-ui, sans-serif;
}`;

const jsonSnippet = `// Fetch the full token palette (auto-updated with every deploy):
fetch('https://broadwayscorecard.com/brand-tokens.json')
  .then(r => r.json())
  .then(tokens => {
    console.log(tokens.brand.gold);  // "#d4a574"
    console.log(tokens.scores);       // full score tier palette
  });`;

export default function BrandPageClient() {
  return (
    <div className="min-h-screen bg-surface text-white">
      {/* Hero */}
      <section className="border-b border-white/5 px-4 py-16 sm:py-24">
        <div className="max-w-4xl mx-auto text-center">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-brand mb-4">Brand Kit</p>
          <h1 className="text-4xl sm:text-5xl font-extrabold mb-4">
            <span className="text-white">Broadway</span>{' '}
            <span className="text-gradient">Scorecard</span>
          </h1>
          <p className="text-lg text-gray-400 max-w-2xl mx-auto">
            Colors, type, and assets used across broadwayscorecard.com. Click any swatch to copy its hex. Import into Canva, Figma, Buffer, or any design tool.
          </p>
        </div>
      </section>

      <div className="max-w-5xl mx-auto px-4 py-12">
        {/* Quick links */}
        <div className="flex flex-wrap gap-2 mb-10 text-xs">
          <a href="#colors" className="px-3 py-1.5 bg-surface-raised rounded-pill border border-white/10 hover:border-white/20 transition-colors">Colors</a>
          <a href="#scores" className="px-3 py-1.5 bg-surface-raised rounded-pill border border-white/10 hover:border-white/20 transition-colors">Score Tiers</a>
          <a href="#typography" className="px-3 py-1.5 bg-surface-raised rounded-pill border border-white/10 hover:border-white/20 transition-colors">Typography</a>
          <a href="#canva" className="px-3 py-1.5 bg-surface-raised rounded-pill border border-white/10 hover:border-white/20 transition-colors">Canva Setup</a>
          <a href="#buffer" className="px-3 py-1.5 bg-surface-raised rounded-pill border border-white/10 hover:border-white/20 transition-colors">Buffer</a>
          <a href="#downloads" className="px-3 py-1.5 bg-surface-raised rounded-pill border border-white/10 hover:border-white/20 transition-colors">Downloads</a>
          <a href="#attribution" className="px-3 py-1.5 bg-surface-raised rounded-pill border border-white/10 hover:border-white/20 transition-colors">Attribution</a>
          <a href="#code" className="px-3 py-1.5 bg-surface-raised rounded-pill border border-white/10 hover:border-white/20 transition-colors">Code</a>
        </div>

        {/* Surfaces */}
        <div id="colors">
          <Section title="Surfaces" description="Dark theme background layers. Pages start at Surface and build up.">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {surfaceSwatches.map(s => <Swatch key={s.hex} swatch={s} />)}
            </div>
          </Section>
        </div>

        {/* Brand */}
        <Section title="Brand" description="Muted gold is the signature. West End uses pink for differentiation.">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {brandSwatches.map(s => <Swatch key={s.hex} swatch={s} />)}
          </div>
        </Section>

        {/* Score Tiers */}
        <div id="scores">
          <Section title="Score Tiers" description="Every show is rated on this 5-tier scale. Must See is a gold gradient; others are solid fills.">
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-4">
              {scoreSwatches.map(s => <Swatch key={s.hex} swatch={s} />)}
            </div>
            <div className="rounded-card bg-surface-raised border border-white/5 p-4">
              <div className="text-xs font-semibold uppercase text-gray-400 mb-3 tracking-wide">Badge Preview</div>
              <div className="flex flex-wrap gap-3 items-center">
                <div className="score-badge score-must-see w-16 h-16 rounded-badge flex items-center justify-center text-score-md">92</div>
                <div className="score-badge score-great w-16 h-16 rounded-badge flex items-center justify-center text-score-md">78</div>
                <div className="score-badge score-good w-16 h-16 rounded-badge flex items-center justify-center text-score-md">68</div>
                <div className="score-badge score-tepid w-16 h-16 rounded-badge flex items-center justify-center text-score-md">60</div>
                <div className="score-badge score-skip w-16 h-16 rounded-badge flex items-center justify-center text-score-md">45</div>
              </div>
            </div>
          </Section>
        </div>

        {/* Text */}
        <Section title="Text Colors" description="Four-step gray scale for text hierarchy on dark backgrounds.">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {textSwatches.map(s => <Swatch key={s.hex} swatch={s} />)}
          </div>
        </Section>

        {/* Typography */}
        <div id="typography">
          <Section title="Typography" description="Inter for everything. Extrabold for headlines, Regular for body.">
            <div className="rounded-card bg-surface-raised border border-white/5 p-6 space-y-4">
              <div>
                <div className="text-xs font-semibold uppercase text-gray-400 mb-2 tracking-wide">Headline — Inter Extrabold</div>
                <div className="text-4xl font-extrabold">The 2025-26 Season</div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase text-gray-400 mb-2 tracking-wide">Title — Inter Bold</div>
                <div className="text-2xl font-bold">Critical Gold</div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase text-gray-400 mb-2 tracking-wide">Body — Inter Regular</div>
                <div className="text-base text-gray-300">Broadway Scorecard aggregates every critic review into a single 0-100 score per show, so you always know what&apos;s worth seeing.</div>
              </div>
              <div>
                <div className="text-xs font-semibold uppercase text-gray-400 mb-2 tracking-wide">Caption — Inter Medium Small</div>
                <div className="text-xs font-medium uppercase tracking-wide text-gray-500">MUSICAL · PREVIEWS · $89</div>
              </div>
            </div>
          </Section>
        </div>

        {/* Canva Setup */}
        <div id="canva">
          <Section
            title="Canva Brand Kit Setup"
            description="Add BWSC colors to Canva once. Every design automatically uses the right hex."
          >
            <div className="rounded-card bg-surface-raised border border-white/5 p-6">
              <ol className="space-y-4 text-sm">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center">1</span>
                  <div>
                    <div className="font-semibold text-white">Open Canva → Brand Hub</div>
                    <div className="text-gray-400 mt-1">In Canva, click <span className="text-gray-300 font-medium">Brand</span> in the left sidebar → <span className="text-gray-300 font-medium">Brand Kits</span> → pick or create a kit. Requires Canva Pro or Teams. (Exact path may vary — search &quot;Brand Kit&quot; from the Canva homepage if you can&apos;t find it.)</div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center">2</span>
                  <div>
                    <div className="font-semibold text-white">Add the brand colors</div>
                    <div className="text-gray-400 mt-1 mb-3">Click <span className="text-gray-300 font-medium">+ Add new</span> under Brand Colors. Paste each hex below. Canva auto-fills the name.</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {[
                        { name: 'BWSC Gold', hex: '#d4a574' },
                        { name: 'BWSC Gold Hover', hex: '#c4956a' },
                        { name: 'BWSC Surface', hex: '#0f0f14' },
                        { name: 'BWSC Surface Raised', hex: '#1a1a24' },
                        { name: 'West End Pink', hex: '#f472b6' },
                        { name: 'Score Must See', hex: '#FFD700' },
                        { name: 'Score Great', hex: '#22c55e' },
                        { name: 'Score Good', hex: '#14b8a6' },
                        { name: 'Score Tepid', hex: '#d97706' },
                        { name: 'Score Skip', hex: '#ef4444' },
                      ].map(c => (
                        <CanvaCopyRow key={c.hex} name={c.name} hex={c.hex} />
                      ))}
                    </div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center">3</span>
                  <div>
                    <div className="font-semibold text-white">Add the brand font</div>
                    <div className="text-gray-400 mt-1">Under <span className="text-gray-300 font-medium">Brand Fonts</span> → set Heading + Body to <span className="text-white font-mono text-xs bg-surface-overlay px-2 py-0.5 rounded">Inter</span>. It&apos;s free in Canva.</div>
                  </div>
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-brand text-white text-xs font-bold flex items-center justify-center">4</span>
                  <div>
                    <div className="font-semibold text-white">Upload logo reference</div>
                    <div className="text-gray-400 mt-1">Under <span className="text-gray-300 font-medium">Logos</span> → upload the palette reference image (download below). Use it while designing to keep scores on-brand.</div>
                  </div>
                </li>
              </ol>
            </div>
          </Section>
        </div>

        {/* Buffer */}
        <div id="buffer">
          <Section
            title="Buffer"
            description="Social post scheduling. Content Library doesn't support brand kits — use downloads below."
          >
            <div className="rounded-card bg-surface-raised border border-white/5 p-6 text-sm space-y-3">
              <p className="text-gray-300">
                Buffer doesn&apos;t have a Brand Kit feature — its Content Library is for saving ready-to-schedule posts, not tokens.
              </p>
              <p className="text-gray-400">
                <strong className="text-white">Workflow:</strong> Design posts in Canva (with the Brand Kit above applied), export as PNG, upload to Buffer&apos;s Content Library as templates you can reuse across Twitter, Instagram, etc.
              </p>
              <p className="text-gray-400">
                <strong className="text-white">When drafting copy:</strong> Grab any hex from this page (click a swatch) and drop into Canva.
              </p>
            </div>
          </Section>
        </div>

        {/* Downloads */}
        <div id="downloads">
          <Section title="Downloads" description="Raw assets for design tools. Right-click → Save As.">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <DownloadTile
                title="Palette Reference (SVG)"
                description="One-page color reference. Upload to Canva's Brand Kit as a logo asset."
                href="/brand-kit/palette.svg"
                filename="bwsc-palette.svg"
              />
              <DownloadTile
                title="Brand Tokens (JSON)"
                description="Full palette in machine-readable form. Auto-updates with every deploy."
                href="/brand-tokens.json"
                filename="bwsc-brand-tokens.json"
              />
              <DownloadTile
                title="Fantasy League Logo (PNG)"
                description="BFL shield for fantasy-league-related posts."
                href="/images/fantasy/bfl-logo.png"
                filename="bfl-logo.png"
              />
              <DownloadTile
                title="OG Image (PNG)"
                description="Default social card — 1200×630."
                href="/og/home.png"
                filename="bwsc-og.png"
              />
            </div>
          </Section>
        </div>

        {/* Attribution / CriticScore lockup */}
        <div id="attribution">
          <Section
            title="CriticScore™ Lockup"
            description="How to display the score when embedding on another site. The score and its tier travel as a unit — never split them."
          >
            <div className="rounded-card bg-surface-raised border border-white/5 p-6 mb-4">
              <div className="text-xs font-semibold uppercase text-gray-400 mb-4 tracking-wide">Required lockup</div>
              <div className="flex items-center gap-4 p-4 bg-surface rounded-card border border-white/5 max-w-md">
                <div className="flex-shrink-0 w-16 h-16 rounded-xl flex items-center justify-center font-bold text-3xl" style={{ background: 'linear-gradient(135deg, #DAA520 0%, #FFD700 30%, #FFF0A0 50%, #FFD700 70%, #DAA520 100%)', color: '#1a1a1a', border: '2px solid #C8960E', boxShadow: '0 0 20px rgba(255,215,0,0.4)' }}>
                  88
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-bold text-white">Proof</div>
                  <div className="text-xs text-gray-400">Critical Gold · 12 critics</div>
                  <div className="text-[9px] font-semibold text-brand tracking-[0.5px] uppercase mt-0.5">CriticScore™ by Broadway Scorecard</div>
                </div>
              </div>
            </div>

            <div className="space-y-4 text-sm text-gray-300 leading-relaxed">
              <p>
                <strong className="text-white">The four required elements</strong> for any external display of a BWSC score:
              </p>
              <ol className="list-decimal list-inside space-y-2 pl-2">
                <li><strong className="text-white">Score number</strong> — rounded, as a whole integer (e.g. 88)</li>
                <li><strong className="text-white">Tier color</strong> — the badge background must match the tier: gold (83+), green (75-82), teal (65-74), orange (55-64), red (&lt;55)</li>
                <li><strong className="text-white">Tier label</strong> — &ldquo;Critical Gold,&rdquo; &ldquo;Recommended,&rdquo; &ldquo;Worth Seeing,&rdquo; &ldquo;Skippable,&rdquo; or &ldquo;Stay Away&rdquo;</li>
                <li><strong className="text-white">Attribution</strong> — the text <span className="font-mono text-xs bg-surface-overlay px-2 py-0.5 rounded">CriticScore™ by Broadway Scorecard</span> in brand gold <code className="text-xs text-brand">#d4a574</code>, linking to broadwayscorecard.com</li>
              </ol>
              <p>
                <strong className="text-white">Not allowed:</strong> stripping the tier color, normalizing to a different scale (e.g. /5 stars), removing the attribution, or showing a stale cached score. Partners should use the live{' '}
                <a href="/partners" className="text-brand hover:text-brand-light">embed or SVG badge</a> so scores update automatically.
              </p>
              <p>
                <strong className="text-white">Want to embed?</strong> Copy-paste snippets are at{' '}
                <a href="/partners" className="text-brand hover:text-brand-light">/partners</a>. Both iframe and SVG options bake the attribution in automatically.
              </p>
            </div>
          </Section>
        </div>

        {/* Code */}
        <div id="code">
          <Section title="For Developers" description="Copy-paste snippets for code consumers.">
            <CodeBlock label="Tailwind (this codebase)" code={tailwindSnippet} />
            <CodeBlock label="CSS Variables" code={cssSnippet} />
            <CodeBlock label="Fetch JSON" code={jsonSnippet} />
          </Section>
        </div>

        {/* Footer note */}
        <div className="border-t border-white/5 pt-8 mt-16 text-xs text-gray-500 text-center">
          Canonical source: <code className="text-gray-400">scripts/lib/brand-colors.js</code>.
          When colors change, update that file AND <code className="text-gray-400">tailwind.config.ts</code>.
        </div>
      </div>
    </div>
  );
}

function CanvaCopyRow({ name, hex }: { name: string; hex: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(hex);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // Silent
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      className="flex items-center gap-3 p-2 rounded-card bg-surface border border-white/5 hover:border-white/20 transition-colors text-left group"
    >
      <span className="w-6 h-6 rounded border border-white/10 flex-shrink-0" style={{ background: hex }} />
      <div className="flex-1 min-w-0">
        <div className="text-xs font-semibold text-white truncate">{name}</div>
        <div className="text-[10px] font-mono text-gray-500">{hex}</div>
      </div>
      <span className="text-[10px] text-brand opacity-0 group-hover:opacity-100 transition-opacity font-semibold uppercase">
        {copied ? 'Copied' : 'Copy'}
      </span>
    </button>
  );
}

function DownloadTile({ title, description, href, filename }: { title: string; description: string; href: string; filename: string }) {
  return (
    <a
      href={href}
      download={filename}
      className="block p-4 rounded-card bg-surface-raised border border-white/5 hover:border-brand/50 transition-colors group"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-white mb-1 group-hover:text-brand transition-colors">{title}</div>
          <div className="text-xs text-gray-400">{description}</div>
        </div>
        <svg className="w-5 h-5 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m-4-4l4 4 4-4" />
        </svg>
      </div>
    </a>
  );
}
