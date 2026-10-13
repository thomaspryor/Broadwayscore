// True when the module whose import.meta.url is passed was run directly
// (`node path/to/it.mjs`), false when imported. Node gives import.meta.url as
// the REAL path, so the bare `import.meta.url === \`file://${process.argv[1]}\``
// idiom is false whenever argv[1] goes through a symlink or contains a space
// or `%` (file URLs percent-encode): the CLI silently never runs. Hooks that
// shell out to such a CLI then read empty output and fail OPEN (found by
// BRO-2312's hermetic visual-gate fixture). Same check as review-gate.mjs.
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function isMainModule(importMetaUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try {
    return importMetaUrl === pathToFileURL(realpathSync(argv1)).href
        || importMetaUrl === pathToFileURL(argv1).href;
  } catch {
    return false;
  }
}
