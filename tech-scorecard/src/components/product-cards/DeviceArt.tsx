import type { Product } from '@/lib/data-types';

/**
 * Drawn product art standing in for press photos in the POC.
 * Broadway Scorecard uses posters here; the tile keeps the same 3:4 frame.
 */
export function DeviceArt({ art, name, className = '' }: { art: Product['art']; name: string; className?: string }) {
  return (
    <svg viewBox="0 0 300 400" className={className} role="img" aria-label={`Illustration of ${name}`} preserveAspectRatio="xMidYMid slice">
      {/* Plain fills only: SVG gradient ids collide when the same art renders twice on a page. */}
      <rect width="300" height="400" fill={art.backdrop[0]} />
      <path d="M0 400 L300 120 L300 400 Z" fill={art.backdrop[1]} />
      <ellipse cx="150" cy="352" rx="110" ry="10" fill="#000" opacity="0.10" />
      {art.kind === 'foldable' ? (
        <g>
          <rect x="52" y="92" width="172" height="232" rx="16" fill={art.body} />
          <rect x="58" y="98" width="160" height="220" rx="11" fill="#14141c" />
          <path d="M58 109 a11 11 0 0 1 11 -11 H218 V230 L58 318 Z" fill={art.accent} opacity="0.85" />
          <line x1="138" y1="98" x2="138" y2="318" stroke="#fff" strokeOpacity="0.18" strokeWidth="1.5" />
          <circle cx="198" cy="112" r="3.5" fill="#0b0b10" />
          <rect x="196" y="70" width="64" height="236" rx="14" fill={art.body} stroke="#000" strokeOpacity="0.08" />
          <rect x="222" y="70" width="14" height="236" fill="#fff" opacity="0.18" />
          <rect x="203" y="78" width="50" height="78" rx="12" fill="#1c1c22" />
          <circle cx="218" cy="98" r="10" fill="#0b0b10" stroke="#3a3a44" strokeWidth="2.5" />
          <circle cx="218" cy="132" r="10" fill="#0b0b10" stroke="#3a3a44" strokeWidth="2.5" />
          <circle cx="241" cy="115" r="4" fill="#3a3a44" />
        </g>
      ) : (
        <g>
          <rect x="48" y="78" width="126" height="258" rx="24" fill="#1b1b20" />
          <rect x="54" y="84" width="114" height="246" rx="19" fill="#14141c" />
          <path d="M54 103 a19 19 0 0 1 19 -19 H168 V200 L54 300 Z" fill={art.accent} opacity="0.85" />
          <rect x="94" y="94" width="34" height="10" rx="5" fill="#0b0b10" />
          <rect x="134" y="58" width="126" height="258" rx="24" fill={art.body} stroke="#000" strokeOpacity="0.08" />
          <rect x="190" y="58" width="22" height="258" fill="#fff" opacity="0.14" />
          <rect x="138" y="64" width="118" height="70" rx="20" fill={art.body} stroke="#000" strokeOpacity="0.12" />
          <circle cx="164" cy="88" r="14" fill="#0b0b10" stroke="#3a3a44" strokeWidth="3" />
          <circle cx="164" cy="116" r="11" fill="#0b0b10" stroke="#3a3a44" strokeWidth="3" />
          <circle cx="194" cy="102" r="14" fill="#0b0b10" stroke="#3a3a44" strokeWidth="3" />
          <circle cx="232" cy="90" r="4" fill="#f1e4b0" opacity="0.8" />
        </g>
      )}
    </svg>
  );
}
