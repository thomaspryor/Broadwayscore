'use client';

import { useRef, useState } from 'react';

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
          <a href="#builder" className="px-3 py-1.5 bg-surface-raised rounded-pill border border-white/10 hover:border-white/20 transition-colors">Badge Builder</a>
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
          <Section title="Downloads" description="Ready-made PNGs for social, press, partners. Click any tile to download, or grab the full kit as a zip.">
            {/* Big kit-zip button */}
            <a
              href="/brand-kit/broadway-scorecard-brand-kit.zip"
              download="broadway-scorecard-brand-kit.zip"
              className="block mb-6 rounded-card bg-gradient-to-br from-brand/20 to-surface-raised border border-brand/30 hover:border-brand transition-colors p-5 sm:p-6 group"
            >
              <div className="flex items-center gap-4">
                <div className="flex-shrink-0 w-12 h-12 sm:w-14 sm:h-14 rounded-xl bg-brand/20 flex items-center justify-center">
                  <svg className="w-6 h-6 sm:w-7 sm:h-7 text-brand" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m-4-4l4 4 4-4" />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-base sm:text-lg font-bold text-white group-hover:text-brand transition-colors">Download Entire Brand Kit</div>
                  <div className="text-xs sm:text-sm text-gray-400 mt-0.5">52 PNGs · logos, score/grade badges, social templates · 8.2 MB zip</div>
                </div>
                <span className="hidden sm:inline-flex items-center gap-1 px-3 py-1.5 rounded-pill bg-brand text-white text-xs font-bold group-hover:bg-brand-hover transition-colors">
                  Get kit
                </span>
              </div>
            </a>

            {/* Reference downloads */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-8">
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
            </div>

            {/* Asset galleries */}
            <AssetGallery title="Logos" assets={logoAssets} />
            <AssetGallery title="Score Badges" assets={scoreBadgeAssets} columns="md" />
            <AssetGallery title="Audience Grade Badges" assets={gradeBadgeAssets} columns="md" />
            <AssetGallery title="Reference Sheets" assets={referenceAssets} />
            <AssetGallery title="Social Templates" assets={socialAssets} />
          </Section>
        </div>

        {/* Custom badge builder */}
        <div id="builder">
          <Section
            title="Badge Builder"
            description="Make a custom score badge for any show. Pick a score, pick a background, download the PNG."
          >
            <BadgeBuilder />
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

type Asset = {
  label: string;
  filename: string;
  sub?: string;
  transparent?: boolean;
  lightBg?: boolean;
  aspect?: 'square' | 'wide' | 'tall';
};

const logoAssets: Asset[] = [
  { label: 'Broadway Wordmark', sub: 'Dark background', filename: 'logos/broadway-wordmark-dark.png', aspect: 'wide' },
  { label: 'Broadway Wordmark', sub: 'Transparent', filename: 'logos/broadway-wordmark-transparent.png', transparent: true, aspect: 'wide' },
  { label: 'Broadway Wordmark', sub: 'Light background', filename: 'logos/broadway-wordmark-light.png', lightBg: true, aspect: 'wide' },
  { label: 'West End Wordmark', sub: 'Dark background', filename: 'logos/west-end-wordmark-dark.png', aspect: 'wide' },
  { label: 'West End Wordmark', sub: 'Transparent', filename: 'logos/west-end-wordmark-transparent.png', transparent: true, aspect: 'wide' },
  { label: 'West End Wordmark', sub: 'Light background', filename: 'logos/west-end-wordmark-light.png', lightBg: true, aspect: 'wide' },
  { label: 'App Icon', sub: 'Dark', filename: 'logos/icon-dark.png', aspect: 'square' },
  { label: 'App Icon', sub: 'Transparent', filename: 'logos/icon-transparent.png', transparent: true, aspect: 'square' },
];

const scoreBadgeAssets: Asset[] = [
  { label: 'Critical Gold', sub: 'Score 83–100', filename: 'score-badges/critical-gold-87-dark.png' },
  { label: 'Critical Gold', sub: 'Transparent', filename: 'score-badges/critical-gold-87-transparent.png', transparent: true },
  { label: 'Recommended', sub: 'Score 75–82', filename: 'score-badges/recommended-79-dark.png' },
  { label: 'Recommended', sub: 'Transparent', filename: 'score-badges/recommended-79-transparent.png', transparent: true },
  { label: 'Worth Seeing', sub: 'Score 65–74', filename: 'score-badges/worth-seeing-70-dark.png' },
  { label: 'Worth Seeing', sub: 'Transparent', filename: 'score-badges/worth-seeing-70-transparent.png', transparent: true },
  { label: 'Skippable', sub: 'Score 55–64', filename: 'score-badges/skippable-60-dark.png' },
  { label: 'Skippable', sub: 'Transparent', filename: 'score-badges/skippable-60-transparent.png', transparent: true },
  { label: 'Stay Away', sub: 'Score < 55', filename: 'score-badges/stay-away-45-dark.png' },
  { label: 'Stay Away', sub: 'Transparent', filename: 'score-badges/stay-away-45-transparent.png', transparent: true },
];

const gradeLetters: Array<[string, string]> = [
  ['Aplus', 'A+'], ['A', 'A'], ['Aminus', 'A−'],
  ['Bplus', 'B+'], ['B', 'B'], ['Bminus', 'B−'],
  ['Cplus', 'C+'], ['C', 'C'], ['Cminus', 'C−'],
  ['D', 'D'], ['F', 'F'],
];

const gradeBadgeAssets: Asset[] = gradeLetters.flatMap(([slug, display]) => [
  { label: `Grade ${display}`, sub: 'Dark', filename: `grade-badges/grade-${slug}-dark.png` as string },
  { label: `Grade ${display}`, sub: 'Transparent', filename: `grade-badges/grade-${slug}-transparent.png` as string, transparent: true },
]);

const referenceAssets: Asset[] = [
  { label: 'Score Tiers Overview', sub: 'All 5 critic tiers · dark', filename: 'references/score-tiers-dark.png', aspect: 'wide' },
  { label: 'Score Tiers Overview', sub: 'Transparent', filename: 'references/score-tiers-transparent.png', transparent: true, aspect: 'wide' },
  { label: 'Grade Tiers Overview', sub: 'All 11 audience grades · dark', filename: 'references/grade-tiers-dark.png', aspect: 'wide' },
  { label: 'Grade Tiers Overview', sub: 'Transparent', filename: 'references/grade-tiers-transparent.png', transparent: true, aspect: 'wide' },
];

const socialAssets: Asset[] = [
  { label: 'Instagram Square', sub: 'Broadway · 1080×1080', filename: 'social/broadway-instagram-square-1080x1080.png', aspect: 'square' },
  { label: 'Instagram Story', sub: 'Broadway · 1080×1920', filename: 'social/broadway-instagram-story-1080x1920.png', aspect: 'tall' },
  { label: 'OG / Link Preview', sub: 'Broadway · 1200×630', filename: 'social/broadway-og-1200x630.png', aspect: 'wide' },
  { label: 'Twitter Header', sub: 'Broadway · 1500×500', filename: 'social/broadway-twitter-header-1500x500.png', aspect: 'wide' },
  { label: 'Instagram Square', sub: 'West End · 1080×1080', filename: 'social/west-end-instagram-square-1080x1080.png', aspect: 'square' },
  { label: 'Instagram Story', sub: 'West End · 1080×1920', filename: 'social/west-end-instagram-story-1080x1920.png', aspect: 'tall' },
  { label: 'OG / Link Preview', sub: 'West End · 1200×630', filename: 'social/west-end-og-1200x630.png', aspect: 'wide' },
  { label: 'Twitter Header', sub: 'West End · 1500×500', filename: 'social/west-end-twitter-header-1500x500.png', aspect: 'wide' },
];

function AssetGallery({ title, assets, columns = 'default' }: { title: string; assets: Asset[]; columns?: 'default' | 'md' }) {
  const gridClass = columns === 'md'
    ? 'grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3'
    : 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3';
  return (
    <div className="mb-8">
      <h3 className="text-sm font-bold uppercase tracking-wider text-gray-300 mb-3">{title} <span className="text-gray-500 font-normal">· {assets.length}</span></h3>
      <div className={gridClass}>
        {assets.map(a => <AssetTile key={a.filename} asset={a} />)}
      </div>
    </div>
  );
}

function AssetTile({ asset }: { asset: Asset }) {
  const href = `/brand-kit/${asset.filename}`;
  const downloadName = asset.filename.split('/').pop()!;
  const aspectClass = asset.aspect === 'tall'
    ? 'aspect-[9/16]'
    : asset.aspect === 'wide'
    ? 'aspect-[16/9]'
    : 'aspect-square';
  const checker = asset.transparent
    ? 'bg-[length:16px_16px] bg-[linear-gradient(45deg,rgba(255,255,255,0.04)_25%,transparent_25%),linear-gradient(-45deg,rgba(255,255,255,0.04)_25%,transparent_25%),linear-gradient(45deg,transparent_75%,rgba(255,255,255,0.04)_75%),linear-gradient(-45deg,transparent_75%,rgba(255,255,255,0.04)_75%)] bg-[position:0_0,0_8px,8px_-8px,-8px_0px]'
    : '';
  const tileBg = asset.lightBg ? 'bg-white' : 'bg-surface';
  return (
    <a
      href={href}
      download={downloadName}
      className="block rounded-card overflow-hidden border border-white/5 hover:border-brand/50 bg-surface-raised transition-colors group"
    >
      <div className={`${aspectClass} ${checker} flex items-center justify-center overflow-hidden ${tileBg}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={href}
          alt={`${asset.label}${asset.sub ? ' — ' + asset.sub : ''}`}
          loading="lazy"
          className="max-w-full max-h-full object-contain"
        />
      </div>
      <div className="p-3 flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold text-white truncate group-hover:text-brand transition-colors">{asset.label}</div>
          {asset.sub && <div className="text-[10px] text-gray-500 truncate">{asset.sub}</div>}
        </div>
        <svg className="w-4 h-4 text-gray-500 group-hover:text-brand transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m-4-4l4 4 4-4" />
        </svg>
      </div>
    </a>
  );
}

function tierForScore(score: number): { key: string; label: string; desc: string; tint: string; crown: boolean; badgeStyle: React.CSSProperties; textColor: string } {
  if (score >= 83) return {
    key: 'critical-gold', label: 'Critical Gold', desc: 'Drop-everything great', tint: '#DAA520', crown: true,
    textColor: '#1a1a1a',
    badgeStyle: {
      background: 'linear-gradient(135deg,#DAA520 0%,#FFD700 30%,#FFF0A0 50%,#FFD700 70%,#DAA520 100%)',
      boxShadow: '0 0 24px rgba(218,165,32,0.55),0 0 12px rgba(255,215,0,0.4),0 4px 12px rgba(0,0,0,0.3),inset 0 2px 0 rgba(255,255,255,0.3)',
      border: '2px solid #C8960E',
    },
  };
  if (score >= 75) return {
    key: 'recommended', label: 'Recommended', desc: 'Strong choice', tint: '#22c55e', crown: false,
    textColor: '#ffffff',
    badgeStyle: { backgroundColor: '#22c55e', boxShadow: '0 2px 8px rgba(34,197,94,0.3)' },
  };
  if (score >= 65) return {
    key: 'worth-seeing', label: 'Worth Seeing', desc: 'Good, with caveats', tint: '#14b8a6', crown: false,
    textColor: '#ffffff',
    badgeStyle: { backgroundColor: '#14b8a6', boxShadow: '0 2px 8px rgba(20,184,166,0.3)' },
  };
  if (score >= 55) return {
    key: 'skippable', label: 'Skippable', desc: 'Fine to miss', tint: '#d97706', crown: false,
    textColor: '#1a1a1a',
    badgeStyle: { backgroundColor: '#d97706', boxShadow: '0 2px 8px rgba(217,119,6,0.3)' },
  };
  return {
    key: 'stay-away', label: 'Stay Away', desc: 'Save your time', tint: '#ef4444', crown: false,
    textColor: '#ffffff',
    badgeStyle: { backgroundColor: '#ef4444', boxShadow: '0 2px 8px rgba(239,68,68,0.3)' },
  };
}

function rangeForScore(score: number): string {
  if (score >= 83) return '83\u2013100';
  if (score >= 75) return '75\u201382';
  if (score >= 65) return '65\u201374';
  if (score >= 55) return '55\u201364';
  return '< 55';
}

const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif";

function roundedRectPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawBadgeCanvas(opts: {
  score: number;
  transparent: boolean;
  showLabel: boolean;
  pixelRatio?: number;
}): HTMLCanvasElement {
  const { score, transparent, showLabel } = opts;
  const dpr = opts.pixelRatio ?? 2;
  const tier = tierForScore(score);
  const range = rangeForScore(score);

  const padX = 48;
  const padTop = 40;
  const padBottom = 32;
  const badgeSize = 220;
  const labelGap = 20;
  const descGap = 4;
  const rangeGap = 2;
  const labelHeight = 18;
  const descHeight = 14;
  const rangeHeight = 12;

  const cssWidth = badgeSize + padX * 2;
  const labelBlock = showLabel ? labelGap + labelHeight + descGap + descHeight + rangeGap + rangeHeight : 0;
  const cssHeight = padTop + badgeSize + labelBlock + padBottom;

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  ctx.scale(dpr, dpr);

  if (!transparent) {
    ctx.fillStyle = '#0f0f14';
    ctx.fillRect(0, 0, cssWidth, cssHeight);
  }

  const badgeX = (cssWidth - badgeSize) / 2;
  const badgeY = padTop;
  const radius = 36;

  ctx.save();
  ctx.shadowColor = tier.key === 'critical-gold'
    ? 'rgba(218,165,32,0.55)'
    : tier.key === 'recommended' ? 'rgba(34,197,94,0.35)'
    : tier.key === 'worth-seeing' ? 'rgba(20,184,166,0.35)'
    : tier.key === 'skippable' ? 'rgba(217,119,6,0.35)'
    : 'rgba(239,68,68,0.35)';
  ctx.shadowBlur = tier.key === 'critical-gold' ? 24 : 10;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = tier.key === 'critical-gold' ? 4 : 2;

  roundedRectPath(ctx, badgeX, badgeY, badgeSize, badgeSize, radius);

  if (tier.key === 'critical-gold') {
    const grad = ctx.createLinearGradient(badgeX, badgeY, badgeX + badgeSize, badgeY + badgeSize);
    grad.addColorStop(0, '#DAA520');
    grad.addColorStop(0.3, '#FFD700');
    grad.addColorStop(0.5, '#FFF0A0');
    grad.addColorStop(0.7, '#FFD700');
    grad.addColorStop(1, '#DAA520');
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = tier.tint;
  }
  ctx.fill();
  ctx.restore();

  if (tier.key === 'critical-gold') {
    ctx.save();
    roundedRectPath(ctx, badgeX, badgeY, badgeSize, badgeSize, radius);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#C8960E';
    ctx.stroke();
    ctx.restore();
  }

  ctx.save();
  ctx.fillStyle = tier.textColor;
  ctx.font = `700 96px ${SYSTEM_FONT}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(score), badgeX + badgeSize / 2, badgeY + badgeSize / 2 + 4);
  ctx.restore();

  if (tier.crown) {
    ctx.save();
    const crownW = 38;
    const crownH = 18;
    const crownX = badgeX + badgeSize / 2 - crownW / 2;
    const crownY = badgeY - 16;
    const scale = crownW / 24;
    ctx.translate(crownX, crownY);
    ctx.scale(scale, scale);
    ctx.fillStyle = 'rgba(255,215,0,0.9)';
    ctx.beginPath();
    ctx.moveTo(2, 13);
    ctx.lineTo(5, 5);
    ctx.lineTo(9, 8);
    ctx.lineTo(12, 1);
    ctx.lineTo(15, 8);
    ctx.lineTo(19, 5);
    ctx.lineTo(22, 13);
    ctx.closePath();
    ctx.fill();
    // suppress unused
    void crownH;
    ctx.restore();
  }

  if (showLabel) {
    const labelY = badgeY + badgeSize + labelGap + labelHeight / 2;
    const descY = labelY + labelHeight / 2 + descGap + descHeight / 2;
    const rangeY = descY + descHeight / 2 + rangeGap + rangeHeight / 2;

    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    ctx.fillStyle = tier.tint;
    ctx.font = `700 18px ${SYSTEM_FONT}`;
    const label = tier.label.toUpperCase();
    const letterSpacing = 1.5;
    const chars = label.split('');
    let totalW = 0;
    chars.forEach((ch, i) => {
      totalW += ctx.measureText(ch).width;
      if (i < chars.length - 1) totalW += letterSpacing;
    });
    let cx = cssWidth / 2 - totalW / 2;
    chars.forEach((ch, i) => {
      const w = ctx.measureText(ch).width;
      ctx.fillText(ch, cx + w / 2, labelY);
      cx += w + (i < chars.length - 1 ? letterSpacing : 0);
    });

    ctx.fillStyle = '#9ca3af';
    ctx.font = `400 14px ${SYSTEM_FONT}`;
    ctx.fillText(tier.desc, cssWidth / 2, descY);

    ctx.fillStyle = '#6b7280';
    ctx.font = `400 12px ${SYSTEM_FONT}`;
    ctx.fillText(range, cssWidth / 2, rangeY);

    ctx.restore();
  }

  return canvas;
}

function BadgeBuilder() {
  const [score, setScore] = useState(85);
  const [transparent, setTransparent] = useState(false);
  const [showLabel, setShowLabel] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const tier = tierForScore(clamped);
  const range = rangeForScore(clamped);

  const download = async () => {
    setBusy(true);
    setErr(null);
    try {
      const canvas = drawBadgeCanvas({ score: clamped, transparent, showLabel, pixelRatio: 2 });
      const dataUrl = canvas.toDataURL('image/png');
      const link = document.createElement('a');
      const variant = transparent ? 'transparent' : 'dark';
      link.download = `bwsc-score-${clamped}-${variant}.png`;
      link.href = dataUrl;
      link.click();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Download failed');
    } finally {
      setBusy(false);
    }
  };

  const checkerStyle: React.CSSProperties = transparent
    ? {
        backgroundImage:
          'linear-gradient(45deg,rgba(255,255,255,0.06) 25%,transparent 25%),' +
          'linear-gradient(-45deg,rgba(255,255,255,0.06) 25%,transparent 25%),' +
          'linear-gradient(45deg,transparent 75%,rgba(255,255,255,0.06) 75%),' +
          'linear-gradient(-45deg,transparent 75%,rgba(255,255,255,0.06) 75%)',
        backgroundSize: '16px 16px',
        backgroundPosition: '0 0, 0 8px, 8px -8px, -8px 0px',
      }
    : {};

  return (
    <div className="grid grid-cols-1 md:grid-cols-[320px_1fr] gap-4">
      {/* Controls */}
      <div className="rounded-card bg-surface-raised border border-white/5 p-5 space-y-5 self-start">
        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-gray-400 block mb-2">Score</label>
          <div className="flex items-center gap-3">
            <input
              type="number"
              min={0}
              max={100}
              value={score}
              onChange={e => setScore(Number(e.target.value || 0))}
              className="w-20 px-3 py-2 rounded-lg bg-surface border border-white/10 text-white text-lg font-bold text-center focus:outline-none focus:border-brand/60"
            />
            <input
              type="range"
              min={0}
              max={100}
              value={clamped}
              onChange={e => setScore(Number(e.target.value))}
              className="flex-1"
              aria-label="Score slider"
            />
          </div>
          <div className="text-[11px] text-gray-500 mt-2">Tier: <span style={{ color: tier.tint }} className="font-semibold">{tier.label}</span> · Range {range}</div>
        </div>

        <div>
          <label className="text-xs font-semibold uppercase tracking-wide text-gray-400 block mb-2">Background</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setTransparent(false)}
              className={`py-2 px-3 rounded-lg text-xs font-semibold transition-colors ${!transparent ? 'bg-brand text-white' : 'bg-surface border border-white/10 text-gray-300 hover:border-white/20'}`}
            >
              Dark
            </button>
            <button
              type="button"
              onClick={() => setTransparent(true)}
              className={`py-2 px-3 rounded-lg text-xs font-semibold transition-colors ${transparent ? 'bg-brand text-white' : 'bg-surface border border-white/10 text-gray-300 hover:border-white/20'}`}
            >
              Transparent
            </button>
          </div>
        </div>

        <div>
          <label className="flex items-center gap-2 text-xs text-gray-300 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={showLabel}
              onChange={e => setShowLabel(e.target.checked)}
              className="accent-brand"
            />
            <span>Include tier label (Critical Gold, Recommended, &hellip;)</span>
          </label>
        </div>

        <button
          type="button"
          onClick={download}
          disabled={busy}
          className="w-full py-3 px-4 rounded-lg bg-brand hover:bg-brand-hover text-white font-bold text-sm transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
        >
          {busy ? 'Rendering\u2026' : 'Download PNG'}
        </button>
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="text-[11px] text-gray-500 leading-relaxed">
          Rendered client-side at 2&times; pixel ratio. Matches the kit badges above but may differ very slightly in font anti-aliasing.
        </div>
      </div>

      {/* Preview */}
      <div
        className="rounded-card border border-white/5 overflow-hidden min-h-[280px] flex items-center justify-center p-4"
        style={{ background: transparent ? undefined : '#0f0f14', ...checkerStyle }}
      >
        <div ref={previewRef} style={{ padding: '40px 48px 32px', display: 'inline-block', background: transparent ? 'transparent' : '#0f0f14' }}>
          <div style={{ position: 'relative', display: 'flex', justifyContent: 'center' }}>
            {tier.crown && (
              <svg viewBox="0 0 24 14" style={{ position: 'absolute', left: '50%', transform: 'translateX(-50%)', top: '-16px', width: 38, height: 18, zIndex: 2 }}>
                <path d="M2,13 L5,5 L9,8 L12,1 L15,8 L19,5 L22,13 Z" fill="#FFD700" opacity="0.9" />
              </svg>
            )}
            <div
              style={{
                width: 220,
                height: 220,
                borderRadius: 36,
                fontSize: 96,
                fontWeight: 700,
                color: tier.textColor,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif",
                ...tier.badgeStyle,
              }}
            >
              {clamped}
            </div>
          </div>
          {showLabel && (
            <>
              <div style={{ marginTop: 20, textAlign: 'center', fontWeight: 700, fontSize: 18, letterSpacing: 1.5, textTransform: 'uppercase', color: tier.tint, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif" }}>
                {tier.label}
              </div>
              <div style={{ textAlign: 'center', fontSize: 14, color: '#9ca3af', marginTop: 4, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif" }}>
                {tier.desc}
              </div>
              <div style={{ textAlign: 'center', fontSize: 12, color: '#6b7280', marginTop: 2, fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, sans-serif" }}>
                {range}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
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
