import { MARQUEE_COLORS, MARQUEE_STACKED, MARQUEE_WIDE, marqueeBulbs } from './marquee-art';

// Bulbs chase in three groups; nothing moves for people who ask for less motion.
const CHASE_CSS =
  '@media (prefers-reduced-motion: no-preference){.bfl-chase .bfl-b{animation:bfl-chase 1.8s steps(1,end) infinite}' +
  '.bfl-chase .bfl-b1{animation-delay:-.6s}.bfl-chase .bfl-b2{animation-delay:-1.2s}}' +
  '@keyframes bfl-chase{0%{opacity:1}33%{opacity:.3}66%{opacity:1}}';

interface FantasyMarqueeProps {
  variant?: 'wide' | 'stacked';
  /** Chasing bulbs (CSS only, respects prefers-reduced-motion). Never in image routes: satori would draw the <style> text. */
  animated?: boolean;
  className?: string;
  /** Pixel size for renderers that need it (the share-image route); CSS sizes it on the site. */
  width?: number;
  height?: number;
  /** When the name is already in nearby text (e.g. an sr-only heading), hide the SVG from screen readers. */
  decorative?: boolean;
}

/**
 * The Broadway Fantasy League mark (BRO-5519): the full name lit on a marquee
 * sign. Pure SVG, no web font and no client JS, so it renders the same on the
 * site and inside @vercel/og.
 */
export default function FantasyMarquee({ variant = 'wide', animated = false, className, width, height, decorative = false }: FantasyMarqueeProps) {
  const art = variant === 'stacked' ? MARQUEE_STACKED : MARQUEE_WIDE;
  const inner = art.width - art.inset * 2;
  const innerH = art.height - art.inset * 2;
  return (
    <svg
      viewBox={`0 0 ${art.width} ${art.height}`}
      width={width}
      height={height}
      {...(decorative ? { 'aria-hidden': true } : { role: 'img', 'aria-label': 'Broadway Fantasy League' })}
      className={[animated ? 'bfl-chase' : '', className ?? ''].join(' ').trim() || undefined}
    >
      {animated && <style>{CHASE_CSS}</style>}
      <rect x={art.inset} y={art.inset} width={inner} height={innerH} rx={art.radius} fill={MARQUEE_COLORS.sign} stroke={MARQUEE_COLORS.frame} strokeWidth={3} />
      {marqueeBulbs(art).map(([cx, cy], i) => (
        <circle key={i} cx={cx} cy={cy} r={art.bulbR} fill={MARQUEE_COLORS.lit} {...(animated ? { className: `bfl-b bfl-b${i % 3}` } : {})} />
      ))}
      <path d={art.broadway} fill={MARQUEE_COLORS.broadway} />
      {art.lines.map((d, i) => (
        <path key={i} d={d} fill={MARQUEE_COLORS.lit} />
      ))}
    </svg>
  );
}
