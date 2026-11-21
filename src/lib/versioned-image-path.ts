// Server data helper. Next config builds this manifest using the same content
// hashes as scripts/lib/versioned-image-path.js. Only URLs reach client props;
// the image files stay in public/ instead of bloating serverless bundles.
import fs from 'fs';
import path from 'path';

let versions: Record<string, string> = {};
try {
  versions = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'data', 'site-image-versions.json'), 'utf8'));
} catch {
  // Standalone data tools and tests can run before Next prepares its build.
}

export function versionedImagePath<T extends string | null | undefined>(imagePath: T): T {
  return (typeof imagePath === 'string' && Object.prototype.hasOwnProperty.call(versions, imagePath)
    ? versions[imagePath] : imagePath) as T;
}

/** True when the file existed under public/images when the manifest was built. Lets server code check for a file without an fs path that makes Next trace public/ into serverless bundles. */
export function siteImageExists(imagePath: string): boolean {
  return Object.prototype.hasOwnProperty.call(versions, imagePath);
}
