/**
 * Studio layout — overrides the root layout so Sanity gets a clean <html>/<body>.
 * The embedded Studio renders its own chrome; the site header/footer would conflict.
 */
export { metadata, viewport } from 'next-sanity/studio';

export default function StudioLayout({ children }: { children: React.ReactNode }) {
  return children;
}
