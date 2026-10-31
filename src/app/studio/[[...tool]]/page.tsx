/**
 * Embedded Sanity Studio at /studio.
 * Dynamic — Sanity manages its own auth, so this route must not be statically rendered.
 *
 * The wrapper div overlays the whole viewport so the BWSC site chrome (header/footer
 * from the root layout) doesn't leak into the Studio UI. A proper fix uses Next.js
 * route groups with their own root layout, but that's a bigger refactor for later.
 */
'use client';

import { NextStudio } from 'next-sanity/studio';
import config from '../../../../sanity.config';

export const dynamic = 'force-dynamic';

export default function StudioPage() {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 9999,
        background: '#fff',
      }}
    >
      <NextStudio config={config} />
    </div>
  );
}
