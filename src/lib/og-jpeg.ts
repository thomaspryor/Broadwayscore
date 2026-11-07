import sharp from 'sharp';

const BACKGROUND = '#0f0f14';
const JPEG_QUALITY = 78;
const LONG_CACHE = 'public, immutable, no-transform, max-age=31536000';
const FALLBACK_CACHE = 'public, max-age=300, s-maxage=300';

// next/og only emits PNG, which encodes a full-bleed photo at ~1.2 MB.
// WhatsApp drops link previews whose og:image is over ~300 KB, so the show OG
// route re-encodes to a progressive JPEG (~70-80 KB). If sharp fails (native
// load, OOM) fall back to the original PNG so a 500 never replaces the image.
// `cacheControl` overrides the year-long cache for live cards (Shared Plans
// re-renders when the owner's plans change).
export async function pngToOgJpegResponse(png: Response, cacheControl = LONG_CACHE): Promise<Response> {
  const input = Buffer.from(await png.arrayBuffer());
  try {
    const jpeg = await sharp(input)
      .flatten({ background: BACKGROUND })
      .jpeg({ quality: JPEG_QUALITY, progressive: true, mozjpeg: true })
      .toBuffer();
    return new Response(jpeg, { headers: ogHeaders('image/jpeg', cacheControl) });
  } catch (err) {
    console.error('[og] JPEG re-encode failed, serving PNG:', err instanceof Error ? err.message : err);
    // Short cache: a transient sharp failure must not pin the big PNG for a year.
    return new Response(input, { headers: ogHeaders('image/png', FALLBACK_CACHE) });
  }
}

function ogHeaders(contentType: string, cacheControl: string): Record<string, string> {
  return { 'Content-Type': contentType, 'Cache-Control': cacheControl };
}
