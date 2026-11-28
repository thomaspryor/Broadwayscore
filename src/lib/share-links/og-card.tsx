import { ImageResponse } from 'next/og';
import { fetchImageDataUri } from '@/lib/og-image';
import { interFontOption } from '@/lib/og-fonts';

/**
 * The link-preview card every private share link uses (plans, diary): a
 * title, one summary line, up to four posters. Callers pass only what the
 * card prints, so nothing private reaches it by accident (the diary passes
 * no note text). Built from the token on the server; nothing on it comes
 * from URL parameters.
 */
export const SHARE_OG_SIZE = { width: 1200, height: 630 };
const POSTER_W = 210;
const POSTER_H = 315;

export interface ShareCardInput {
  title: string;
  summary: string;
  /** Poster paths in display order; the first four with an image are shown. */
  posterUrls: readonly (string | null)[];
}

export async function renderShareCard({ title, summary, posterUrls }: ShareCardInput): Promise<ImageResponse> {
  const posterPaths = posterUrls.filter((p): p is string => !!p).slice(0, 4);
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
              {title}
            </div>
            <div style={{ fontSize: 34, color: '#d4a574', marginTop: 16 }}>{summary}</div>
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
    { ...SHARE_OG_SIZE, ...fontOption },
  );
}

/** The card for an unknown, stopped or reset link: the site name, nothing else. */
export async function renderGenericShareCard(): Promise<ImageResponse> {
  return new ImageResponse(
    (
      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f0f14', color: '#ffffff', fontSize: 72, fontWeight: 800, letterSpacing: '-0.03em', fontFamily: 'Inter' }}>
        Broadway Scorecard
      </div>
    ),
    { ...SHARE_OG_SIZE, ...(await interFontOption([800])) },
  );
}
