import { ImageResponse } from 'next/og';
import { NextRequest } from 'next/server';
import { interFontOption } from '@/lib/og-fonts';
import seasonConfig from '@/config/fantasy-season.json';
import FantasyMarquee from '@/components/fantasy/FantasyMarquee';
import fantasyLeague from '../../../../../data/fantasy-league.json';

export const runtime = 'edge';

/**
 * GET /api/fantasy/share-image?picks=id,id,...&team=Name — a square roster
 * graphic to post after drafting (BRO-4338, owner decision 2026-10-11).
 *
 * Built only from show ids in this season's fantasy config (unknown ids are
 * dropped) plus a length-capped team name, so it can't be turned into an
 * arbitrary-text image. Imports JSON directly rather than @/config/fantasy,
 * whose scoring import is not edge-safe.
 */
const SIZE = 1080;
const WEIGHTS = [400, 600, 700, 800] as const;
const shows = (fantasyLeague as unknown as { shows: Record<string, { title: string; price: number }> }).shows;

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const ids = Array.from(new Set((params.get('picks') || '').split(',').map((s) => s.trim())))
    .filter((id) => id && Object.prototype.hasOwnProperty.call(shows, id))
    .slice(0, seasonConfig.teamSize);
  if (ids.length === 0) return new Response('No valid picks', { status: 400 });

  const rawTeam = (params.get('team') || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(rawTeam); // code points, so an emoji is never split
  const team = chars.length > 40 ? `${chars.slice(0, 39).join('').trimEnd()}…` : rawTeam;
  const picks = ids.map((id) => shows[id]);
  const total = picks.reduce((s, p) => s + p.price, 0);
  // A full 8-show roster needs tighter rows to clear the footer.
  const dense = picks.length > 6;

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', backgroundColor: '#0a0a0f', color: '#ffffff', padding: '80px', fontFamily: 'Inter', position: 'relative' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, background: 'radial-gradient(ellipse at top right, rgba(212,165,116,0.18), transparent 55%)' }} />
        {/* The marquee is the name (BRO-5519); pure SVG, so satori draws it without a font. */}
        <FantasyMarquee width={dense ? 340 : 420} height={dense ? 90 : 112} decorative />
        <div style={{ display: 'flex', fontSize: 26, fontWeight: 600, color: '#d4a574', letterSpacing: '0.06em', textTransform: 'uppercase', marginTop: 28 }}>
          {`My ${seasonConfig.season.slice(0, 4)}-${seasonConfig.season.slice(-2)} season`}
        </div>
        <div style={{ display: 'flex', fontSize: team.length > 32 ? 52 : team.length > 24 ? 64 : 80, fontWeight: 800, marginTop: 12, lineHeight: 1.05 }}>
          {team || 'My team'}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: dense ? 40 : 56, gap: dense ? 14 : 22 }}>
          {picks.map((p, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: dense ? 34 : 40, borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: dense ? 12 : 18 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 24, maxWidth: 760 }}>
                <span style={{ color: '#6b7280', fontWeight: 700, width: 40 }}>{i + 1}</span>
                <span style={{ fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 700 }}>{p.title}</span>
              </div>
              <span style={{ color: '#34d399', fontWeight: 700 }}>{`$${p.price}`}</span>
            </div>
          ))}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', marginTop: 'auto', paddingTop: 20, fontSize: 30, color: '#9ca3af' }}>
          <span>{`$${total} of $${seasonConfig.budget} spent`}</span>
          <span style={{ color: '#ffffff', fontWeight: 700 }}>broadwayscorecard.com/fantasy</span>
        </div>
      </div>
    ),
    { width: SIZE, height: SIZE, ...(await interFontOption(WEIGHTS)), headers: { 'Cache-Control': 'public, max-age=86400, s-maxage=86400' } },
  );
}
