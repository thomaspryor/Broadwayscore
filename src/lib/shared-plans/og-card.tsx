import { ImageResponse } from 'next/og';
import { fetchImageDataUri } from '@/lib/og-image';
import { interFontOption } from '@/lib/og-fonts';
import { plansSummary, plansTitle, type SharedPlansView } from './view-model';

/**
 * The Shared Plans link-preview card (BRO-4481): name, counts, up to four
 * posters. Used by src/app/plans/[token]/opengraph-image.tsx; kept separate
 * so it can be rendered and checked without a live share.
 */
export const PLANS_OG_SIZE = { width: 1200, height: 630 };
const POSTER_W = 210;
const POSTER_H = 315;

export async function renderPlansCard(view: SharedPlansView): Promise<ImageResponse> {
  const posterPaths = [...view.booked, ...view.unbooked]
    .map(s => s.posterUrl)
    .filter((p): p is string => !!p)
    .slice(0, 4);
  const [posters, fontOption] = await Promise.all([
    Promise.all(posterPaths.map(p => fetchImageDataUri(p, 384))).then(list => list.filter((p): p is string => !!p)),
    interFontOption([400, 700, 800]),
  ]);

  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', background: '#0f0f14', padding: '64px 72px', fontFamily: 'Inter' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 760 }}>
            <div style={{ fontSize: 68, fontWeight: 800, color: '#ffffff', letterSpacing: '-0.03em', lineHeight: 1.05 }}>
              {plansTitle(view.name)}
            </div>
            <div style={{ fontSize: 34, color: '#d4a574', marginTop: 16 }}>{plansSummary(view.counts)}</div>
          </div>
          <div style={{ display: 'flex', fontSize: 28, fontWeight: 700, color: '#ffffff', marginTop: 12 }}>
            Broadway<span style={{ color: '#d4a574' }}>Scorecard</span>
          </div>
        </div>
        <div style={{ display: 'flex' }}>
          {posters.map((src, i) => (
            // eslint-disable-next-line @next/next/no-img-element, jsx-a11y/alt-text
            <img key={i} src={src} width={POSTER_W} height={POSTER_H}
              style={{ width: POSTER_W, height: POSTER_H, objectFit: 'cover', borderRadius: 16, marginRight: 20 }} />
          ))}
        </div>
      </div>
    ),
    { ...PLANS_OG_SIZE, ...fontOption },
  );
}
